// Night mode ends at the wake time (07:00 unless /goodnight HH:MM set another), in local time. Shared by the hub
// (/goodnight, its reply and its clean-up) and the phone (which counts from its own clock, the clock widget's zone).
// Rule: goodnight between midnight and the wake time -> dim until the wake time that same morning; any other time
// (the evening, or after the wake time) -> until the wake time the next morning.
// Wall times as in events.js: a local date and time written as if it were UTC.

export const DEFAULT_WAKE = "07:00";
const DAY = 86400000;

export function parseWake(s) {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(String(s || "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

// Wall ms of the next wake after `nowWall` (strictly after: goodnight at 07:00 sharp dims until tomorrow).
export function wakeWall(nowWall, wake = DEFAULT_WAKE) {
  const [h, m] = (parseWake(wake) || DEFAULT_WAKE).split(":").map(Number);
  const day = nowWall - (((nowWall % DAY) + DAY) % DAY);
  const at = day + (h * 60 + m) * 60000;
  return at > nowWall ? at : at + DAY;
}

// Absolute ms when night mode started at `sinceMs` (wall clock there: sinceWall) ends.
export const nightUntil = (sinceMs, sinceWall, wake) => sinceMs + (wakeWall(sinceWall, wake) - sinceWall);

// ---------- two independent dimmers ----------
// A) goodnight mode (settings.goodnightMode, on by default): state.night from goodnight, until its wake time.
// B) quiet hours (settings.quiet = { on, from, to }, on 01:00-07:00 by default): dim every night in that window.
// The screen is dim while either is active; neither cancels the other. A tap or /wake during quiet hours brightens
// it for QUIET_WAKE_MS (state.quietWake.until), then quiet hours dim it again.
export const QUIET_DEFAULT = { on: true, from: "01:00", to: "07:00" };
export const QUIET_WAKE_MS = 2 * 60 * 1000;
const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export function quietOf(settings) {
  const q = (settings && settings.quiet) || {};
  return { on: q.on !== false, from: parseWake(q.from) || QUIET_DEFAULT.from, to: parseWake(q.to) || QUIET_DEFAULT.to };
}
export const goodnightModeOn = (settings) => !(settings && settings.goodnightMode === false);

// Is the wall time inside [from, to)? A window that crosses midnight (23:00-06:00) wraps; from == to is empty.
export function inQuiet(nowWall, q) {
  const t = Math.floor((((nowWall % DAY) + DAY) % DAY) / 60000), a = mins(q.from), b = mins(q.to);
  return a < b ? t >= a && t < b : a > b ? t >= a || t < b : false;
}

// End of a goodnight: counted from `since` on the given clock (wallOf: absolute ms -> wall ms); old hubs sent `until`.
export function nightEndOf(n, wallOf) {
  if (!n) return 0;
  return typeof n.since === "number" ? nightUntil(n.since, wallOf(n.since), n.wake) : n.until || 0;
}

// What dims the screen now. -> { dim, goodnight, quiet, inQuiet, wokeUntil, goodnightUntil }
export function dimState(state, now, wallOf) {
  const s = (state && state.settings) || {};
  const gEnd = goodnightModeOn(s) ? nightEndOf(state && state.night, wallOf) : 0;
  const goodnight = gEnd > now;
  const q = quietOf(s);
  const inQ = q.on && inQuiet(wallOf(now), q);
  const woke = state && state.quietWake && state.quietWake.until > now ? state.quietWake.until : 0;
  const quiet = inQ && !woke;
  return { dim: goodnight || quiet, goodnight, quiet, inQuiet: inQ, wokeUntil: inQ ? woke : 0, goodnightUntil: goodnight ? gEnd : 0 };
}
