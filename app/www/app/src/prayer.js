// Prayer times on the phone: the next prayer and today's five, from the hub's Aladhan lookup (state.prayer), and the
// optional per-prayer chime / adhan (settings.prayer.alarms, off by default). Times are wall ms (events.js).
import { wallYmd, DAY } from "./events.js";

export const PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
export const NAMES = { fajr: "Fajr", sunrise: "Sunrise", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" };

const at = (ymd, hhmm) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = String(hhmm).split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
};

function dayFor(prayer, ymd) {
  if (!prayer) return null;
  for (const d of [prayer.today, prayer.tomorrow]) if (d && d.date === ymd) return d;
  return null;
}

// -> { day, list: [{ key, name, time, at, past }], next: { key, name, at, tomorrow } } or null without data for today
export function prayerBoard(prayer, now) {
  const ymd = wallYmd(now);
  const day = dayFor(prayer, ymd);
  if (!day) return null;
  const list = PRAYERS.map((k) => ({ key: k, name: NAMES[k], time: day.times[k], at: at(ymd, day.times[k]) }))
    .map((p) => ({ ...p, past: p.at <= now }));
  let next = list.find((p) => !p.past);
  if (next) next = { ...next, tomorrow: false };
  else {
    const t = dayFor(prayer, wallYmd(now + DAY));
    if (t) next = { key: "fajr", name: "Fajr", time: t.times.fajr, at: at(t.date, t.times.fajr), tomorrow: true };
  }
  return { day, list, next: next || null, sunrise: day.times.sunrise };
}

// Prayers whose alarm is on and whose time is within the last minute. fired: Set of keys already rung.
export function duePrayers(prayer, alarms, now, fired) {
  const b = prayerBoard(prayer, now);
  if (!b || !alarms) return [];
  return b.list.filter((p) => {
    const mode = alarms[p.key];
    const key = `${p.key}@${wallYmd(now)}`;
    return mode && mode !== "off" && now >= p.at && now - p.at < 60000 && !fired.has(key);
  }).map((p) => ({ ...p, mode: alarms[p.key], fired: `${p.key}@${wallYmd(now)}` }));
}
