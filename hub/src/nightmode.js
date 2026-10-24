// Dimming on the hub, two independent switches (app/www/app/src/night.js has the rules, shared with the phone):
// A) goodnight mode: goodnight (from the bot or said to the phone) dims until the wake time; /wake, "good morning"
//    to the phone or a tap ends it. /goodnightmode on|off (off: the word goodnight does nothing).
// B) quiet hours: dim every night from..to (01:00-07:00); /quiethours on|off|HH:MM HH:MM. A tap or /wake inside them
//    brightens the screen for 2 minutes (state.quietWake), then it is dim again.
// state.night = { since, wake, until }: the phone recounts `until` from `since` on its own clock; the hub's `until`
// (in /tz) is for replies, /status and the clean-up.
import { DEFAULT_WAKE, parseWake, nightUntil, dimState, quietOf, goodnightModeOn, QUIET_WAKE_MS } from "../../app/www/app/src/night.js";
import { wallParts } from "./time.js";
import { wallFromParts } from "../../app/www/app/src/events.js";

// A clean-up margin: the hub drops a finished night this long after its own `until`, so a phone in another zone
// than /tz still ends it on its own clock first.
export const NIGHT_KEEP_MS = 12 * 3600 * 1000;
const wallIn = (tz) => (ms) => wallFromParts(wallParts(ms, tz));

// wake: "HH:MM" given with /goodnight (saved as the new wake time), or null for the saved one.
// -> { until, wake }, or null while goodnight mode is off.
export function goodnight(store, tz, wake = null, now = Date.now()) {
  if (!goodnightModeOn(store.get().settings)) return null;
  if (wake) store.update((s) => { s.settings.wakeTime = wake; }, { silent: true });
  const w = wake || store.get().settings.wakeTime || DEFAULT_WAKE;
  const until = nightUntil(now, wallIn(tz)(now), w);
  store.update((s) => { s.night = { since: now, wake: w, until }; });
  return { until, wake: w };
}

// /wake or a tap: ends a goodnight; inside quiet hours also brightens the screen for 2 minutes.
// -> { ended: bool (a goodnight was on), brightUntil: ms or 0 }
export function wake(store, tz, now = Date.now()) {
  const before = dimState(store.get(), now, wallIn(tz));
  const ended = !!store.get().night;
  const brightUntil = before.inQuiet ? now + QUIET_WAKE_MS : 0;
  if (ended || brightUntil) store.update((s) => { s.night = null; if (brightUntil) s.quietWake = { until: brightUntil }; });
  return { ended, brightUntil };
}

export function setGoodnightMode(store, on) {
  store.update((s) => { s.settings.goodnightMode = on; if (!on) s.night = null; }); // off: a goodnight in progress ends too
}

// patch: { on } and/or { from, to }
export function setQuiet(store, patch) {
  store.update((s) => { s.settings.quiet = { ...quietOf(s.settings), ...patch }; if (patch.on === false) s.quietWake = null; });
}

export function dimNow(store, tz, now = Date.now()) {
  return dimState(store.get(), now, wallIn(tz));
}

// What the phone heard: "good night" -> "goodnight", "wake up" / "good morning" -> "wake", else null (ask the agent).
export function phoneNightCommand(text) {
  const t = String(text || "").trim();
  if (/^good\s*night\b[\s.!,]*(?:dashboard|jarvis)?[\s.!]*$/i.test(t)) return "goodnight";
  if (/^(?:wake\s*up|good\s*morning)\b[\s.!,]*(?:dashboard|jarvis)?[\s.!]*$/i.test(t)) return "wake";
  return null;
}

export { DEFAULT_WAKE, parseWake, quietOf, goodnightModeOn };
