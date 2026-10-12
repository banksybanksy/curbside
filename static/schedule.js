/* Schedule and filter logic, kept free of DOM and Leaflet so it runs under node --test. */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Schedule times in the dataset are San Francisco wall-clock times, so "open now"
// is judged on SF time, not the viewer's.
const SF_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function sfClock(date = new Date()) {
  const parts = Object.fromEntries(SF_CLOCK.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: parts.weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

// A shift that ends at or before it starts runs past midnight, so yesterday's
// late shift can still be open this morning.
function isOpenAt(truck, clock) {
  const yesterday = DAYS[(DAYS.indexOf(clock.day) + 6) % 7];
  return truck.schedule.some((s) => {
    if (!s.start24 || !s.end24) return false;
    const start = toMinutes(s.start24);
    const end = toMinutes(s.end24);
    const overnight = end <= start;
    if (s.day === clock.day) return overnight ? clock.minutes >= start : clock.minutes >= start && clock.minutes < end;
    if (s.day === yesterday && overnight) return clock.minutes < end;
    return false;
  });
}

// Today's shifts in the order they start, for the popup's "Today" line.
function shiftsOn(truck, day) {
  return truck.schedule.filter((s) => s.day === day).sort((a, b) => toMinutes(a.start24 || "0:0") - toMinutes(b.start24 || "0:0"));
}

function scheduleDays(truck) {
  const days = [...new Set(truck.schedule.map((s) => s.day))];
  days.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  return days.map((d) => d.slice(0, 3)).join(", ");
}

// filters: { search, food, status, day } where day is "", "now" or a weekday name.
function matchesFilters(truck, filters, clock) {
  if (filters.status && truck.status !== filters.status) return false;
  const food = filters.food.toLowerCase();
  if (food && !(truck.food || "").toLowerCase().includes(food)) return false;
  const q = filters.search.toLowerCase();
  if (q) {
    const hay = `${truck.name} ${truck.address} ${truck.locationDescription}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filters.day === "now") return isOpenAt(truck, clock);
  if (filters.day) return truck.schedule.some((s) => s.day === filters.day);
  return true;
}

if (typeof module === "object") {
  module.exports = { DAYS, sfClock, toMinutes, isOpenAt, shiftsOn, scheduleDays, matchesFilters };
}
