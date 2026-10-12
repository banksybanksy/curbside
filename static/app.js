/* Curbside frontend. All filtering happens client-side; the logic lives in schedule.js. */

const DEFAULT_STATUS = "APPROVED";

const state = {
  trucks: [],
  filtered: [],
  search: "",
  food: "",
  status: DEFAULT_STATUS,
  day: "",
  selectedId: null,
  loading: true,
  loadError: "",
};

// ---------- Map setup ----------
// Leaflet comes from a CDN. Without it the list and table still work.
const map = window.L ? L.map("map", { zoomControl: true }).setView([37.766, -122.43], 13) : null;
const markerLayer = map ? L.layerGroup().addTo(map) : null;
const markersById = new Map();

// Mapbox raster tiles need a public token, which the server reads from MAPBOX_TOKEN.
async function addBasemap() {
  let token = "";
  try {
    token = (await (await fetch("/api/config")).json()).mapboxToken || "";
  } catch {}
  if (!token) {
    const note = L.control({ position: "topright" });
    note.onAdd = () => {
      const el = L.DomUtil.create("div", "map-notice");
      el.textContent = "No basemap: set MAPBOX_TOKEN (see README).";
      return el;
    };
    note.addTo(map);
    return;
  }
  const style = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark-v11" : "light-v11";
  L.tileLayer(
    `https://api.mapbox.com/styles/v1/mapbox/${style}/tiles/512/{z}/{x}/{y}{r}?access_token=${encodeURIComponent(token)}`,
    {
      tileSize: 512,
      zoomOffset: -1,
      maxZoom: 20,
      attribution:
        '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> <a href="https://www.mapbox.com/map-feedback/">Improve this map</a>',
    }
  ).addTo(map);
}

if (map) {
  addBasemap();
} else {
  document.getElementById("map").innerHTML =
    `<p class="map-offline">The map library didn't load, so the map is unavailable. The list and table still work.</p>`;
}

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function statusClass(status) {
  return (status || "unknown").toLowerCase();
}

function statusBadge(t) {
  return `<span class="badge ${statusClass(t.status)}">${esc(statusClass(t.status))}</span>`;
}

// Pick an emoji "avatar" from the permit's food items list. First keyword hit wins.
const EMOJI_RULES = [
  [/taco|burrito|quesadilla|torta|mexican/, "🌮"],
  [/pizza/, "🍕"],
  [/burger/, "🍔"],
  [/hot ?dog|sausage|bratwurst/, "🌭"],
  [/coffee|espresso|latte|cappuccino/, "☕"],
  [/ice ?cream|gelato|shave[dn]? ice|frozen/, "🍦"],
  [/donut|doughnut|churro|pastr|cupcake|cookie|dessert|candy|chocolate/, "🍩"],
  [/noodle|ramen|pho|chinese|chow|dumpling|asian|rice plate|teriyaki|bento/, "🍜"],
  [/sushi|poke/, "🍣"],
  [/kebab|gyro|shawarma|falafel|halal|mediterranean/, "🥙"],
  [/bbq|barbecue|brisket|rib/, "🍖"],
  [/seafood|crab|lobster|shrimp|fish|ceviche/, "🦞"],
  [/chicken|wings/, "🍗"],
  [/sandwich|panini|cheesesteak|sub|banh mi/, "🥪"],
  [/salad|vegan|vegetarian|bowl/, "🥗"],
  [/juice|smoothie|lemonade|boba|tea|agua/, "🥤"],
  [/waffle|crepe|pancake/, "🧇"],
  [/peanut|nut|snack|popcorn|chips|pretzel/, "🥜"],
  [/fruit|mango|coconut/, "🍉"],
];

function foodEmoji(truck) {
  const food = (truck.food || "").toLowerCase();
  for (const [re, emoji] of EMOJI_RULES) if (re.test(food)) return emoji;
  return truck.facilityType === "Push Cart" ? "🛒" : "🚚";
}

// ---------- Filtering ----------
function applyFilters() {
  const clock = sfClock();
  state.filtered = state.trucks.filter((t) => matchesFilters(t, state, clock));
  render(clock);
}

// ---------- Rendering ----------
function popupHtml(t, clock) {
  let sched;
  if (t.schedule.length) {
    const rows = t.schedule
      .map((s) => `<tr><td>${esc(s.day.slice(0, 3))}</td><td>${esc(s.start)} – ${esc(s.end)}</td></tr>`)
      .join("");
    sched = `<table>${rows}</table>`;
  } else {
    sched = `<div class="p-nosched">No published schedule for this location.</div>`;
  }
  const openBadge = isOpenAt(t, clock) ? ` <span class="badge open-now">Open now</span>` : "";
  return `<div class="popup">
    <h3>${foodEmoji(t)} ${esc(t.name)}</h3>
    ${statusBadge(t)}${openBadge}
    ${t.food ? `<div class="p-food">${esc(t.food)}</div>` : ""}
    <div class="p-addr">📍 ${esc(t.address || t.locationDescription || "Address unknown")}</div>
    ${sched}
    <div class="p-permit">${esc(t.facilityType)} · Permit ${esc(t.permit)}${t.expiration ? ` · expires ${esc(t.expiration)}` : ""}</div>
  </div>`;
}

function renderMarkers(clock) {
  if (!map) return;
  markerLayer.clearLayers();
  markersById.clear();
  for (const t of state.filtered) {
    if (t.lat == null || t.lng == null) continue;
    // The pin's point is its bottom-left corner (see .pin-emoji), so anchor there.
    const icon = L.divIcon({
      className: "",
      html: `<div class="pin-emoji ${statusClass(t.status)}">${foodEmoji(t)}</div>`,
      iconSize: [34, 34],
      iconAnchor: [1, 33],
      popupAnchor: [16, -30],
    });
    const m = L.marker([t.lat, t.lng], { icon, title: t.name }).bindPopup(popupHtml(t, clock), { maxWidth: 280 });
    m.on("click", () => {
      state.selectedId = t.id;
      highlightListItem();
    });
    m.addTo(markerLayer);
    markersById.set(t.id, m);
  }
}

function hasActiveFilters() {
  return state.search || state.food || state.day || state.status !== DEFAULT_STATUS;
}

function listNote(emoji, html) {
  return `<li class="empty-note"><span class="big" aria-hidden="true">${emoji}</span>${html}</li>`;
}

function renderList(clock) {
  const ul = $("#results");
  if (state.loading) {
    ul.innerHTML = listNote("⏳", "Loading permits…<br>The first load pulls from DataSF and can take a few seconds.");
    return;
  }
  if (state.loadError) {
    ul.innerHTML = listNote("🔌", `${esc(state.loadError)}<br>Try <strong>Refresh data</strong> once you're back online.`);
    return;
  }
  if (!state.filtered.length) {
    ul.innerHTML = hasActiveFilters()
      ? listNote("🫗", "No vendors match these filters.<br>Try another day, or set status to Any status.")
      : listNote("🫗", "The dataset came back empty.");
    return;
  }
  ul.innerHTML = state.filtered
    .map((t) => {
      const badge = isOpenAt(t, clock) ? `<span class="badge open-now">Open</span>` : statusBadge(t);
      const noMap = t.lat == null ? ` <span class="r-nomap">⚠ not on map</span>` : "";
      return `<li><button type="button" class="result-item${t.id === state.selectedId ? " selected" : ""}" data-id="${esc(t.id)}">
        <span class="r-emoji" aria-hidden="true">${foodEmoji(t)}</span>
        <span class="r-body">
          <span class="r-name"><span>${esc(t.name)}</span>${badge}</span>
          ${t.food ? `<span class="r-food">${esc(t.food)}</span>` : ""}
          <span class="r-addr">${esc(t.address || t.locationDescription || "")}${noMap}</span>
        </span>
      </button></li>`;
    })
    .join("");
}

function renderTable() {
  $("#table-body").innerHTML = state.filtered
    .map(
      (t) => `<tr data-id="${esc(t.id)}" tabindex="0">
        <td>${foodEmoji(t)} <strong>${esc(t.name)}</strong></td>
        <td>${esc(t.food)}</td>
        <td>${esc(t.address || t.locationDescription || "")}</td>
        <td>${statusBadge(t)}</td>
        <td>${esc(scheduleDays(t) || "—")}</td>
      </tr>`
    )
    .join("");
}

function highlightListItem() {
  document.querySelectorAll(".result-item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === state.selectedId);
  });
  const el = document.querySelector(`.result-item[data-id="${CSS.escape(state.selectedId ?? "")}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

function render(clock) {
  if (state.loading || state.loadError) {
    $("#result-count").textContent = "";
  } else {
    const offMap = state.filtered.filter((t) => t.lat == null).length;
    $("#result-count").textContent =
      plural(state.filtered.length, "vendor") + (offMap ? ` · ${offMap} not on map` : "");
  }
  renderMarkers(clock);
  renderList(clock);
  renderTable();
}

// ---------- Interactions ----------
function focusTruck(id) {
  state.selectedId = id;
  highlightListItem();
  const m = markersById.get(id);
  if (m) {
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
    m.openPopup();
  }
}

$("#results").addEventListener("click", (e) => {
  const item = e.target.closest(".result-item");
  if (item) focusTruck(item.dataset.id);
});

function openRow(row) {
  setView("map");
  focusTruck(row.dataset.id);
}

$("#table-body").addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (row) openRow(row);
});

$("#table-body").addEventListener("keydown", (e) => {
  const row = e.target.closest("tr");
  if (row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openRow(row);
  }
});

$("#search").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
  applyFilters();
});

$("#food-search").addEventListener("input", (e) => {
  state.food = e.target.value.trim();
  syncChips();
  applyFilters();
});

$("#status-filter").addEventListener("change", (e) => {
  state.status = e.target.value;
  applyFilters();
});

$("#day-filter").addEventListener("change", (e) => {
  state.day = e.target.value;
  applyFilters();
});

function syncChips() {
  document.querySelectorAll(".chip").forEach((c) => {
    const active = c.dataset.food === state.food.toLowerCase();
    c.classList.toggle("active", active);
    c.setAttribute("aria-pressed", active);
  });
}

$("#chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.food = state.food === chip.dataset.food ? "" : chip.dataset.food;
  $("#food-search").value = state.food;
  syncChips();
  applyFilters();
});

$("#clear-filters").addEventListener("click", () => {
  state.search = state.food = state.day = "";
  state.status = DEFAULT_STATUS;
  $("#search").value = $("#food-search").value = "";
  $("#status-filter").value = DEFAULT_STATUS;
  $("#day-filter").value = "";
  syncChips();
  applyFilters();
});

function setView(view) {
  const isMap = view === "map";
  $("#view-map").classList.toggle("active", isMap);
  $("#view-map").setAttribute("aria-pressed", isMap);
  $("#view-table").classList.toggle("active", !isMap);
  $("#view-table").setAttribute("aria-pressed", !isMap);
  $("#table-view").hidden = isMap;
  if (!map) return;
  if (isMap) map.invalidateSize();
  else map.closePopup();
}
$("#view-map").addEventListener("click", () => setView("map"));
$("#view-table").addEventListener("click", () => setView("table"));

// ---------- Data loading ----------
function setFreshness(iso) {
  const d = new Date(iso);
  $("#data-freshness").textContent = `Data from ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function loadTrucks() {
  state.loading = true;
  state.loadError = "";
  $("#data-freshness").textContent = "Loading…";
  render(sfClock());
  try {
    const res = await fetch("/api/trucks");
    const data = await readJson(res);
    if (!res.ok || !Array.isArray(data.trucks)) {
      state.loadError = data.error || `The server returned an error (${res.status}).`;
      $("#data-freshness").textContent = "No data loaded";
    } else {
      state.trucks = data.trucks;
      setFreshness(data.fetched_at);
    }
  } catch {
    state.loadError = "Could not reach the local server. Is app.py running?";
    $("#data-freshness").textContent = "No data loaded";
  }
  state.loading = false;
  applyFilters();
}

$("#refresh-btn").addEventListener("click", async () => {
  const btn = $("#refresh-btn");
  const label = btn.querySelector(".refresh-label");
  btn.disabled = true;
  btn.classList.add("loading");
  label.textContent = "Refreshing…";
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const data = await readJson(res);
    if (res.ok) {
      await loadTrucks();
    } else {
      $("#data-freshness").textContent = data.error || "Refresh failed";
    }
  } catch {
    $("#data-freshness").textContent = "Refresh failed. Is app.py running?";
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    label.textContent = "Refresh data";
  }
});

loadTrucks();
