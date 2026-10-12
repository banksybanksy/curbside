const test = require("node:test");
const assert = require("node:assert/strict");
const { sfClock, isOpenAt, scheduleDays, matchesFilters } = require("../static/schedule.js");

function truck(schedule, fields = {}) {
  return {
    name: "Vendor",
    address: "1 Market St",
    locationDescription: "MARKET ST: STEUART ST to SPEAR ST",
    food: "Tacos: burritos",
    status: "APPROVED",
    schedule,
    ...fields,
  };
}

const at = (day, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return { day, minutes: h * 60 + m };
};

const lunch = { day: "Monday", start24: "11:00", end24: "14:00" };
const lateNight = { day: "Friday", start24: "21:00", end24: "02:00" };

test("open during a same-day shift, closed at its end", () => {
  const t = truck([lunch]);
  assert.equal(isOpenAt(t, at("Monday", "11:00")), true);
  assert.equal(isOpenAt(t, at("Monday", "13:59")), true);
  assert.equal(isOpenAt(t, at("Monday", "14:00")), false);
  assert.equal(isOpenAt(t, at("Tuesday", "12:00")), false);
});

test("an overnight shift is open late that day and early the next", () => {
  const t = truck([lateNight]);
  assert.equal(isOpenAt(t, at("Friday", "23:30")), true);
  assert.equal(isOpenAt(t, at("Saturday", "01:30")), true);
  assert.equal(isOpenAt(t, at("Saturday", "02:00")), false);
  assert.equal(isOpenAt(t, at("Friday", "20:59")), false);
});

test("a Saturday overnight shift carries into Sunday", () => {
  const t = truck([{ day: "Saturday", start24: "22:00", end24: "03:00" }]);
  assert.equal(isOpenAt(t, at("Sunday", "01:00")), true);
});

test("an entry with missing times is never open", () => {
  const t = truck([{ day: "Monday", start24: "", end24: "" }]);
  assert.equal(isOpenAt(t, at("Monday", "12:00")), false);
});

test("sfClock reads San Francisco time whatever the viewer's zone", () => {
  // 2026-07-06 03:15 UTC is Sunday 20:15 in San Francisco (PDT, UTC-7).
  assert.deepEqual(sfClock(new Date("2026-07-06T03:15:00Z")), at("Sunday", "20:15"));
  // 2026-01-05 07:30 UTC is Sunday 23:30 in San Francisco (PST, UTC-8).
  assert.deepEqual(sfClock(new Date("2026-01-05T07:30:00Z")), at("Sunday", "23:30"));
});

test("scheduleDays lists each day once, Sunday first", () => {
  const t = truck([{ day: "Friday" }, { day: "Monday" }, { day: "Monday" }, { day: "Sunday" }]);
  assert.equal(scheduleDays(t), "Sun, Mon, Fri");
});

const noFilters = { search: "", food: "", status: "", day: "" };

test("day filter keeps only trucks scheduled that day", () => {
  const monday = { ...noFilters, day: "Monday" };
  assert.equal(matchesFilters(truck([lunch]), monday, at("Friday", "09:00")), true);
  assert.equal(matchesFilters(truck([lateNight]), monday, at("Friday", "09:00")), false);
  assert.equal(matchesFilters(truck([]), monday, at("Friday", "09:00")), false);
});

test("open-now filter uses the given clock", () => {
  const now = { ...noFilters, day: "now" };
  assert.equal(matchesFilters(truck([lunch]), now, at("Monday", "12:00")), true);
  assert.equal(matchesFilters(truck([lunch]), now, at("Monday", "15:00")), false);
});

test("status, food and search filters combine", () => {
  const t = truck([lunch]);
  const clock = at("Monday", "12:00");
  assert.equal(matchesFilters(t, { ...noFilters, status: "APPROVED" }, clock), true);
  assert.equal(matchesFilters(t, { ...noFilters, status: "EXPIRED" }, clock), false);
  assert.equal(matchesFilters(t, { ...noFilters, food: "TACO" }, clock), true);
  assert.equal(matchesFilters(t, { ...noFilters, food: "coffee" }, clock), false);
  assert.equal(matchesFilters(t, { ...noFilters, search: "steuart" }, clock), true);
  assert.equal(matchesFilters(t, { ...noFilters, search: "mission" }, clock), false);
  assert.equal(matchesFilters(truck([lunch], { food: undefined }), { ...noFilters, food: "taco" }, clock), false);
});
