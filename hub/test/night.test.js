// Dimming with a faked clock (app/www/app/src/night.js + hub/src/nightmode.js): A) goodnight mode - goodnight at
// 22:00, 01:30 and 07:30, the wake time setting, the switch; B) quiet hours - the default 01:00-07:00, the switch,
// changed times, a window across midnight; both at once; the 2-minute wake inside quiet hours; what the phone hears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeWall, nightUntil, parseWake, DEFAULT_WAKE, inQuiet, dimState } from "../../app/www/app/src/night.js";
import { goodnight, wake, phoneNightCommand, setGoodnightMode, setQuiet, dimNow } from "../src/nightmode.js";
import { zonedToEpoch, wallParts } from "../src/time.js";
import { Store } from "../src/store.js";
import { tmpDir } from "./helpers.js";

const TZ = "Asia/Kolkata";
const at = (d, hh, mm, ss = 0) => zonedToEpoch({ y: 2026, m: 10, d, hh, mm }, TZ) + ss * 1000; // a faked "now" on the Kolkata clock
const wall = (ms) => { const p = wallParts(ms, TZ); return `${p.d} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };
const H = 3600e3;
const fresh = () => new Store(tmpDir());
// what dims at `now`: "goodnight", "quiet", "goodnight+quiet" or "bright"
const why = (s, now) => { const d = dimNow(s, TZ, now); return [d.goodnight && "goodnight", d.quiet && "quiet"].filter(Boolean).join("+") || "bright"; };

// ---------- A) goodnight mode ----------
test("goodnight at 22:00 -> 07:00 the next morning (9 h)", () => {
  const s = fresh();
  const now = at(24, 22, 0);
  const r = goodnight(s, TZ, null, now);
  assert.equal(r.wake, DEFAULT_WAKE);
  assert.equal(wall(r.until), "25 07:00");
  assert.equal(r.until - now, 9 * H);
  assert.deepEqual(s.get().night, { since: now, wake: "07:00", until: r.until });
});

test("goodnight at 01:30 (after midnight, before 07:00) -> 07:00 that same morning (5.5 h)", () => {
  const r = goodnight(fresh(), TZ, null, at(25, 1, 30));
  assert.equal(wall(r.until), "25 07:00");
  assert.equal(r.until - at(25, 1, 30), 5.5 * H);
});

test("goodnight at 07:30 (after the wake time) -> 07:00 the next morning (23.5 h); 07:00 sharp is tomorrow too", () => {
  const s = fresh();
  const r = goodnight(s, TZ, null, at(25, 7, 30));
  assert.equal(wall(r.until), "26 07:00");
  assert.equal(r.until - at(25, 7, 30), 23.5 * H);
  assert.equal(wall(goodnight(s, TZ, null, at(25, 7, 0)).until), "26 07:00");
  assert.equal(wall(goodnight(s, TZ, null, at(25, 6, 59)).until), "25 07:00");
  assert.equal(wall(goodnight(s, TZ, null, at(24, 23, 59)).until), "25 07:00");
  assert.equal(wall(goodnight(s, TZ, null, at(25, 0, 0)).until), "25 07:00");
});

test("/goodnight 06:30 sets the wake time once: this night and the next ones end at 06:30", () => {
  const s = fresh();
  setQuiet(s, { on: false }); // goodnight alone here
  assert.equal(wall(goodnight(s, TZ, "06:30", at(24, 22, 0)).until), "25 06:30");
  assert.equal(s.get().settings.wakeTime, "06:30");
  assert.equal(why(s, at(25, 6, 29)), "goodnight");
  assert.equal(why(s, at(25, 6, 30)), "bright");
  assert.equal(wall(goodnight(s, TZ, null, at(25, 22, 15)).until), "26 06:30", "kept for the next night");
  assert.deepEqual(wake(s, TZ, at(25, 23, 0)), { ended: true, brightUntil: 0 }, "outside quiet hours /wake just ends it");
  assert.equal(s.get().night, null);
  assert.deepEqual(wake(s, TZ, at(25, 23, 1)), { ended: false, brightUntil: 0 }, "nothing to wake");
});

test("goodnight mode switch: off -> the word goodnight does nothing, and a goodnight in progress ends; on again works", () => {
  const s = fresh();
  setQuiet(s, { on: false });
  goodnight(s, TZ, null, at(24, 22, 0));
  assert.equal(why(s, at(24, 22, 30)), "goodnight");
  setGoodnightMode(s, false);
  assert.equal(s.get().night, null);
  assert.equal(why(s, at(24, 22, 31)), "bright");
  assert.equal(goodnight(s, TZ, null, at(24, 22, 32)), null, "off: goodnight does nothing");
  assert.equal(s.get().night, null);
  // a night left in the state by an older hub is ignored while the mode is off
  assert.equal(dimState({ settings: { goodnightMode: false, quiet: { on: false } }, night: { since: at(24, 22, 0), wake: "07:00" } }, at(24, 23, 0), (ms) => ms + 5.5 * H).dim, false);
  setGoodnightMode(s, true);
  goodnight(s, TZ, null, at(24, 22, 40));
  assert.equal(why(s, at(24, 22, 41)), "goodnight");
});

// ---------- B) quiet hours ----------
test("quiet hours by default: dim 01:00-07:00 every night with no goodnight", () => {
  const s = fresh();
  assert.equal(why(s, at(25, 0, 59)), "bright");
  assert.equal(why(s, at(25, 1, 0)), "quiet");
  assert.equal(why(s, at(25, 4, 0)), "quiet");
  assert.equal(why(s, at(25, 6, 59)), "quiet");
  assert.equal(why(s, at(25, 7, 0)), "bright");
  assert.equal(why(s, at(26, 1, 30)), "quiet", "every night");
});

test("quiet hours switch: off -> no dimming at 03:00; on again -> dim", () => {
  const s = fresh();
  setQuiet(s, { on: false });
  assert.equal(why(s, at(25, 3, 0)), "bright");
  setQuiet(s, { on: true });
  assert.equal(why(s, at(25, 3, 0)), "quiet");
});

test("quiet hours with the times changed: /quiethours 02:00 05:00", () => {
  const s = fresh();
  setQuiet(s, { from: "02:00", to: "05:00", on: true });
  assert.equal(why(s, at(25, 1, 30)), "bright");
  assert.equal(why(s, at(25, 2, 0)), "quiet");
  assert.equal(why(s, at(25, 4, 59)), "quiet");
  assert.equal(why(s, at(25, 5, 0)), "bright");
});

test("quiet hours across midnight: 23:30-06:30 wraps over the date change", () => {
  const s = fresh();
  setQuiet(s, { from: "23:30", to: "06:30", on: true });
  assert.equal(why(s, at(24, 23, 29)), "bright");
  assert.equal(why(s, at(24, 23, 30)), "quiet");
  assert.equal(why(s, at(25, 0, 0)), "quiet");
  assert.equal(why(s, at(25, 6, 29)), "quiet");
  assert.equal(why(s, at(25, 6, 30)), "bright");
  assert.equal(why(s, at(25, 12, 0)), "bright");
  assert.equal(inQuiet(Date.UTC(2026, 9, 24, 10, 0), { from: "10:00", to: "10:00" }), false, "an empty window never dims");
});

// ---------- both ----------
test("both at once: goodnight at 23:00 stays dim through quiet hours to 07:00; switching one off never cancels the other", () => {
  const s = fresh();
  goodnight(s, TZ, null, at(24, 23, 0));
  assert.equal(why(s, at(24, 23, 30)), "goodnight");
  assert.equal(why(s, at(25, 2, 0)), "goodnight+quiet");
  setQuiet(s, { on: false });
  assert.equal(why(s, at(25, 2, 1)), "goodnight", "quiet hours off: goodnight still dims");
  setQuiet(s, { on: true });
  setGoodnightMode(s, false);
  assert.equal(why(s, at(25, 2, 2)), "quiet", "goodnight mode off: quiet hours still dim");
  assert.equal(why(s, at(25, 7, 0)), "bright");
  // a goodnight that ends before quiet hours do: 06:00 wake, quiet to 07:00
  setGoodnightMode(s, true);
  goodnight(s, TZ, "06:00", at(25, 22, 0));
  assert.equal(why(s, at(26, 5, 59)), "goodnight+quiet");
  assert.equal(why(s, at(26, 6, 0)), "quiet", "goodnight over, quiet hours keep it dim");
  assert.equal(why(s, at(26, 7, 0)), "bright");
});

// ---------- the 2-minute wake ----------
test("a tap or /wake inside quiet hours: bright for 2 minutes, then dim again", () => {
  const s = fresh();
  assert.equal(why(s, at(25, 3, 0)), "quiet");
  const r = wake(s, TZ, at(25, 3, 0));
  assert.deepEqual(r, { ended: false, brightUntil: at(25, 3, 2) });
  assert.equal(why(s, at(25, 3, 1, 59)), "bright");
  assert.equal(dimNow(s, TZ, at(25, 3, 1)).wokeUntil, at(25, 3, 2));
  assert.equal(why(s, at(25, 3, 2, 1)), "quiet", "dim again after 2 minutes");
  // goodnight + quiet: the wake ends the goodnight, bright 2 min, then quiet hours dim it to 07:00
  goodnight(s, TZ, null, at(25, 3, 10));
  assert.equal(why(s, at(25, 3, 11)), "goodnight+quiet");
  assert.deepEqual(wake(s, TZ, at(25, 3, 12)), { ended: true, brightUntil: at(25, 3, 14) });
  assert.equal(why(s, at(25, 3, 13)), "bright");
  assert.equal(why(s, at(25, 3, 15)), "quiet");
  // the wake does not carry into the next night
  wake(s, TZ, at(25, 6, 59));
  assert.equal(why(s, at(26, 1, 0)), "quiet");
});

test("the phone counts the same goodnight end from `since` on its own clock (wall time)", () => {
  const sinceWall = Date.UTC(2026, 9, 24, 22, 0);
  assert.equal(new Date(wakeWall(sinceWall)).toISOString(), "2026-10-25T07:00:00.000Z");
  assert.equal(new Date(wakeWall(Date.UTC(2026, 9, 25, 1, 30))).toISOString(), "2026-10-25T07:00:00.000Z");
  assert.equal(new Date(wakeWall(Date.UTC(2026, 9, 25, 7, 30))).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(nightUntil(at(24, 22, 0), sinceWall, "07:00"), at(25, 7, 0), "the same instant the hub stored");
  assert.equal(wakeWall(sinceWall, "nonsense"), wakeWall(sinceWall, "07:00"), "a bad wake time falls back to 07:00");
  assert.equal(parseWake("6:30"), "06:30");
  assert.equal(parseWake("24:00"), null);
});

test("what the phone hears: good night / wake up / good morning work the night mode, the rest goes to the agent", () => {
  for (const t of ["good night", "Goodnight!", "Good night, Jarvis", "goodnight dashboard."]) assert.equal(phoneNightCommand(t), "goodnight", t);
  for (const t of ["wake up", "Good morning!", "good morning jarvis"]) assert.equal(phoneNightCommand(t), "wake", t);
  for (const t of ["good night stories for kids", "what time do I wake up tomorrow", ""]) assert.equal(phoneNightCommand(t), null, t);
});
