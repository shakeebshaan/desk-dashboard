// Dashboard app: pairing, hub link, cycling widgets, speech, alarms. Plain ES modules, no framework.
// This whole folder is the UI bundle: built into the APK, and replaceable by a signed push from the hub.
import "./body.js"; // first: puts the markup in the page
import { HubLink } from "./conn.js";
import { onUiBundle, reportUi } from "./updater.js";
import { RelayLink, pairViaRelay } from "./relaylink.js";
import { b64u, unb64u, normPairCode } from "./securelink.js";
import { keyVault } from "./keyvault.js";
import { speak, stopSpeaking, spoken, estimateMs } from "./tts.js";
import { AlarmEngine } from "./alarms.js";
import { WIDGETS } from "./widgets/index.js";
import { Camera, RecIndicator } from "./camera.js";
import { Player } from "./player.js";
import { listen, stopListening } from "./voice.js";
import { FileCache } from "./files.js";
import { current as devStatus } from "./devstatus.js";
import { wallNow } from "./events.js";
import { dimState, QUIET_WAKE_MS } from "./night.js";
import { duePrayers } from "./prayer.js";
import { applyMotion, ambient, noteError } from "./motion.js";
import { PerfMeter } from "./perf.js";
import { Diag } from "./diag.js";
import { runSelfTest } from "./selftest.js";
import { BirthdayShow } from "./bdayshow.js";
import { FocusQueue, PRIO, dueMoments, weatherEvent } from "./focus.js";
import { prayerBoard } from "./prayer.js";
import { nextFire } from "./alarms.js";
import { celebration, localYmd } from "./age.js";
import { sunDay } from "./widgets/sun.js";

const $ = (id) => document.getElementById(id);
// dash.hub: the old direct link (0.1.x). dash.relay: the relay link config + counters. dash.relay.key: the phone's
// X25519 secret, wrapped by an Android Keystore key on the phone (keyvault.js).
const LS = { hub: "dash.hub", state: "dash.state", relay: "dash.relay", relayKey: "dash.relay.key", relayUrl: "dash.relayUrl" };
const DEFAULT_RELAY = "https://ntfy.sh";
const pad = (n) => String(n).padStart(2, "0");
// How each card comes in and goes out (styles.css, [data-fx]); a widget's config.fx overrides it.
const CARD_FX = { age: "zoom", clock: "flip", weather: "drop", alarms: "swing", agent: "iris", board: "toss", countdown: "slide",
  prayer: "rise", photos: "fade", quote: "tilt", ambient: "fade", html: "slide", verse: "rise", moon: "zoom", sun: "drop" };

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const EMPTY = {
  settings: { theme: "aurora" }, birthdays: [], child: null, alarms: [], weather: null, customWidgets: {}, agent: { enabled: false },
  activeLayout: "home",
  layouts: [{ id: "home", name: "Home", cycleSeconds: 12, widgets: ["age", "clock", "weather", "alarms", "agent"].map((type, i) => ({ id: `w${i + 1}`, type })) }],
};

let state = load(LS.state) || EMPTY;
let link = null;
let cards = []; // { widget, el, inst }
let idx = 0;
let cycleTimer = null;
let holdUntil = 0; // after speech the agent card stays a moment
let layoutKey = "";
// files: photo-frame pictures / adhan, in memory only (files.js)
const files = new FileCache({ post: (m) => link && link.post && link.post(m), onReady: () => { for (const c of cards) c.inst.update(state); } });
const ctx = { agentCard: null, onTalk: null, files };

// ---------- stage ----------
function activeLayout() {
  return state.layouts.find((l) => l.id === state.activeLayout) || state.layouts[0];
}

function buildStage() {
  const l = activeLayout();
  const key = l.id + ":" + l.widgets.map((w) => `${w.id}/${w.type}/${w.ref || ""}/${w.title || ""}/${JSON.stringify(w.config || {})}`).join(",");
  if (key === layoutKey) return false;
  layoutKey = key;
  for (const c of cards) c.inst.hide && c.inst.hide();
  const stage = $("stage");
  stage.innerHTML = "";
  ctx.agentCard = null;
  cards = l.widgets.filter((w) => WIDGETS[w.type]).map((w) => {
    const def = WIDGETS[w.type];
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.type = w.type;
    el.dataset.fx = (w.config && w.config.fx) || CARD_FX[w.type] || "slide";
    el.innerHTML = `<div class="card-head"><span></span><span class="card-n"></span></div><div class="card-body"></div>`;
    el.querySelector(".card-head span").textContent = w.title || def.title; // hub data: textContent only
    stage.appendChild(el);
    let inst;
    try { inst = def.mount(el.querySelector(".card-body"), ctx, w); } catch (e) { noteError(e); inst = brokenCard(el, def.title); }
    return { widget: w, el, inst };
  });
  // every card draws its data once now, so an empty one is known before the cycle reaches it
  for (const c of cards) { try { c.inst.update(state); } catch (e) { noteError(e); } }
  $("dots").innerHTML = cards.map(() => "<i></i>").join("");
  idx = Math.min(idx, cards.length - 1);
  show(okIdx(Math.max(0, idx), 1, true), true);
  return true;
}

function show(i, instant = false) {
  if (!cards.length) return;
  const prev = cards[idx];
  idx = (i + cards.length) % cards.length;
  const cur = cards[idx];
  for (const c of cards) {
    if (c === cur) continue;
    c.el.classList.remove("show");
    if (c === prev && !instant) {
      c.el.classList.add("leave");
      setTimeout(() => c.el.classList.remove("leave"), 900);
    }
    c.inst.hide && c.inst.hide();
  }
  cur.el.classList.add("show");
  try {
    cur.inst.update(state);
    cur.inst.tick && cur.inst.tick(state);
    cur.inst.show && cur.inst.show();
  } catch (e) { noteError(e); fallback(cur, "could not draw"); }
  // every card shows something within a second: a blank one gets a clear line instead
  clearTimeout(blankTimer);
  blankTimer = setTimeout(() => { if (cards[idx] === cur && isBlank(cur.el)) fallback(cur, "has nothing to show yet"); fitCard(cur); }, 1000);
  fitCard(cur);
  const secs = activeLayout().cycleSeconds || 12;
  document.documentElement.style.setProperty("--cycle", `${secs}s`);
  [...$("dots").children].forEach((d, j) => {
    d.classList.toggle("on", j === idx);
    if (j === idx) { d.style.animation = "none"; void d.offsetWidth; d.style.animation = ""; }
  });
  scheduleCycle();
}

// ---------- blank-card guard ----------
let blankTimer = 0;
let burnStep = -1;
// blank: no text and nothing drawn (svg, canvas, image) of any size in the body
function isBlank(el) {
  const b = el.querySelector(".card-body");
  if (!b || b.querySelector(".card-fallback")) return false;
  if ((b.innerText || "").trim()) return false;
  return ![...b.querySelectorAll("svg, canvas, img, video, iframe")].some((n) => n.getBoundingClientRect().width > 8);
}
function fallback(c, why) {
  noteError(`card ${c.widget.type} ${why}`, "blank");
  if (!touring) skipCard(c.widget.type, Date.now() + RUNTIME_SKIP_MS); // he never sees it again until it works
  const b = c.el.querySelector(".card-body");
  if (b.querySelector(".card-fallback")) return;
  const p = document.createElement("p");
  p.className = "empty card-fallback";
  p.textContent = `${c.el.querySelector(".card-head span").textContent} ${why}. It tries again in a minute.`;
  b.appendChild(p);
  setTimeout(() => { p.remove(); try { c.inst.update(state); } catch (e) { noteError(e); } }, 60000);
}
// Content taller than its card (a short landscape screen, a long list): the whole body is scaled down around its
// centre until it fits, never below 55 %, so nothing is cut off.
function fitCard(c) {
  if (!c) return;
  const b = c.el.querySelector(".card-body");
  b.style.transform = "";
  // measured in screen pixels (the card may be mid-entrance, scaled): the in-flow children's extent against the
  // body's inner height, both under the same transform
  const r = b.getBoundingClientRect();
  if (!r.height || !b.offsetHeight) return;
  const k = r.height / b.offsetHeight, cs = getComputedStyle(b);
  const inner = r.height - (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) * k;
  let top = Infinity, bottom = -Infinity;
  for (const n of b.querySelectorAll(":scope > *, :scope > * > *")) {
    if (getComputedStyle(n).position === "absolute" || n.closest(".wx-scene, .clock-sky")) continue;
    const q = n.getBoundingClientRect();
    if (!q.height) continue;
    top = Math.min(top, q.top); bottom = Math.max(bottom, q.bottom);
  }
  const need = bottom - top;
  if (need > inner + 2) b.style.transform = `scale(${Math.max(0.55, inner / need).toFixed(3)})`;
}
window.addEventListener("resize", () => fitCard(cards[idx]));

function brokenCard(el, title) {
  el.querySelector(".card-body").innerHTML = `<p class="empty card-fallback">${title} could not start on this phone.</p>`;
  return { update() {} };
}

function scheduleCycle() {
  clearTimeout(cycleTimer);
  if (touring) return;
  const secs = activeLayout().cycleSeconds || 12;
  cycleTimer = setTimeout(() => {
    if (focus.cur || Date.now() < holdUntil || speaking) return scheduleCycle();
    show(okIdx(idx, 1));
  }, secs * 1000);
}

// ---------- cards left out of the cycle (a failed self-test, or a card that broke on screen) ----------
// dash.skip: { type: until-ms }. A self-test failure stays until a later self-test passes the card; a card that
// broke on screen comes back after 30 minutes (and the next self-test decides).
const LS_SKIP = "dash.skip";
const RUNTIME_SKIP_MS = 30 * 60000;
const UNTIL_RETEST = 8.64e15;
let skips = load(LS_SKIP) || {};
const skipped = (type) => (skips[type] || 0) > Date.now();
// a card with nothing of its own to show (no alarms, no photos, an empty board, no verse yet) only says how to fill
// it: it stays out of the cycle until it has content, so the screen never shows a shell
function isEmpty(c) {
  const b = c.el.querySelector(".card-body");
  return !!b && [...b.querySelectorAll(".empty:not(.card-fallback)")].some((e) => e.textContent.trim() && getComputedStyle(e).display !== "none");
}
function skipCard(type, until) {
  if ((skips[type] || 0) >= until) return;
  skips = { ...skips, [type]: until };
  save(LS_SKIP, skips);
}
// the next card from i in direction dir (or i itself when self) that is not left out; all left out = plain next
function okIdx(i, dir = 1, self = false) {
  const n = cards.length;
  if (!n) return 0;
  for (let k = self ? 0 : 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    if (touring || (!skipped(cards[j].widget.type) && !isEmpty(cards[j]))) return j;
  }
  return (((i + (self ? 0 : dir)) % n) + n) % n;
}

function goTo(type) {
  const i = cards.findIndex((c) => c.widget.type === type);
  if (i >= 0 && i !== idx) show(i);
  return i >= 0;
}

// ---------- state ----------
function applyState(next) {
  const prevCycle = activeLayout().cycleSeconds;
  const hadPhotos = state && Array.isArray(state.photos) ? new Set(state.photos.map((p) => p.id)) : null;
  const wxEv = state ? weatherEvent(state.weather, next.weather) : null;
  state = next;
  save(LS.state, state);
  document.body.dataset.theme = (state.settings && state.settings.theme) || "aurora";
  // the part of the screen the wall holder hides (styles.css --band), percent of the height; /holder in the bot
  const hb = state.settings && state.settings.holder;
  const band = Number.isFinite(hb) ? Math.max(0, Math.min(45, hb)) : 28;
  document.documentElement.style.setProperty("--band-p", `${band}vh`);
  document.body.classList.toggle("banded", band > 0); // the shorter cards get their wall layout (styles.css)
  applyMotion(state, activeLayout());
  if (!buildStage()) {
    for (const c of cards) c.inst.update(state);
    if (activeLayout().cycleSeconds !== prevCycle) show(idx, true); // a new /cycle takes effect now
  }
  alarms.set(state.alarms);
  syncFiles();
  nightCheck();
  topbar();
  bday.setState(state);
  if (hadPhotos) {
    for (const p of state.photos || []) if (!hadPhotos.has(p.id)) focus.push({ key: `photo:${p.id}`, widget: "photos", dur: 12000, photo: p.id });
  }
  // rain starting, thunder, a big temperature change: the weather card comes forward and plays its attention animation
  if (wxEv) focus.push({ key: `wx:${wxEv.kind}@${state.weather.at}`, widget: "weather", prio: PRIO.other, dur: 9000, ...wxEv });
}

function topbar() {
  const d = new Date();
  $("tb-clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("tb-date").textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const w = state.weather;
  $("tb-weather").textContent = w ? `${Math.round(w.current.temp)}° ${w.city}` : "";
}

// ---------- speech ----------
let speaking = false;
const speechQueue = [];

async function say(text) {
  speechQueue.push(text);
  if (speaking) return;
  speaking = true;
  while (speechQueue.length) {
    const t = speechQueue.shift();
    focus.push({ key: "speak", widget: "agent", prio: PRIO.agent, live: true });
    focusTick();
    const card = ctx.agentCard;
    if (card) { card.caption(t); card.setState("speaking"); }
    const words = setInterval(() => card && card.pulse(0.9), 260);
    await speak(t, { onWord: () => card && card.pulse(1) });
    clearInterval(words);
    if (card) card.setState("idle");
    holdUntil = Date.now() + 6000;
  }
  focus.push({ key: "speak", dur: 6000 }); // the answer stays readable a moment, then the cycle goes on
  speaking = false;
  scheduleCycle();
}

// ---------- event-driven cycle (focus.js) ----------
// Something happens on a widget -> that widget comes forward and holds the screen until the event and its animation
// are over; then the normal cycle goes on. Timed moments come forward LEAD_MS (3 s) early. Priority: ringing alarm,
// agent, prayer, the rest; overlapping events queue.
const focus = new FocusQueue();
const firedMoments = new Set();
const ymdKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// Today's (and the next midnight's) timed moments: { key, widget, prio, at, anim, kind }
function moments(now) {
  const out = [];
  const city = state.settings && state.settings.city;
  if (city && typeof city.lat === "number") {
    const d = sunDay(city, now);
    for (const [kind, at] of [["sunrise", d.today.rise], ["sunset", d.today.set], ["sunrise", d.tomorrow.rise]]) {
      if (at) out.push({ key: `${kind}@${ymdKey(at)}`, widget: "sun", prio: PRIO.other, at, anim: 14000, kind });
    }
  }
  const wn = wallNow();
  const b = state.prayer && prayerBoard(state.prayer, wn);
  if (b) for (const p of b.list) out.push({ key: `prayer:${p.key}@${b.day.date}`, widget: "prayer", prio: PRIO.prayer, at: now + (p.at - wn), anim: 10000, kind: "prayer", name: p.name });
  for (const a of state.alarms || []) {
    const at = nextFire(a, now);
    if (at) out.push({ key: `alarm:${a.id}@${at}`, widget: "alarms", prio: PRIO.alarm, at, anim: 2000, kind: a.kind || "alarm" });
  }
  // a birthday starts at midnight: the birthday card comes forward as the date turns
  const mid = new Date(now); mid.setHours(24, 0, 0, 0);
  const t = localYmd(new Date(mid.getTime() + 1000));
  if ((state.birthdays || []).some((p) => { const c = celebration(p, t); return c && c.today; })) {
    out.push({ key: `bday@${ymdKey(mid.getTime() + 1000)}`, widget: "age", prio: PRIO.other, at: mid.getTime(), anim: 15000, kind: "birthday" });
  }
  return out;
}

let focusShown = null;
function focusTick() {
  const now = Date.now();
  for (const m of dueMoments(moments(now), now, firedMoments)) {
    firedMoments.add(m.key);
    focus.push({ ...m, dur: Math.max(0, m.at - now) + m.anim }, now);
  }
  if (touring) return;
  const { cur } = focus.tick(now);
  if (cur && cur.widget && skipped(cur.widget) && !cur.live) { focus.release(cur.key); return focusTick(); } // a card left out does not come forward
  if (cur === focusShown) return;
  focusShown = cur;
  document.body.classList.toggle("focus-on", !!cur);
  if (!cur) return scheduleCycle(); // back to the normal cycle
  const i = cards.findIndex((c) => c.widget.type === cur.widget);
  if (i < 0) { focus.release(cur.key); focusShown = null; return focusTick(); } // that widget is not on this layout
  if (i !== idx) show(i);
  const c = cards[i];
  c.el.classList.remove("evt");
  void c.el.offsetWidth;
  c.el.classList.add("evt");
  setTimeout(() => c.el.classList.remove("evt"), 2600);
  if (!cur.played) { cur.played = true; if (c.inst.event) c.inst.event(cur); }
  window.__dash.focusLog.push({ key: cur.key, widget: cur.widget, prio: cur.prio, at: now });
}

// ---------- alarms ----------
let ringing = null;
let audioCtx = null;

function beepLoop() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = i === 2 ? 1046 : 880;
      g.gain.setValueAtTime(0, t0 + i * 0.25);
      g.gain.linearRampToValueAtTime(0.35, t0 + i * 0.25 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.25 + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.25);
      o.stop(t0 + i * 0.25 + 0.25);
    }
  } catch {}
}

function ring(a) {
  if (ringing) stopRing();
  bday.close(); // alarms win
  for (const k of focus.queue) if (k.startsWith(`alarm:${a.id}@`)) focus.release(k); // the ring takes over from its 3 s lead
  focus.push({ key: "ring", widget: "alarms", prio: PRIO.alarm, live: true });
  focusTick();
  const d = new Date();
  $("alarm-kind").textContent = a.kind === "reminder" ? "Reminder" : "Alarm";
  $("alarm-label").textContent = a.label;
  $("alarm-time").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("alarm").classList.remove("hidden");
  let n = 0;
  const loop = setInterval(() => {
    beepLoop();
    if (++n % 6 === 3) speak(`${a.kind === "reminder" ? "Reminder" : "Alarm"}: ${a.label}`);
    if (n > 60) stopRing();
  }, 1500);
  beepLoop();
  ringing = { a, loop };
  if (link) link.send({ type: "fired", id: a.id });
}

function stopRing() {
  focus.release("ring");
  if (!ringing) return;
  clearInterval(ringing.loop);
  stopSpeaking();
  ringing = null;
  $("alarm").classList.add("hidden");
}

const alarms = new AlarmEngine({ onRing: ring });

// ---------- birthday takeover (bdayshow.js): on the day on the hour and on wake, /birthday preview any time ----------
const hidden = (id) => $(id).classList.contains("hidden");
const bday = new BirthdayShow({
  el: $("bday"),
  // auto = on the day by itself: not over video or the camera, and in night mode only as the day starts (midnight),
  // not every hour of the night; nothing ever covers an alarm or a prayer call. It closes back to the dim clock.
  canShow: (auto, why) => !ringing && hidden("prayer-call") && (!auto || ((!nightOn || (why === "hour" && new Date().getHours() === 0)) && hidden("player") && !(camera && camera.busy))),
});

// ---------- photo frame / adhan files ----------
function syncFiles() {
  const ids = (state.photos || []).map((p) => p.id);
  const al = ((state.settings && state.settings.prayer) || {}).alarms || {};
  if (state.adhan && Object.values(al).includes("adhan")) ids.push(state.adhan.id);
  if (link && link.post) files.want(ids);
}

// ---------- dimming: two switches (night.js), counted on this phone's clock, the zone the clock widget shows ----------
// A) goodnight (from the bot or said to the phone): dim until the wake time, 07:00 by default.
// B) quiet hours: dim every night, 01:00-07:00 by default. Either one dims; neither cancels the other.
// Alarms, reminders, prayer calls and the birthday screen show above the dim clock and close back to it. A tap or
// /wake ends a goodnight; inside quiet hours it brightens the screen for 2 minutes, then it is dim again.
let nightOn = false;
let nightTapped = null; // the goodnight a tap ended here (until the hub's state catches up)
let tapBright = 0; // a tap in quiet hours: bright until (until the hub's quietWake arrives)
const nightKey = (n) => (n ? `${n.since || ""}|${n.until || ""}` : "");
function dimNow(now = Date.now()) {
  const n = state.night && nightKey(state.night) !== nightTapped ? state.night : null;
  const until = Math.max(tapBright, (state.quietWake && state.quietWake.until) || 0);
  return dimState({ ...state, night: n, quietWake: until ? { until } : null }, now, (ms) => wallNow(new Date(ms)));
}
function nightCheck() {
  const on = dimNow().dim;
  if (on !== nightOn) {
    nightOn = on;
    $("night").classList.toggle("hidden", !on);
    document.body.classList.toggle("is-night", on);
    ambient.sync();
  }
  if (!on) return;
  const d = new Date();
  $("night-clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("night-date").textContent = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  // move a little every minute: nothing stays lit on the same pixels all night
  if (d.getSeconds() === 0 || !$("night-box").style.transform) {
    const m = Math.floor(Date.now() / 60000);
    $("night-box").style.transform = `translate3d(${((m * 37) % 61) - 30}px, ${((m * 53) % 121) - 60}px, 0)`;
  }
}

// a tap on the dim clock: ends a goodnight (here at once, on the hub and so on every phone); in quiet hours the
// screen is bright for 2 minutes
$("night").addEventListener("click", () => {
  if (!nightOn) return;
  const d = dimNow();
  if (state.night) nightTapped = nightKey(state.night);
  if (d.inQuiet) tapBright = Date.now() + QUIET_WAKE_MS;
  nightCheck();
  if (link) link.send({ type: "wake" });
});

// ---------- prayer chime / adhan (off by default; /prayer alarm ...) ----------
const prayerFired = new Set();
let prayerAudio = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * 0.45);
      g.gain.linearRampToValueAtTime(0.25, t0 + i * 0.45 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.45 + 2.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.45);
      o.stop(t0 + i * 0.45 + 2.3);
    });
  } catch {}
}
function stopPrayerCall() {
  focus.release("prayer-call");
  if (prayerAudio) { prayerAudio.pause(); prayerAudio = null; }
  $("prayer-call").classList.add("hidden");
}
function prayerCall(p) {
  bday.close();
  for (const k of focus.queue) if (k.startsWith(`prayer:${p.key}@`)) focus.release(k);
  focus.push({ key: "prayer-call", widget: "prayer", prio: PRIO.prayer, live: true });
  focusTick();
  prayerFired.add(p.fired);
  $("pc-name").textContent = `${p.name} prayer`;
  $("pc-time").textContent = p.time;
  $("prayer-call").classList.remove("hidden");
  const url = p.mode === "adhan" && state.adhan && files.url(state.adhan.id);
  if (url) {
    prayerAudio = new Audio(url);
    prayerAudio.onended = () => setTimeout(stopPrayerCall, 20000);
    prayerAudio.play().catch(() => { chime(); say(`It is time for ${p.name} prayer.`); });
  } else {
    chime();
    setTimeout(() => say(`It is time for ${p.name} prayer.`), 2500);
    setTimeout(stopPrayerCall, 90000);
  }
  window.__dash.prayerCalls.push({ key: p.key, mode: p.mode, audio: !!url, at: Date.now() });
}
function prayerCheck() {
  const al = ((state.settings && state.settings.prayer) || {}).alarms;
  if (!al || !state.prayer) return;
  for (const p of duePrayers(state.prayer, al, wallNow(), prayerFired)) prayerCall(p);
}
$("pc-stop").addEventListener("click", stopPrayerCall);

// ---------- camera, playback, voice (only on the owner's command or tap; see camera.js) ----------
const rec = new RecIndicator();
let camera = null;
const player = new Player({ el: $("player"), onEvent: (state, err) => link && link.post && link.post({ t: "media", state, err }) });
let listening = false;

async function talk() {
  const card = ctx.agentCard;
  if (listening) return stopListening();
  if (!link || !link.post) return card && card.caption("Not connected to the hub.");
  listening = true;
  focus.push({ key: "listen", widget: "agent", prio: PRIO.agent, live: true });
  focusTick();
  $("mic").classList.remove("hidden");
  if (card) { card.setState("listening"); card.caption("Listening..."); }
  try {
    const text = await listen();
    if (!text) { if (card) { card.caption("I didn't catch that."); card.setState("idle"); } return; }
    if (card) card.caption(text);
    link.send({ type: "ask", text });
  } catch (e) {
    if (card) { card.caption(e.message); card.setState("idle"); }
  } finally {
    listening = false;
    focus.push({ key: "listen", dur: 4000 });
    $("mic").classList.add("hidden");
  }
}

// ---------- hub link ----------
function setLink(s) {
  const el = $("tb-link");
  el.className = "link " + (s === "on" ? "on" : s === "off" || s === "unpaired" ? "off" : "");
  el.title = s;
  window.__dash.link = s;
}

async function forgetPairing() {
  if (camera) camera.stop();
  player.stop();
  if (link) link.stop();
  link = null;
  localStorage.removeItem(LS.hub);
  localStorage.removeItem(LS.relay);
  localStorage.removeItem(LS.relayKey);
  await keyVault.forget().catch(() => {});
}

function connect(cfg, secretKey = null) {
  if (link) link.stop();
  link = secretKey
    ? new RelayLink({ cfg, secretKey, save: (c) => save(LS.relay, c), getState: () => state, getStatus: devStatus })
    : new HubLink(cfg);
  link.addEventListener("status", (e) => {
    setLink(e.detail);
    if (e.detail === "on") setTimeout(syncFiles, 1500); // after the hello and the state it brings
    if (e.detail === "unpaired") forgetPairing().then(() => showPair("This phone was unpaired. Pair again."));
  });
  link.addEventListener("message", (e) => {
    const m = e.detail;
    if (m.type === "state") applyState(m.state);
    else if (m.type === "speak") say(m.text);
    else if (m.type === "agent" && ctx.agentCard) {
      if (m.state === "idle") focus.push({ key: "agent", widget: "agent", prio: PRIO.agent, dur: 4000 });
      else focus.push({ key: "agent", widget: "agent", prio: PRIO.agent, live: true });
      focusTick();
      ctx.agentCard.setState(m.state);
    }
    else if (m.type === "ui-bundle") onUiBundle(m, { link, isQuiet: () => !speaking && !ringing && !(camera && camera.busy) });
    else if (m.type === "cam" && camera) camera.run(m);
    else if (m.type === "play") player.play(m.url);
    else if (m.type === "stop") { if (camera) camera.stop(); player.stop(); }
    else if (m.type === "file") files.add(m).catch(() => {});
    else if (m.type === "selftest") selfTest("manual", m.id);
  });
  if (camera) camera.stop();
  camera = secretKey ? new Camera({ link, rec }) : null; // camera only over the sealed relay link
  ctx.onTalk = talk;
  link.start();
}

// ---------- pairing + settings ----------
function relayUrl() {
  const q = new URLSearchParams(location.search).get("relay"); // tests and development only
  return (q || localStorage.getItem(LS.relayUrl) || DEFAULT_RELAY).replace(/\/$/, "");
}

function showPair(msg = "") {
  $("pair").classList.remove("hidden");
  $("pair-err").textContent = msg;
  const r = $("pair-relay");
  if (!r.value) r.value = relayUrl();
}

let pairing = false;
$("pair-go").addEventListener("click", async () => {
  if (pairing) return;
  const relay = ($("pair-relay").value.trim() || DEFAULT_RELAY).replace(/\/$/, "");
  const code = normPairCode($("pair-code").value);
  $("pair-err").textContent = "";
  if (!/^(https:\/\/[^\s/]+|http:\/\/127\.0\.0\.1:\d+)$/.test(relay)) return ($("pair-err").textContent = "Relay address looks like https://ntfy.sh");
  if (!code) return ($("pair-err").textContent = "The code has 16 letters and digits, like K7QM-2XRP-9TWD-HV4C.");
  pairing = true;
  $("pair-go").textContent = "Pairing...";
  try {
    const r = await pairViaRelay({ base: relay, code, name: "dashboard-phone", timeoutMs: 45000 });
    await forgetPairing();
    localStorage.setItem(LS.relayKey, JSON.stringify(await keyVault.wrap(b64u(r.secretKey))));
    save(LS.relay, r.cfg);
    if (relay !== DEFAULT_RELAY) localStorage.setItem(LS.relayUrl, relay);
    $("pair").classList.add("hidden");
    $("pair-code").value = "";
    if (r.cfg.uiPub && window.__shell) window.__shell.pinKey(r.cfg.uiPub);
    $("paired-fp").textContent = r.cfg.fp;
    $("paired").classList.remove("hidden");
    connect(r.cfg, r.secretKey);
    reportUi(link);
  } catch (e) {
    $("pair-err").textContent = `Pairing failed: ${e.message}`;
  } finally {
    pairing = false;
    $("pair-go").textContent = "Pair";
  }
});
$("paired-ok").addEventListener("click", () => $("paired").classList.add("hidden"));
$("paired-bad").addEventListener("click", async () => {
  $("paired").classList.add("hidden");
  await forgetPairing();
  setLink("off");
  showPair("Pairing forgotten. Send /unpair to the bot for that device, then /pair again.");
});

// Long-press the top bar for 2 s: settings.
let pressTimer = null;
$("topbar").addEventListener("pointerdown", () => {
  pressTimer = setTimeout(() => {
    const rc = load(LS.relay);
    const cfg = load(LS.hub);
    $("set-info").textContent = rc
      ? `Relay ${rc.relay.replace(/^https?:\/\//, "")} - device ${rc.id} - fingerprint ${rc.fp} - link ${link ? link.status : "-"} - key ${keyVault.kind} - UI v${window.__shell ? window.__shell.active() : "?"}`
      : cfg ? `Hub ${cfg.url} - device ${cfg.deviceId || "?"} - link ${link ? link.status : "-"}` : "Not paired.";
    $("settings").classList.remove("hidden");
  }, 2000);
});
["pointerup", "pointerleave", "pointercancel"].forEach((ev) => $("topbar").addEventListener(ev, () => clearTimeout(pressTimer)));
$("set-close").addEventListener("click", () => $("settings").classList.add("hidden"));
$("set-unpair").addEventListener("click", async () => {
  await forgetPairing();
  $("settings").classList.add("hidden");
  setLink("off");
  showPair();
});
$("alarm-stop").addEventListener("click", stopRing);

// Tap / swipe the stage to move between widgets.
let sx = 0;
$("stage").addEventListener("pointerdown", (e) => { sx = e.clientX; });
$("stage").addEventListener("pointerup", (e) => {
  const dx = e.clientX - sx;
  if (e.target.closest("button, iframe") || touring) return;
  show(okIdx(idx, dx > 40 ? -1 : 1));
});

// ---------- boot ----------
// ---------- performance on this phone (perf.js): measured, sent to the hub, low power when it stays slow ----------
const perf = new PerfMeter({
  send: (m) => link && link.post && link.post(m),
  onLow: () => applyMotion(state, activeLayout()),
  card: () => (cards[idx] ? cards[idx].widget.type : ""),
});
perf.start();

// ---------- errors to the hub (diag.js) and the self-test tour (selftest.js) ----------
const uiV = () => (window.__shell ? window.__shell.active() : null);
const overlay = () => ["alarm", "bday", "player", "prayer-call", "night"].find((id) => !hidden(id));
const diag = new Diag({
  send: (m) => (link && link.post ? link.post(m) : false),
  card: () => overlay() || (cards[idx] ? cards[idx].widget.type : ""),
  ui: uiV,
});
diag.install();

const LS_TESTED = "dash.selftestV";
const RETEST_MS = 3 * 3600000; // cards left out are tested again every 3 hours
let touring = false;
let lastTour = 0;
// why: "manual" (/selftest), "after-push" (first start of a new UI version), "retest" (cards are left out)
async function selfTest(why, id = `t${Date.now().toString(36)}`) {
  const post = (m) => link && link.post && link.post({ t: "selftest", id, why, ui: uiV(), ...m });
  if (touring) return;
  if (ringing || (camera && camera.busy) || !hidden("player") || !hidden("prayer-call")) return post({ busy: "the phone is busy (alarm, camera, video or prayer call); send /selftest again later" });
  touring = true;
  lastTour = Date.now();
  clearTimeout(cycleTimer);
  const back = idx;
  const nightWas = !hidden("night");
  $("night").classList.add("hidden"); // the cards must really draw; the dim clock comes back after
  bday.close();
  const badge = document.createElement("div");
  badge.className = "selftest-badge";
  badge.dataset.nosnap = "1";
  document.body.appendChild(badge);
  try {
    const r = await runSelfTest({
      cards: cards.map((c) => ({ type: c.widget.type, el: c.el })), show: (i) => show(i), isBlank, diag, badge,
      restore: () => {},
    });
    for (const row of r.rows) {
      if (row.ok) delete skips[row.card]; else skips[row.card] = UNTIL_RETEST;
    }
    save(LS_SKIP, skips);
    if (why === "after-push") localStorage.setItem(LS_TESTED, String(uiV()));
    window.__dash.lastSelfTest = r;
    const f = perf.facts || {};
    await post({ rows: r.rows, shots: r.shots, shotErr: r.shotErr, low: document.body.classList.contains("lowpower"),
      webview: (/Chrome\/([\d.]+)/.exec(navigator.userAgent) || [])[1] || "", gpu: f.gpu || "", w: window.innerWidth, h: window.innerHeight });
    if (r.jpeg && link && link.upload) await link.upload({ id, kind: "selftest", i: 0, n: 1, mime: "image/jpeg" }, r.jpeg);
    // every card's own PNG, in parts of up to 1.9 MB (one relay message each)
    if (r.pack && link && link.upload) {
      const P = 1900 * 1024, n = Math.ceil(r.pack.length / P);
      if (n <= 6) for (let i = 0; i < n; i++) await link.upload({ id, kind: "captures", i, n, orient: window.innerWidth > window.innerHeight ? "landscape" : "portrait" }, r.pack.subarray(i * P, (i + 1) * P));
    }
  } catch (e) {
    noteError(e, "selftest");
    post({ busy: `the self-test stopped: ${String((e && e.message) || e).slice(0, 160)}` });
  } finally {
    badge.remove();
    touring = false;
    if (nightWas) $("night").classList.remove("hidden");
    show(okIdx(back, 1, true), true);
  }
}
// once by itself after a new UI version starts (when the screen is not dimmed and nothing else is on), and again
// every 3 hours while cards are left out
setInterval(() => {
  if (touring || !link || link.status !== "on" || nightOn || overlay() || focus.cur || speaking) return;
  const v = uiV();
  if (v != null && localStorage.getItem(LS_TESTED) !== String(v)) return selfTest("after-push");
  if (Object.values(skips).some((u) => u > Date.now()) && Date.now() - lastTour > RETEST_MS) selfTest("retest");
}, 20000);

window.__dash = { perf, diag, selfTest, get skips() { return skips; }, get touring() { return touring; }, isBlank: (t) => { const c = cards.find((x) => x.widget.type === t); return c ? isBlank(c.el) : null; }, dimNow, get nightOn() { return nightOn; }, spoken, rec, player, talk, files, prayerCalls: [], devStatus, bday, focus, focusTick, focusLog: [], applyState, moments: () => moments(Date.now()), get camera() { return camera; }, get state() { return state; }, goTo, show: (i) => show(i), say, ring, stopRing, link: "none", estimateMs,
  get index() { return idx; }, get debug() { return { holdUntil, speaking, speechQueue: speechQueue.length, now: Date.now() }; }, get cards() { return cards.map((c) => c.widget.type); } };

applyState(state);
// Drawn: tell the shell this UI bundle works (ends the trial of a newly pushed one).
if (window.__shell) window.__shell.healthy();
setInterval(() => {
  topbar();
  const c = cards[idx];
  if (c && c.inst.tick) c.inst.tick(state);
  alarms.check();
  nightCheck();
  prayerCheck();
  bday.tick(state);
  focusTick();
  if (new Date().getSeconds() === 0) ambient.sync(); // fireflies come out at 19:00
  // burn-in: the stage moves a few px every 10 minutes (one relayout, no animating layer)
  const m10 = Math.floor(Date.now() / 600000);
  if (m10 !== burnStep) { burnStep = m10; $("stage").style.margin = `${(m10 * 7) % 9 - 4}px ${(m10 * 5) % 9 - 4}px`; }
}, 1000);

// Clock, age counter and alarms run from the cached state with or without the link.
async function boot() {
  const rc = load(LS.relay);
  const wrapped = load(LS.relayKey);
  if (rc && wrapped) {
    try {
      connect(rc, unb64u(await keyVault.unwrap(wrapped)));
      return reportUi(link);
    } catch {
      await forgetPairing();
      setLink("off");
      return showPair("The pairing key could not be unlocked. Pair again.");
    }
  }
  const cfg = load(LS.hub);
  if (cfg && cfg.token) return connect(cfg);
  setLink("off");
  showPair();
}
boot();
