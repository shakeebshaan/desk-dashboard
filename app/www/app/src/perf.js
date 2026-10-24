// Performance on the real phone: frame rate, long frames, memory, the WebView and GPU, page errors, sent to the hub
// (relay {t:"perf"}) and logged there. Turns low power on (body.lowpower: decorations stop, motion.js) when the
// phone keeps drawing under LOW_FPS. The meter samples in windows (the shared frame loop, motion.js nextFrame) so it
// costs almost nothing between them.
import { nextFrame, errors } from "./motion.js"; // page errors are caught by diag.js

export const LOW_FPS = 40;
const WINDOW_MS = 8000;
const LS_LOW = "dash.lowpower"; // remembered for a day, so a restart does not begin with a slow minute
const DAY = 86400000;

// Static facts, once: WebView (Chrome) and Android versions, GPU, memory, screen.
function facts() {
  const ua = navigator.userAgent || "";
  let gpu = "";
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (gl) {
      const x = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 80);
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
  } catch { /* no WebGL */ }
  return {
    webview: (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || "",
    android: (/Android ([\d.]+)/.exec(ua) || [])[1] || "",
    gpu,
    devMem: navigator.deviceMemory || null,
    cores: navigator.hardwareConcurrency || null,
    dpr: window.devicePixelRatio || 1,
  };
}

export class PerfMeter {
  constructor({ send, onLow = () => {}, card = () => "" }) {
    Object.assign(this, { send, onLow, card });
    this.facts = null;
    this.history = []; // last windows: { fps, long, worst, at }
    this.low = false;
    this.lastSent = 0;
    this.timer = 0;
  }

  start() {
    const t = +localStorage.getItem(LS_LOW) || 0;
    if (Date.now() - t < DAY) this.setLow(true, "remembered");
    this.timer = setTimeout(() => this.sample(), 4000);
  }

  setLow(on, why) {
    if (on === this.low) return;
    this.low = on;
    document.body.classList.toggle("lowpower", on);
    if (on) localStorage.setItem(LS_LOW, String(Date.now())); else localStorage.removeItem(LS_LOW);
    this.onLow(on, why);
  }

  // One window: count frames and the gaps between them.
  sample() {
    clearTimeout(this.timer);
    if (document.hidden) { this.timer = setTimeout(() => this.sample(), 30000); return; }
    let frames = 0, long = 0, worst = 0, prev = 0;
    const t0 = performance.now();
    const step = (now) => {
      if (prev) { const gap = now - prev; if (gap > 50) long++; if (gap > worst) worst = gap; }
      prev = now;
      frames++;
      if (now - t0 < WINDOW_MS) nextFrame(step);
      else this.done({ fps: Math.round(((frames - 1) * 1000) / Math.max(1, now - t0)), long, worst: Math.round(worst) });
    };
    nextFrame(step);
  }

  done(w) {
    w.at = Date.now();
    this.history.push(w);
    if (this.history.length > 6) this.history.shift();
    const last2 = this.history.slice(-2);
    let changed = false;
    if (!this.low && last2.length === 2 && last2.every((x) => x.fps < LOW_FPS)) { this.setLow(true, `under ${LOW_FPS} fps twice`); changed = true; }
    // report: the first window, a switch to low power, then every 5 minutes
    if (changed || !this.lastSent || Date.now() - this.lastSent > 5 * 60000) this.report(w, changed);
    // sample often in the first minutes, then every 2 minutes
    const early = this.history.length < 4;
    this.timer = setTimeout(() => this.sample(), early ? 6000 : 120000);
  }

  report(w, switched = false) {
    if (!this.facts) this.facts = facts();
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    let anims = null;
    try { anims = document.getAnimations ? document.getAnimations().length : null; } catch { /* old WebView */ }
    this.lastSent = Date.now();
    this.send({
      t: "perf", ...this.facts, fps: w.fps, long: w.long, worst: w.worst, low: this.low, switched,
      mem, nodes: document.getElementsByTagName("*").length, anims, card: this.card(),
      w: window.innerWidth, h: window.innerHeight, errors: errors.slice(-4),
    });
  }
}
