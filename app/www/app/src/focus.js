// Event-driven cycle: which widget holds the screen when something happens. Pure logic (no DOM), unit-tested in
// hub/test/focus.test.js; main.js shows the widget of `current` and pauses the normal cycle while there is one.
//
// An event: { key, widget, prio, live } or { key, widget, prio, dur }.
//   live  - lasts until release(key): an alarm ringing, the agent speaking or listening, a prayer call
//   dur   - lasts `dur` ms once it is on screen: the 3 s before a timed moment plus its animation, a new photo
// Order: prio first (lower wins), then arrival. Overlapping events queue; none is dropped. An event pushed aside by a
// more urgent one keeps its place and gets its full time again when it comes back.

export const PRIO = { alarm: 0, agent: 1, prayer: 2, other: 3 };
export const LEAD_MS = 3000; // timed events come forward this long before their moment

export class FocusQueue {
  constructor() {
    this.items = [];
    this.seq = 0;
    this.cur = null;
  }

  // Adds an event, or updates the one with the same key (a live event can turn into a timed tail, a timed one can
  // get longer). Returns the event.
  push(ev, now = Date.now()) {
    const old = this.items.find((e) => e.key === ev.key);
    if (old) {
      Object.assign(old, ev);
      if (ev.dur !== undefined && !ev.live) { old.live = false; if (old === this.cur) old.startedAt = now; }
      return old;
    }
    const e = { prio: PRIO.other, ...ev, seq: this.seq++, startedAt: null, pushedAt: now };
    this.items.push(e);
    return e;
  }

  release(key) {
    this.items = this.items.filter((e) => e.key !== key);
  }

  has(key) {
    return this.items.some((e) => e.key === key);
  }

  // Drops finished events and picks the one on screen. -> { cur, changed }
  tick(now = Date.now()) {
    if (this.cur && !this.cur.live && this.cur.startedAt !== null && now - this.cur.startedAt >= this.cur.dur) this.release(this.cur.key);
    this.items.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    const next = this.items[0] || null;
    const changed = next !== this.cur;
    if (changed) {
      if (this.cur && this.items.includes(this.cur) && !this.cur.live) this.cur.startedAt = null; // pushed aside: full time later
      if (next && next.startedAt === null) next.startedAt = now;
      this.cur = next;
    }
    return { cur: this.cur, changed };
  }

  get queue() {
    return [...this.items].sort((a, b) => a.prio - b.prio || a.seq - b.seq).map((e) => e.key);
  }
}

// Timed moments of the day, for the planner in main.js: each { key, widget, prio, at (absolute ms), anim (ms) }.
// A moment is due from LEAD_MS before it until `grace` after it, once per key.
export function dueMoments(moments, now, fired, grace = 60000) {
  return moments.filter((m) => m.at && now >= m.at - LEAD_MS && now < m.at + grace && !fired.has(m.key));
}

// Weather worth bringing forward: compares the last reading with the new one (same city, newer). -> { kind, ... } or null.
// kind: "storm" (thunder starts), "rain" (rain or drizzle starts), "snow" (snow starts), "dry" (the rain stopped),
// "warm" / "cool" (the temperature moved TEMP_JUMP degrees or more; delta = new - old, rounded).
export const TEMP_JUMP = 4;
const WET_ICONS = new Set(["rain", "drizzle", "storm"]);
export function weatherEvent(prev, next) {
  if (!prev || !next || !prev.current || !next.current || prev.city !== next.city || !(next.at > prev.at)) return null;
  const a = prev.current.icon, b = next.current.icon;
  if (b === "storm" && a !== "storm") return { kind: "storm" };
  if (WET_ICONS.has(b) && !WET_ICONS.has(a)) return { kind: "rain" };
  if (b === "snow" && a !== "snow") return { kind: "snow" };
  const delta = Math.round(next.current.temp) - Math.round(prev.current.temp);
  if (Number.isFinite(delta) && Math.abs(delta) >= TEMP_JUMP) return { kind: delta > 0 ? "warm" : "cool", delta };
  if (WET_ICONS.has(a) && !WET_ICONS.has(b)) return { kind: "dry" };
  return null;
}
