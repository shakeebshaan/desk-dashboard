// Sun and moon (app/www/app/src/astro.js) against published tables from the US Naval Observatory
// (aa.usno.navy.mil/api, fetched 2026-10-24). USNO gives times to the minute.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPhase, moonNow, sunTimes, moonPath, sunProgress } from "../../app/www/app/src/astro.js";

// USNO moon phases (UTC): /api/moon/phases/date?date=2024-01-01&nump=12 and ?date=2026-10-01&nump=12
const PHASES = [
  ["Last Quarter", "2024-01-04T03:30"], ["New Moon", "2024-01-11T11:57"], ["First Quarter", "2024-01-18T03:52"], ["Full Moon", "2024-01-25T17:54"],
  ["Last Quarter", "2024-02-02T23:18"], ["New Moon", "2024-02-09T22:59"], ["First Quarter", "2024-02-16T15:01"], ["Full Moon", "2024-02-24T12:30"],
  ["Last Quarter", "2024-03-03T15:23"], ["New Moon", "2024-03-10T09:00"], ["First Quarter", "2024-03-17T04:11"], ["Full Moon", "2024-03-25T07:00"],
  ["Last Quarter", "2026-10-03T13:25"], ["New Moon", "2026-10-10T15:50"], ["First Quarter", "2026-10-18T16:12"], ["Full Moon", "2026-10-26T04:12"],
  ["Last Quarter", "2026-11-01T20:28"], ["New Moon", "2026-11-09T07:02"], ["First Quarter", "2026-11-17T11:48"], ["Full Moon", "2026-11-24T14:53"],
  ["Last Quarter", "2026-12-01T06:08"], ["New Moon", "2026-12-09T00:52"], ["First Quarter", "2026-12-17T05:42"], ["Full Moon", "2026-12-24T01:28"],
];
const KIND = { "New Moon": "new", "First Quarter": "first", "Full Moon": "full", "Last Quarter": "last" };
const utc = (s) => Date.parse(`${s}:00Z`);

test("moon phases: all 24 USNO phases within 2 minutes", () => {
  for (const [name, t] of PHASES) {
    const want = utc(t);
    const got = nextPhase(KIND[name], want - 5 * 86400000);
    assert.ok(Math.abs(got - want) <= 2 * 60000, `${name} ${t}: off by ${((got - want) / 60000).toFixed(1)} min`);
  }
});

test("moon now: illumination and names at the principal phases, next full and new", () => {
  const at = (t) => moonNow(utc(t));
  assert.ok(at("2026-10-26T04:12").illum > 0.995, "full");
  assert.equal(at("2026-10-26T04:12").name, "Full moon");
  assert.ok(at("2026-10-10T15:50").illum < 0.005, "new");
  assert.equal(at("2026-10-10T15:50").name, "New moon");
  for (const t of ["2026-10-18T16:12", "2026-11-01T20:28", "2024-01-18T03:52"]) assert.ok(Math.abs(at(t).illum - 0.5) < 0.015, `quarter ${t}: ${at(t).illum}`);
  assert.equal(at("2026-10-18T16:12").name, "First quarter");
  assert.equal(at("2026-11-01T20:28").name, "Last quarter");
  // USNO for Pune on 24 Oct 2026: "Waxing Gibbous"; full moon on the 26th 04:12 UTC, new moon 9 Nov 07:02 UTC
  const m = at("2026-10-24T06:00");
  assert.equal(m.name, "Waxing gibbous");
  assert.ok(m.waxing && m.illum > 0.9 && m.illum < 0.99, String(m.illum));
  assert.ok(Math.abs(m.nextFull - utc("2026-10-26T04:12")) < 2 * 60000);
  assert.ok(Math.abs(m.nextNew - utc("2026-11-09T07:02")) < 2 * 60000);
  assert.ok(Math.abs(m.ageDays - (utc("2026-10-24T06:00") - utc("2026-10-10T15:50")) / 86400000) < 0.01);
});

test("moon drawing: the lit path follows the phase", () => {
  assert.match(moonPath(0.5, true), /A0\.00 50/, "a quarter has a straight terminator");
  assert.match(moonPath(0.25, true), /^M50 0 A50 50 0 0 1 50 100 A25\.00 50 0 0 0 50 0 Z$/, "waxing crescent: right limb, terminator bulging right");
  assert.match(moonPath(0.75, false), /^M50 0 A50 50 0 0 0 50 100 A25\.00 50 0 0 0 50 0 Z$/, "waning gibbous: left limb, terminator bulging right");
});

// USNO one-day data for Pune (18.52043 N, 73.85674 E, UTC+5:30): /api/rstt/oneday
const PUNE = { lat: 18.52043, lon: 73.85674 };
const SUN = [["2026-01-15", "07:10", "18:18"], ["2026-03-21", "06:38", "18:46"], ["2026-06-21", "05:59", "19:14"], ["2026-10-24", "06:31", "18:06"], ["2026-12-21", "07:02", "18:03"]];
const ist = (ymd, hm) => Date.parse(`${ymd}T${hm}:00+05:30`);

test("sunrise and sunset for Pune within 1.5 minutes of USNO on five dates", () => {
  for (const [ymd, rise, set] of SUN) {
    const [y, m, d] = ymd.split("-").map(Number);
    const s = sunTimes(y, m, d, PUNE.lat, PUNE.lon);
    assert.ok(Math.abs(s.rise - ist(ymd, rise)) <= 90000, `${ymd} rise off by ${((s.rise - ist(ymd, rise)) / 60000).toFixed(1)} min`);
    assert.ok(Math.abs(s.set - ist(ymd, set)) <= 90000, `${ymd} set off by ${((s.set - ist(ymd, set)) / 60000).toFixed(1)} min`);
    assert.ok(s.noon > s.rise && s.noon < s.set);
  }
  // longest day in June, shortest in December
  const len = (m, d) => sunTimes(2026, m, d, PUNE.lat, PUNE.lon).dayMs;
  assert.ok(len(6, 21) > len(3, 21) && len(3, 21) > len(12, 21));
  // polar night: no sunrise
  assert.equal(sunTimes(2026, 12, 21, 78.2, 15.6).rise, null);
});

test("sun progress: 0 at sunrise, 1 at sunset, night runs toward the next sunrise", () => {
  const t = sunTimes(2026, 10, 24, PUNE.lat, PUNE.lon);
  const n = sunTimes(2026, 10, 25, PUNE.lat, PUNE.lon);
  assert.equal(sunProgress(t.rise, t, n).day, 0);
  assert.ok(Math.abs(sunProgress((t.rise + t.set) / 2, t, n).day - 0.5) < 1e-9);
  const night = sunProgress(t.set + (n.rise - t.set) / 4, t, n);
  assert.equal(night.day, null);
  assert.ok(Math.abs(night.night - 0.25) < 1e-9);
});
