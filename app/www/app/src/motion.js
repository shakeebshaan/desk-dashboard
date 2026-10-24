// Motion layer shared by the widgets: the motion level, rolling digits, bursts, and the ambient sky extras
// (shooting stars, fireflies at night, a faint tilt parallax). Built for an old phone that is always on:
// only transform/opacity animate, particle counts are capped, nothing runs while it cannot be seen.
//
// Level: "full" (default) | "calm" (no particles, no shake, no parallax) | "off" (no motion at all).
// Comes from the hub: the active layout's `motion`, else settings.motion (/motion in the bot); the phone's
// system "reduce motion" switch always wins with "off".

const LEVELS = ["full", "calm", "off"];
const sysReduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function motionLevel() {
  const v = document.body.dataset.motion;
  return sysReduced() ? "off" : LEVELS.includes(v) ? v : "full";
}

// ---------- one requestAnimationFrame loop for everything (count-ups, the 3D agent, particles, the fps meter) ----------
// nextFrame(cb)/cancelFrame(id) work like requestAnimationFrame/cancelAnimationFrame, but every callback of a frame runs from a
// single native frame callback, and a callback that throws is dropped (and reported) instead of killing the page.
const frameQ = new Map();
let frameSeq = 0, frameNative = 0;
export const errors = []; // the last few page errors, for the perf report to the hub
let errorSink = null; // diag.js: every error also goes to the hub's error log
export function setErrorSink(fn) { errorSink = fn; }
export function noteError(e, kind) {
  errors.push(String((e && (e.stack || e.message)) || e).slice(0, 240));
  if (errors.length > 6) errors.shift();
  if (errorSink) { try { errorSink(e, kind); } catch { /* never throws back into a widget */ } }
}
function flushFrame(now) {
  frameNative = 0;
  const run = [...frameQ.values()];
  frameQ.clear();
  for (const cb of run) { try { cb(now); } catch (e) { noteError(e); } }
}
export function nextFrame(cb) {
  const id = ++frameSeq;
  frameQ.set(id, cb);
  if (!frameNative) frameNative = requestAnimationFrame(flushFrame);
  return id;
}
export function cancelFrame(id) { frameQ.delete(id); }

// Low power (perf.js turns it on when the phone keeps drawing under 40 fps): decorations stop, as with "off".
export const lowPower = () => document.body.classList.contains("lowpower");
export const moving = () => motionLevel() !== "off";
export const lively = () => motionLevel() === "full";

export function applyMotion(state, layout) {
  const want = (layout && layout.motion) || (state.settings && state.settings.motion) || "full";
  const lvl = lowPower() ? "off" : LEVELS.includes(want) ? want : "full";
  if (document.body.dataset.motion !== lvl) document.body.dataset.motion = lvl;
  ambient.sync();
}

// ---------- rolling digits (odometer) ----------
// roll(el, "12:07") draws one column per character; a changed digit rolls up to its new value. Columns that do
// not change stay still, so a clock only moves the digit that changed.
export function roll(el, text) {
  text = String(text);
  if (el.dataset.roll === text) return;
  const prev = el.dataset.roll || "";
  el.dataset.roll = text;
  if (!moving() || prev.length !== text.length || !el.firstElementChild) {
    el.innerHTML = [...text].map((c) => (/\d/.test(c) ? `<span class="odo"><b>${c}</b></span>` : `<span class="odo-sep">${c}</span>`)).join("");
    el.setAttribute("aria-label", text);
    return;
  }
  el.setAttribute("aria-label", text);
  [...text].forEach((c, i) => {
    if (c === prev[i]) return;
    const col = el.children[i];
    if (!col || !col.classList.contains("odo")) return;
    // old digit leaves upward, the new one comes in from below; the old node is dropped when it is done
    const old = col.lastElementChild;
    const nu = document.createElement("b");
    nu.textContent = c;
    nu.className = "odo-in";
    old.className = "odo-out";
    col.appendChild(nu);
    setTimeout(() => { if (old.parentNode === col) old.remove(); nu.className = ""; }, 560);
  });
}

// ---------- burst: confetti / sparkles flying out from a point, removed when done ----------
const BURST_COLORS = ["var(--a1)", "var(--a2)", "var(--a3)", "#ffd56b", "#7cc4ff", "#ffffff"];
export function burst(host, { n = 18, x = "50%", y = "45%", kind = "confetti", spread = 140 } = {}) {
  if (!lively() || !host || !host.isConnected) return;
  const box = document.createElement("div");
  box.className = `fx-burst ${kind}`;
  box.style.left = x;
  box.style.top = y;
  n = Math.min(n, 28);
  let html = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (i % 3) * 0.3;
    const d = spread * (0.55 + ((i * 37) % 45) / 100);
    html += `<i style="--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d - spread * 0.25)}px;--r:${(i % 2 ? -1 : 1) * (120 + i * 23)}deg;background:${BURST_COLORS[i % BURST_COLORS.length]};animation-delay:${(i % 4) * 0.03}s"></i>`;
  }
  box.innerHTML = html;
  host.appendChild(box);
  setTimeout(() => box.remove(), 1700);
}

// ---------- count up: numbers in [data-n] grow from 0 to their value (eased), once ----------
const fmt = (n) => Math.round(n).toLocaleString("en-US");
export function countUp(root, ms = 1100) {
  const els = [...root.querySelectorAll("[data-n]")];
  if (!moving()) { for (const n of els) n.textContent = fmt(+n.dataset.n); return () => {}; }
  let raf = 0;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    for (const n of els) n.textContent = fmt(+n.dataset.n * e);
    if (k < 1) raf = nextFrame(step);
  };
  for (const n of els) n.textContent = "0";
  raf = nextFrame(step);
  return () => cancelFrame(raf);
}

// ---------- moon phase (0 new .. 0.5 full .. 1 new), good to a few hours ----------
export function moonPhase(ms = Date.now()) {
  const SYN = 29.530588853 * 86400000;
  const ref = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
  return ((((ms - ref) % SYN) + SYN) % SYN) / SYN;
}
// A moon drawn with two discs: the lit disc and a dark one slid across it by the phase.
export function moonHtml(phase = moonPhase(), cls = "") {
  const waxing = phase < 0.5;
  const lit = (1 - Math.cos(2 * Math.PI * phase)) / 2; // lit fraction: 0 new .. 1 full
  const shift = Math.round(lit * 100) * (waxing ? -1 : 1); // waxing: lit on the right, the shadow slides off to the left
  return `<div class="moon ${cls}" title="moon ${Math.round(lit * 100)}% lit"><i style="transform:translate3d(${shift}%,0,0)"></i></div>`;
}

// ---------- ambient sky extras ----------
// Fireflies live inside .sky (behind the cards) between 19:00 and 06:00; a shooting star crosses above everything
// now and then (it is gone in a second, so it hides nothing); the sky slides a few px with the phone's tilt.
// All of it stops while the app is in the background, in night mode, or below "full" motion.
export const ambient = {
  el: null, shootEl: null, starTimer: 0, tiltOn: false, raf: 0, tx: 0, ty: 0, cx: 0, cy: 0, nightFlies: null,
  mount() {
    if (this.el) return;
    const sky = document.querySelector(".sky");
    if (!sky) return;
    this.el = document.createElement("div");
    this.el.className = "fx-flies fx-p";
    sky.appendChild(this.el);
    this.shootEl = document.createElement("div");
    this.shootEl.className = "fx-shoot fx-p";
    this.shootEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.shootEl);
    document.addEventListener("visibilitychange", () => this.sync());
  },
  sync() {
    this.mount();
    if (!this.el) return;
    const on = lively() && !document.hidden && !document.body.classList.contains("is-night");
    if (!on) { clearTimeout(this.starTimer); this.starTimer = 0; }
    else if (!this.starTimer) this.starTimer = setTimeout(() => this.shoot(), 8000 + Math.random() * 25000);
    const h = new Date().getHours();
    const flies = on && (h >= 19 || h < 6);
    if (flies !== this.nightFlies) {
      this.nightFlies = flies;
      this.el.innerHTML = flies
        ? Array.from({ length: 9 }, (_, i) => `<i style="left:${8 + ((i * 41) % 84)}%;top:${30 + ((i * 29) % 60)}%;animation-delay:-${(i * 1.7).toFixed(1)}s,-${(i * 0.9).toFixed(1)}s;animation-duration:${11 + (i % 4) * 3}s,${2.6 + (i % 3) * 0.7}s"></i>`).join("")
        : "";
    }
    this.tilt(on);
  },
  shoot() {
    this.starTimer = 0;
    if (!lively() || document.hidden || !this.shootEl) return;
    const star = document.createElement("i");
    star.style.top = `${3 + Math.random() * 28}%`;
    star.style.left = `${25 + Math.random() * 70}%`;
    this.shootEl.appendChild(star);
    setTimeout(() => star.remove(), 1600);
    this.starTimer = setTimeout(() => this.shoot(), 35000 + Math.random() * 60000);
  },
  onTilt: null,
  tilt(on) {
    if (on === this.tiltOn || typeof window.DeviceOrientationEvent === "undefined") return;
    this.tiltOn = on;
    const sky = document.querySelector(".sky");
    if (!on) {
      window.removeEventListener("deviceorientation", this.onTilt);
      cancelFrame(this.raf);
      if (sky) sky.style.transform = "";
      return;
    }
    this.onTilt = this.onTilt || ((e) => {
      if (e.gamma == null) return;
      this.tx = Math.max(-1, Math.min(1, e.gamma / 30)) * 12;
      this.ty = Math.max(-1, Math.min(1, (e.beta - 60) / 30)) * 10;
      if (!this.raf) this.raf = nextFrame(() => this.step());
    });
    window.addEventListener("deviceorientation", this.onTilt);
  },
  step() {
    this.raf = 0;
    const sky = document.querySelector(".sky");
    this.cx += (this.tx - this.cx) * 0.08;
    this.cy += (this.ty - this.cy) * 0.08;
    if (sky) sky.style.transform = `translate3d(${this.cx.toFixed(1)}px,${this.cy.toFixed(1)}px,0)`;
    if (Math.abs(this.tx - this.cx) > 0.3 || Math.abs(this.ty - this.cy) > 0.3) this.raf = nextFrame(() => this.step());
  },
};

// ---------- odometer: every digit column spins a full turn and lands on its digit, right to left ----------
const STRIP = "01234567890123456789".split("").map((d) => `<b>${d}</b>`).join("");
export function odometer(el, text) {
  text = String(text);
  el.setAttribute("aria-label", text);
  if (!moving()) { el.textContent = text; return; }
  const chars = [...text];
  el.innerHTML = chars.map((c) => (/\d/.test(c) ? `<span class="odm"><span class="odm-s">${STRIP}</span></span>` : `<span class="odm-sep">${c}</span>`)).join("");
  const cols = [...el.querySelectorAll(".odm-s")];
  const digits = chars.filter((c) => /\d/.test(c));
  nextFrame(() => nextFrame(() => cols.forEach((s, i) => {
    s.style.transitionDelay = `${(cols.length - 1 - i) * 0.09}s`;
    s.style.transform = `translate3d(0, ${-(10 + +digits[i]) * 5}%, 0)`; // 20 digits: each is 5% of the strip
  })));
}
