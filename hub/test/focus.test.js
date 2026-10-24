// Event-driven cycle (app/www/app/src/focus.js): priority, queueing (never drop an event), live vs timed, and the
// 3 s lead for timed moments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FocusQueue, PRIO, LEAD_MS, dueMoments, weatherEvent, TEMP_JUMP } from "../../app/www/app/src/focus.js";

test("priority: ringing alarm, then agent, then prayer, then the rest, whatever the arrival order", () => {
  const q = new FocusQueue();
  q.push({ key: "sunset", widget: "sun", prio: PRIO.other, dur: 10000 }, 0);
  q.push({ key: "maghrib", widget: "prayer", prio: PRIO.prayer, dur: 10000 }, 0);
  q.push({ key: "speak", widget: "agent", prio: PRIO.agent, live: true }, 0);
  q.push({ key: "ring", widget: "alarms", prio: PRIO.alarm, live: true }, 0);
  assert.equal(q.tick(0).cur.key, "ring");
  assert.deepEqual(q.queue, ["ring", "speak", "maghrib", "sunset"]);
  q.release("ring");
  assert.equal(q.tick(1000).cur.key, "speak");
  q.release("speak");
  assert.equal(q.tick(2000).cur.key, "maghrib");
  assert.equal(q.tick(11999).cur.key, "maghrib", "a timed event holds for its whole duration");
  assert.equal(q.tick(12000).cur.key, "sunset", "then the next one, none dropped");
  assert.equal(q.tick(22000).cur, null, "and back to the normal cycle");
});

test("a live event holds until released; a more urgent one pushes a timed event aside, which comes back with its full time", () => {
  const q = new FocusQueue();
  q.push({ key: "photo", widget: "photos", dur: 12000 }, 0);
  assert.equal(q.tick(0).cur.key, "photo");
  q.push({ key: "ring", widget: "alarms", prio: PRIO.alarm, live: true }, 5000);
  const r = q.tick(5000);
  assert.ok(r.changed && r.cur.key === "ring");
  assert.equal(q.tick(600000).cur.key, "ring", "a ringing alarm holds as long as it rings");
  q.release("ring");
  assert.equal(q.tick(600001).cur.key, "photo", "the photo was not dropped");
  assert.equal(q.tick(600001 + 11999).cur.key, "photo", "and gets its full 12 s again");
  assert.equal(q.tick(600001 + 12000).cur, null);
});

test("same key updates in place: speech turns into a short tail, two agent states make one event", () => {
  const q = new FocusQueue();
  q.push({ key: "speak", widget: "agent", prio: PRIO.agent, live: true }, 0);
  q.push({ key: "speak", widget: "agent", prio: PRIO.agent, live: true }, 100);
  assert.equal(q.items.length, 1);
  assert.equal(q.tick(100).cur.key, "speak");
  q.push({ key: "speak", dur: 6000 }, 20000); // speech ended at 20 s
  assert.equal(q.tick(25999).cur.key, "speak");
  assert.equal(q.tick(26000).cur, null);
});

test("equal priority: first come, first served", () => {
  const q = new FocusQueue();
  q.push({ key: "sunrise", widget: "sun", dur: 1000 }, 0);
  q.push({ key: "photo", widget: "photos", dur: 1000 }, 0);
  q.push({ key: "bday", widget: "age", dur: 1000 }, 0);
  const order = [];
  for (let t = 0; t <= 3000; t += 1000) { const c = q.tick(t).cur; if (c && order.at(-1) !== c.key) order.push(c.key); }
  assert.deepEqual(order, ["sunrise", "photo", "bday"]);
});

test("timed moments are due from 3 s before until a minute after, once", () => {
  const at = 1_000_000;
  const ms = [{ key: "sunset@x", widget: "sun", at }];
  const fired = new Set();
  assert.equal(LEAD_MS, 3000);
  assert.equal(dueMoments(ms, at - 3001, fired).length, 0);
  assert.equal(dueMoments(ms, at - 3000, fired).length, 1);
  assert.equal(dueMoments(ms, at + 59999, fired).length, 1);
  assert.equal(dueMoments(ms, at + 60000, fired).length, 0, "too late after a minute (the phone was off)");
  fired.add("sunset@x");
  assert.equal(dueMoments(ms, at, fired).length, 0, "once per key");
});

test("weather events: rain/thunder/snow starting, the rain stopping, a big temperature move; nothing for small changes", () => {
  const w = (icon, temp, at = 2, city = "Pune") => ({ at, city, current: { icon, temp } });
  assert.deepEqual(weatherEvent(w("cloud", 27, 1), w("rain", 26)), { kind: "rain" });
  assert.deepEqual(weatherEvent(w("sun", 27, 1), w("drizzle", 27)), { kind: "rain" });
  assert.deepEqual(weatherEvent(w("rain", 27, 1), w("storm", 25)), { kind: "storm" }, "thunder beats rain");
  assert.deepEqual(weatherEvent(w("cloud", 1, 1), w("snow", 0)), { kind: "snow" });
  assert.deepEqual(weatherEvent(w("rain", 24, 1), w("partly", 25)), { kind: "dry" });
  assert.deepEqual(weatherEvent(w("sun", 24, 1), w("sun", 24 + TEMP_JUMP)), { kind: "warm", delta: TEMP_JUMP });
  assert.deepEqual(weatherEvent(w("sun", 30.4, 1), w("cloud", 25.6)), { kind: "cool", delta: -4 }, "rounded like the screen shows it");
  assert.equal(weatherEvent(w("sun", 24, 1), w("sun", 27)), null, "3 degrees is not news");
  assert.equal(weatherEvent(w("rain", 24, 1), w("rain", 24)), null, "still raining is not news");
  assert.equal(weatherEvent(w("cloud", 24, 1), w("rain", 24, 2, "Mumbai")), null, "a new city is not a change in the weather");
  assert.equal(weatherEvent(w("cloud", 24, 2), w("rain", 24, 2)), null, "the same reading again");
  assert.equal(weatherEvent(null, w("rain", 24)), null, "first reading after start-up");
});
