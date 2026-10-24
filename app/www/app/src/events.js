// Countdowns: the owner's own events (once, weekly, yearly, daily) and the Islamic dates the hub looks up. Shared by the
// hub (/event, /events) and the phone (countdown widget), like age.js.
// Times are "wall clock" milliseconds: a local date and time written as if it were UTC. The phone makes them from its
// own clock, the hub from the dashboard's time zone, so both count to the same moment without time-zone maths.

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const DAY = 86400000;
export const MAX_EVENTS = 30;

export const wallNow = (d = new Date()) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
export const wallFromParts = (p) => Date.UTC(p.y, p.m - 1, p.d, p.hh || 0, p.mm || 0, p.ss || 0);
const dayStart = (ms) => ms - (((ms % DAY) + DAY) % DAY);
const pad = (n) => String(n).padStart(2, "0");
export const wallYmd = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

function hm(time) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function weekdayOf(word) {
  const w = String(word).toLowerCase().replace(/s$/, "");
  const i = WEEKDAYS.findIndex((d) => d === w || d.slice(0, 3) === w || (w.length >= 3 && d.startsWith(w)));
  return i >= 0 ? i : null;
}

// "/event ..." text -> { ok: true, ev } or { ok: false }. Forms:
//   [every] <weekday> [HH:MM] <name>      weekly          e.g. Tuesday 11:00 Work
//   <YYYY-MM-DD> [HH:MM] <name>           once            e.g. 2026-12-25 Trip
//   yearly <MM-DD> [HH:MM] <name>         every year      e.g. yearly 03-15 Anniversary
//   daily <HH:MM> <name>                  every day       e.g. daily 07:30 School run
export function parseEvent(text) {
  const words = String(text || "").trim().split(/\s+/);
  let kind = null, i = 0, ev = {};
  const w0 = (words[0] || "").toLowerCase();
  if (w0 === "every" && weekdayOf(words[1] || "") !== null) i = 1;
  if (w0 === "daily") { kind = "daily"; i = 1; }
  else if (w0 === "yearly") {
    const m = /^(\d\d)-(\d\d)$/.exec(words[1] || "");
    if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return { ok: false };
    kind = "yearly"; ev.md = words[1]; i = 2;
  } else if (/^\d{4}-\d\d-\d\d$/.test(w0)) {
    const [y, mo, d] = w0.split("-").map(Number);
    const t = Date.UTC(y, mo - 1, d);
    if (wallYmd(t) !== w0) return { ok: false };
    kind = "once"; ev.date = w0; i = 1;
  } else if (weekdayOf(words[i]) !== null) {
    kind = "weekly"; ev.weekday = weekdayOf(words[i]); i += 1;
  }
  if (!kind) return { ok: false };
  if (hm(words[i])) { ev.time = words[i].padStart(5, "0"); i += 1; }
  if (kind === "daily" && !ev.time) return { ok: false };
  const name = words.slice(i).join(" ").trim().slice(0, 50);
  if (!name) return { ok: false };
  return { ok: true, ev: { kind, name, ...ev } };
}

// Next time an event happens, at or after `now` (wall ms). An all-day event (no time) counts until its day ends.
// -> { at, allDay } or null (a one-off in the past)
export function nextOccurrence(ev, now) {
  const t = hm(ev.time) || [0, 0];
  const allDay = !ev.time;
  const at = (dayMs) => dayMs + (t[0] * 60 + t[1]) * 60000;
  const ok = (ms) => (allDay ? dayStart(ms) + DAY > now : ms >= now);
  const today = dayStart(now);
  if (ev.kind === "once") {
    const [y, m, d] = String(ev.date).split("-").map(Number);
    const ms = at(Date.UTC(y, m - 1, d));
    return ok(ms) ? { at: ms, allDay } : null;
  }
  if (ev.kind === "daily") {
    const ms = at(today);
    return { at: ok(ms) ? ms : ms + DAY, allDay };
  }
  if (ev.kind === "weekly") {
    const dow = new Date(today).getUTCDay();
    let ms = at(today + ((ev.weekday - dow + 7) % 7) * DAY);
    if (!ok(ms)) ms += 7 * DAY;
    return { at: ms, allDay };
  }
  if (ev.kind === "yearly") {
    const [mo, d] = String(ev.md).split("-").map(Number);
    const y = new Date(today).getUTCFullYear();
    let ms = at(Date.UTC(y, mo - 1, d));
    if (!ok(ms)) ms = at(Date.UTC(y + 1, mo - 1, d));
    return { at: ms, allDay };
  }
  return null;
}

// "in 3 days" style countdown; all-day items say "today" / "tomorrow".
export function countdownText(at, now, allDay) {
  if (allDay) {
    const days = Math.round((dayStart(at) - dayStart(now)) / DAY);
    return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  }
  const ms = at - now;
  if (ms < 60000) return "now";
  const mins = Math.floor(ms / 60000), h = Math.floor(mins / 60), d = Math.floor(h / 24);
  if (d >= 2) return `in ${d} days`;
  if (d === 1) return `in 1 day ${h - 24} h`;
  if (h >= 1) return `in ${h} h ${mins % 60} m`;
  return `in ${mins} m`;
}

export function repeatText(ev) {
  if (ev.kind === "weekly") return `every ${WEEKDAYS[ev.weekday][0].toUpperCase()}${WEEKDAYS[ev.weekday].slice(1)}`;
  if (ev.kind === "yearly") return "every year";
  if (ev.kind === "daily") return "every day";
  return "";
}

// Own events + Islamic dates, soonest first. islamic: [{ name, date: "YYYY-MM-DD", hijri }]
export function upcoming({ events = [], islamic = [] } = {}, now, n = 6) {
  const out = [];
  for (const ev of events) {
    const o = nextOccurrence(ev, now);
    if (o) out.push({ name: ev.name, at: o.at, allDay: o.allDay, kind: "event", repeat: repeatText(ev), time: ev.time || null });
  }
  for (const x of islamic) {
    const o = nextOccurrence({ kind: "once", date: x.date }, now);
    if (o) out.push({ name: x.name, at: o.at, allDay: true, kind: "islamic", hijri: x.hijri || "" });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, n);
}
