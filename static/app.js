/* SF Food Truck Finder — frontend logic. All filtering happens client-side. */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const state = {
  trucks: [],
  filtered: [],
  search: "",
  food: "",
  status: "APPROVED",
  day: "",
  selectedId: null,
};

// ---------- Map setup ----------
const map = L.map("map", { zoomControl: true }).setView([37.766, -122.43], 13);
const darkMap = window.matchMedia("(prefers-color-scheme: dark)").matches;
L.tileLayer(
  `https://{s}.basemaps.cartocdn.com/${darkMap ? "dark_all" : "rastertiles/voyager"}/{z}/{x}/{y}{r}.png`,
  {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }
).addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const markersById = new Map();

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toMinutes(hhmm) {
  const [h, m] = (hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Is the truck open right now? Handles shifts that cross midnight by also
// checking yesterday's entries.
function isOpenNow(truck) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const today = DAYS[now.getDay()];
  const yesterday = DAYS[(now.getDay() + 6) % 7];
  return truck.schedule.some((s) => {
    const start = toMinutes(s.start24);
    const end = toMinutes(s.end24);
    const overnight = end <= start;
    if (s.day === today) return overnight ? cur >= start : cur >= start && cur < end;
    if (s.day === yesterday && overnight) return cur < end;
    return false;
  });
}

function scheduleDays(truck) {
  const days = [...new Set(truck.schedule.map((s) => s.day))];
  days.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  return days.map((d) => d.slice(0, 3)).join(", ");
}

function statusClass(status) {
  return (status || "unknown").toLowerCase();
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
  const q = state.search.toLowerCase();
  const food = state.food.toLowerCase();
  state.filtered = state.trucks.filter((t) => {
    if (state.status && t.status !== state.status) return false;
    if (food && !(t.food || "").toLowerCase().includes(food)) return false;
    if (q) {
      const hay = `${t.name} ${t.address} ${t.locationDescription}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.day === "now") return isOpenNow(t);
    if (state.day) return t.schedule.some((s) => s.day === state.day);
    return true;
  });
  render();
}

// ---------- Rendering ----------
function popupHtml(t) {
  let sched;
  if (t.schedule.length) {
    const rows = t.schedule
      .map((s) => `<tr><td>${esc(s.day.slice(0, 3))}</td><td>${esc(s.start)} – ${esc(s.end)}</td></tr>`)
      .join("");
    sched = `<table>${rows}</table>`;
  } else {
    sched = `<div class="p-nosched">No published schedule for this location.</div>`;
  }
  const openBadge = isOpenNow(t) ? ` <span class="badge open-now">Open now</span>` : "";
  return `<div class="popup">
    <h3>${foodEmoji(t)} ${esc(t.name)}</h3>
    <span class="badge ${statusClass(t.status)}">${esc(t.status.toLowerCase())}</span>${openBadge}
    ${t.food ? `<div class="p-food">${esc(t.food)}</div>` : ""}
    <div class="p-addr">📍 ${esc(t.address || t.locationDescription || "Address unknown")}</div>
    ${sched}
    <div class="p-permit">${esc(t.facilityType)} · Permit ${esc(t.permit)}${t.expiration ? ` · expires ${esc(t.expiration)}` : ""}</div>
  </div>`;
}

function renderMarkers() {
  markerLayer.clearLayers();
  markersById.clear();
  for (const t of state.filtered) {
    if (t.lat == null || t.lng == null) continue;
    const icon = L.divIcon({
      className: "",
      html: `<div class="pin-emoji ${statusClass(t.status)}">${foodEmoji(t)}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 30],
      popupAnchor: [0, -26],
    });
    const m = L.marker([t.lat, t.lng], { icon }).bindPopup(popupHtml(t), { maxWidth: 280 });
    m.on("click", () => {
      state.selectedId = t.id;
      highlightListItem();
    });
    m.addTo(markerLayer);
    markersById.set(t.id, m);
  }
}

function renderList() {
  const ul = $("#results");
  if (!state.filtered.length) {
    ul.innerHTML = `<li class="empty-note"><span class="big">🫗</span>Nothing on the menu here…<br>Try loosening the day or status filter.</li>`;
    return;
  }
  ul.innerHTML = state.filtered
    .map((t, i) => {
      const open = isOpenNow(t) ? `<span class="badge open-now">Open</span>` : `<span class="badge ${statusClass(t.status)}">${esc(t.status.toLowerCase())}</span>`;
      const noMap = t.lat == null ? ` <span class="r-nomap" title="No coordinates in dataset — not on map">⚠ not on map</span>` : "";
      // Cap the stagger so a long list still settles quickly.
      return `<li class="result-item${t.id === state.selectedId ? " selected" : ""}" data-id="${esc(t.id)}" style="--i:${Math.min(i, 14)}">
        <div class="r-emoji">${foodEmoji(t)}</div>
        <div class="r-body">
          <div class="r-name"><span>${esc(t.name)}</span>${open}</div>
          ${t.food ? `<div class="r-food">${esc(t.food)}</div>` : ""}
          <div class="r-addr">${esc(t.address || t.locationDescription || "")}${noMap}</div>
        </div>
      </li>`;
    })
    .join("");
}

function renderTable() {
  $("#table-body").innerHTML = state.filtered
    .map(
      (t) => `<tr data-id="${esc(t.id)}">
        <td>${foodEmoji(t)} <strong>${esc(t.name)}</strong></td>
        <td>${esc(t.food)}</td>
        <td>${esc(t.address || t.locationDescription || "")}</td>
        <td><span class="badge ${statusClass(t.status)}">${esc(t.status.toLowerCase())}</span></td>
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
  if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function render() {
  const onMap = state.filtered.filter((t) => t.lat != null).length;
  const offMap = state.filtered.length - onMap;
  const countEl = $("#result-count");
  const text =
    `${state.filtered.length} truck${state.filtered.length === 1 ? "" : "s"} rollin'` +
    (offMap ? ` (${offMap} off-map)` : "");
  if (countEl.textContent !== text) {
    countEl.textContent = text;
    // Retrigger the little pop whenever the number actually changes.
    countEl.style.animation = "none";
    void countEl.offsetWidth;
    countEl.style.animation = "pop-count 0.4s ease";
  }
  renderMarkers();
  renderList();
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

$("#table-body").addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (!row) return;
  setView("map");
  focusTruck(row.dataset.id);
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
    c.classList.toggle("active", c.dataset.food === state.food.toLowerCase());
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
  state.status = "APPROVED";
  $("#search").value = $("#food-search").value = "";
  $("#status-filter").value = "APPROVED";
  $("#day-filter").value = "";
  syncChips();
  applyFilters();
});

// Map/table view toggle
function setView(view) {
  const isMap = view === "map";
  $("#view-map").classList.toggle("active", isMap);
  $("#view-table").classList.toggle("active", !isMap);
  $("#table-view").hidden = isMap;
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

async function loadTrucks() {
  $("#data-freshness").textContent = "Loading…";
  const res = await fetch("/api/trucks");
  const data = await res.json();
  if (!res.ok) {
    $("#data-freshness").textContent = data.error || "Failed to load data";
    return;
  }
  state.trucks = data.trucks;
  setFreshness(data.fetched_at);
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
    const data = await res.json();
    if (!res.ok) {
      $("#data-freshness").textContent = data.error || "Refresh failed";
    } else {
      await loadTrucks();
    }
  } catch {
    $("#data-freshness").textContent = "Refresh failed — is the server running?";
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    label.textContent = "Refresh data";
  }
});

loadTrucks().catch(() => {
  $("#data-freshness").textContent = "Could not reach the local server.";
});
