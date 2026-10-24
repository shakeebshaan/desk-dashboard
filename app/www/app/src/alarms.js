// Alarms ring on the phone itself from the list in the last snapshot, so they work while the hub is down.
// One-shot items carry `at` (epoch ms); daily items carry `time` "HH:MM" in the phone's local time.

const FIRED_KEY = "dash.fired";
const GRACE = 10 * 60 * 1000; // a missed one-shot still rings if the phone was busy for < 10 min

function todayAt(time, now) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// Next time this alarm will ring (or rings now), or null if it is over.
export function nextFire(a, now = Date.now()) {
  if (a.at) return a.at > now - GRACE ? a.at : null;
  if (a.time) {
    const t = todayAt(a.time, now);
    return t >= now - 60000 ? t : t + 86400000;
  }
  return null;
}

export class AlarmEngine {
  constructor({ onRing }) {
    this.onRing = onRing;
    this.alarms = [];
    try { this.fired = new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || "[]")); } catch { this.fired = new Set(); }
  }

  set(alarms) {
    this.alarms = alarms || [];
  }

  mark(key) {
    this.fired.add(key);
    localStorage.setItem(FIRED_KEY, JSON.stringify([...this.fired].slice(-200)));
  }

  // Called every second.
  check(now = Date.now()) {
    for (const a of this.alarms) {
      let key = null;
      if (a.at && a.at <= now && now - a.at < GRACE) key = a.id;
      else if (a.time) {
        const t = todayAt(a.time, now);
        if (now >= t && now - t < 60000) key = `${a.id}@${new Date(t).toDateString()}`;
      }
      if (key && !this.fired.has(key)) {
        this.mark(key);
        this.onRing(a);
      }
    }
  }
}
