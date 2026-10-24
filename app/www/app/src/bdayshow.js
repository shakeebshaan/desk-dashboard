// Full-screen birthday takeover: a different screen for each kind of person (age.js celebration()):
//   newborn  pastel night sky, drifting clouds, moon, twinkling stars, tiny footprints, "Happy 3 months"
//   toddler  bright cartoon sky, bouncing balloons, a parade of animals and cars, the age popping in, confetti
//   female   rose-gold, falling petals, sparkles, a cake whose candles flicker
//   head     royal gold, a crown dropping in, fireworks, gold particles rising
//   default  party (kids 5-12, adult men): rising balloons, streaming confetti, the age in a star
// On the day it shows on the hour and when the screen wakes; /birthday preview shows one for 30 s. Tap closes it,
// alarms and prayer calls sit above it. Old phone: the scene is CSS (transform/opacity), particles are one canvas
// capped at 30 fps and ~70 particles, nothing runs while it is closed; motion "calm" drops the canvas, "off" stills it.
import { celebration, localYmd } from "./age.js";
import { motionLevel, nextFrame, cancelFrame } from "./motion.js";

const DAY_MS = 45 * 1000; // per person, on the day
const WAKE_GAP_MS = 10 * 60 * 1000; // a screen wake shows it again at most this often
const FRAME_MS = 1000 / 30;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Decorative layers per kind (static markup; names and wording are set with textContent).
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("");
const SCENES = {
  newborn: () => `
    <i class="bs-moon"></i>
    ${rep(3, (i) => `<i class="bs-cloud" style="--i:${i}"></i>`)}
    ${rep(14, (i) => `<i class="bs-star" style="left:${(i * 37) % 96 + 2}%;top:${(i * 23) % 48 + 4}%;--d:${(i % 5) * 0.7}s"></i>`)}
    <div class="bs-feet">${rep(6, (i) => `<i style="--i:${i}">\u{1F463}</i>`)}</div>
    <i class="bs-toy">\u{1F9F8}</i>`,
  toddler: () => `
    ${rep(7, (i) => `<i class="bs-balloon" style="left:${6 + i * 13}%;--c:${["#ff4d6d", "#ffbe0b", "#3a86ff", "#06d6a0", "#ff7b00", "#b5179e", "#4cc9f0"][i]};--d:${(i % 4) * 0.35}s;--h:${18 + (i % 3) * 8}px"></i>`)}
    <div class="bs-parade">${["\u{1F418}", "\u{1F697}", "\u{1F981}", "\u{1F682}", "\u{1F422}", "\u{1F692}", "\u{1F992}", "\u{1F69C}"].map((e, i) => `<i style="--i:${i}">${e}</i>`).join("")}</div>`,
  female: () => `
    ${rep(12, (i) => `<i class="bs-spark" style="left:${(i * 41) % 92 + 4}%;top:${(i * 29) % 70 + 6}%;--d:${(i % 6) * 0.5}s"></i>`)}
    <div class="bs-cake"><i class="bs-cake-base"></i><i class="bs-cake-mid"></i><i class="bs-cake-top"></i>
      ${rep(3, (i) => `<i class="bs-candle" style="--i:${i}"><b></b></i>`)}</div>`,
  head: () => `
    <i class="bs-rays"></i>
    <i class="bs-crown">\u{1F451}</i>`,
  default: () => `
    ${rep(6, (i) => `<i class="bs-balloon rise" style="left:${8 + i * 16}%;--c:${["#38e1d0", "#8b6cff", "#ff6fae", "#ffd56b", "#7cc4ff", "#ff8f5a"][i]};--d:${-i * 1.3}s;--h:${20 + (i % 3) * 6}px"></i>`)}
    <i class="bs-starburst"></i>`,
};

// ---------- particles: one canvas, 30 fps, per-kind behaviour ----------
const PALETTE = {
  newborn: ["#fff6c9", "#ffd6e7", "#cfe6ff"],
  toddler: ["#ff4d6d", "#ffbe0b", "#3a86ff", "#06d6a0", "#ff7b00", "#b5179e"],
  female: ["#ffc2d1", "#ffb3c6", "#f7c6b0", "#ff8fab", "#fde2e4"],
  head: ["#ffd700", "#ffe58a", "#f5b700", "#fff3c4", "#ff9f1c", "#ffffff"],
  default: ["#38e1d0", "#8b6cff", "#ff6fae", "#ffd56b", "#7cc4ff", "#ffffff"],
};

class Particles {
  constructor(canvas) { this.c = canvas; this.g = canvas.getContext("2d"); this.raf = 0; this.ps = []; }
  start(kind) {
    this.stop();
    this.kind = kind;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = this.c.clientWidth; this.h = this.c.clientHeight;
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ps = [];
    this.t0 = performance.now(); this.last = 0; this.nextRocket = 0;
    const n = { newborn: 18, toddler: 0, female: 34, head: 26, default: 46 }[kind];
    for (let i = 0; i < n; i++) this.ps.push(this.spawn(true));
    if (kind === "toddler") this.pop(this.w / 2, this.h * 0.36, 60, 7); // the big confetti burst behind the age
    const loop = (now) => {
      this.raf = nextFrame(loop);
      if (now - this.last < FRAME_MS) return; // 30 fps cap
      const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
      this.last = now;
      this.step(now, dt);
    };
    this.raf = nextFrame(loop);
  }
  stop() { cancelFrame(this.raf); this.raf = 0; this.ps = []; if (this.g) this.g.clearRect(0, 0, this.c.width, this.c.height); }

  spawn(anywhere) {
    const { w, h, kind } = this;
    const col = pick(PALETTE[kind]);
    const y = anywhere ? rnd(0, h) : null;
    if (kind === "newborn") return { k: "glow", x: rnd(0, w), y: y ?? h + 10, vx: rnd(-4, 4), vy: rnd(-14, -6), r: rnd(1.5, 3.5), col, ph: rnd(0, 6) };
    if (kind === "female") return { k: "petal", x: rnd(0, w), y: y ?? -20, vx: rnd(-10, 10), vy: rnd(28, 55), r: rnd(6, 11), col, a: rnd(0, 6), va: rnd(-2, 2), ph: rnd(0, 6) };
    if (kind === "head") return { k: "gold", x: rnd(0, w), y: y ?? h + 6, vx: rnd(-6, 6), vy: rnd(-40, -18), r: rnd(1, 2.6), col, ph: rnd(0, 6) };
    return { k: "conf", x: rnd(0, w), y: y ?? -12, vx: rnd(-20, 20), vy: rnd(60, 120), r: rnd(4, 7), col, a: rnd(0, 6), va: rnd(-6, 6) };
  }
  // a burst of sparks (fireworks, the toddler's confetti pop); life in seconds
  pop(x, y, n, speed, cols = PALETTE[this.kind]) {
    for (let i = 0; i < n && this.ps.length < 140; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(-0.1, 0.1), v = rnd(0.5, 1) * speed * 22;
      this.ps.push({ k: "spark", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: rnd(1.6, 3), col: pick(cols), life: rnd(1.1, 1.8), age: 0, conf: this.kind === "toddler" });
    }
  }
  step(now, dt) {
    const { g, w, h, kind } = this;
    g.clearRect(0, 0, w, h);
    const t = (now - this.t0) / 1000;
    if (kind === "head" && t > 1.2 && t > this.nextRocket) { // fireworks after the crown lands
      this.nextRocket = t + rnd(0.9, 1.6);
      this.pop(rnd(w * 0.15, w * 0.85), rnd(h * 0.1, h * 0.38), 30, rnd(5, 7), [pick(PALETTE.head), "#ff5d8f", "#7cc4ff", "#ffd700"]);
    }
    const keep = [];
    for (const p of this.ps) {
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.k === "spark") {
        p.age += dt; p.vy += (p.conf ? 160 : 60) * dt; p.vx *= 0.985; p.vy *= 0.985;
        if (p.age > p.life) continue;
        g.globalAlpha = Math.max(0, 1 - p.age / p.life);
        g.fillStyle = p.col;
        if (p.conf) g.fillRect(p.x, p.y, p.r * 2, p.r);
        else { g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill(); }
        keep.push(p);
        continue;
      }
      if (p.k === "petal" || p.k === "conf") { p.a += p.va * dt; p.x += Math.sin(t * 1.6 + (p.ph || p.a)) * 18 * dt; }
      const gone = p.k === "glow" || p.k === "gold" ? p.y < -12 : p.y > h + 20;
      keep.push(gone ? this.spawn(false) : p);
      g.fillStyle = p.col;
      if (p.k === "petal") {
        g.globalAlpha = 0.85;
        g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.scale(1, 0.55 + 0.35 * Math.sin(t * 3 + p.ph));
        g.beginPath(); g.ellipse(0, 0, p.r, p.r * 0.6, 0, 0, 6.283); g.fill(); g.restore();
      } else if (p.k === "conf") {
        g.globalAlpha = 0.9;
        g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2 + Math.abs(Math.sin(p.a)) * p.r / 2); g.restore();
      } else {
        g.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(t * 2 + p.ph));
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill();
      }
    }
    g.globalAlpha = 1;
    this.ps = keep;
  }
}

export class BirthdayShow {
  // el: the #bday section. canShow(auto): false while an alarm, a prayer call, video, camera or night mode is up.
  constructor({ el, canShow = () => true, onShow = () => {} }) {
    Object.assign(this, { el, canShow, onShow });
    this.fx = new Particles(el.querySelector(".bs-fx"));
    this.queue = [];
    this.timer = null;
    this.current = null;
    this.lastHour = new Date().getHours();
    this.lastAuto = 0;
    this.previewKey = "";
    this.log = []; // { name, kind, why, at } for tests
    el.addEventListener("click", () => this.close());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.auto(this.state, "wake", true); });
  }

  get open() { return !!this.current; }

  // Everyone whose day is today (a birthday, or a baby's month day).
  todays(state) {
    const t = localYmd();
    return (state && Array.isArray(state.birthdays) ? state.birthdays : []).map((p) => celebration(p, t)).filter((c) => c && c.today);
  }

  // Called on every state from the hub: a new /birthday preview starts here.
  setState(state) {
    this.state = state;
    const pv = state && state.bdayPreview;
    if (!pv || !pv.name) return;
    const key = `${pv.name}@${pv.until}`;
    if (key === this.previewKey) return;
    this.previewKey = key;
    const left = pv.until - (state.serverTime || Date.now());
    if (left > 1500) this.preview(pv.name, Math.min(left, 60000));
  }

  preview(name, ms = 30000) {
    const p = ((this.state && this.state.birthdays) || []).find((b) => String(b.name).toLowerCase() === String(name).toLowerCase());
    const c = p && celebration(p, localYmd());
    if (!c || !this.canShow(false)) return false;
    this.queue = [];
    this.play(c, ms, "preview");
    return true;
  }

  // Every second from main.js: on the hour (and on the first tick after start) the people of the day come up.
  tick(state) {
    this.state = state;
    const h = new Date().getHours();
    if (h !== this.lastHour) { this.lastHour = h; this.auto(state, "hour"); }
    if (!this.started) { this.started = true; this.auto(state, "start", true); }
  }

  auto(state, why, gap = false) {
    if (this.current || !state) return;
    if (gap && Date.now() - this.lastAuto < WAKE_GAP_MS) return;
    const list = this.todays(state);
    if (!list.length || !this.canShow(true, why)) return;
    this.lastAuto = Date.now();
    this.queue = list.slice(1).map((c) => [c, DAY_MS, why]);
    this.play(list[0], DAY_MS, why);
  }

  play(c, ms, why) {
    clearTimeout(this.timer);
    const el = this.el;
    el.dataset.kind = c.kind;
    el.classList.toggle("is-preview", why === "preview");
    el.querySelector(".bs-scene").innerHTML = SCENES[c.kind]();
    const kicker = { newborn: c.months ? "A little milestone" : "Welcome to the world", toddler: "Party time!", female: "A day as lovely as you",
      head: "Our pillar, our pride", default: "Today is the day" }[c.kind];
    el.querySelector(".bs-kicker").textContent = why === "preview" ? `Preview - ${kicker}` : kicker;
    el.querySelector(".bs-big b").textContent = c.big;
    el.querySelector(".bs-big span").textContent = c.kind === "newborn" ? (c.months ? (c.months === 1 ? "month" : "months") : "old") : c.turns === 1 ? "year" : "years";
    // the toddler's title wobbles letter by letter
    const title = el.querySelector(".bs-title");
    title.textContent = "";
    if (c.kind === "toddler") {
      let i = 0; // letters hop one after another; a line only breaks between words
      c.title.split(" ").forEach((word, w) => {
        if (w) title.appendChild(document.createTextNode(" "));
        const wd = document.createElement("span");
        wd.className = "bs-word";
        for (const ch of word) { const s = document.createElement("span"); s.textContent = ch; s.style.setProperty("--i", i++); wd.appendChild(s); }
        title.appendChild(wd);
      });
    } else title.textContent = c.title;
    el.querySelector(".bs-line").textContent = c.line;
    el.classList.remove("hidden");
    // restart the CSS entrances
    el.classList.remove("on"); void el.offsetWidth; el.classList.add("on");
    if (motionLevel() === "full") this.fx.start(c.kind); else this.fx.stop();
    this.current = c;
    this.log.push({ name: c.name, kind: c.kind, why, at: Date.now() });
    this.onShow(c, why);
    this.timer = setTimeout(() => this.next(), ms);
  }

  next() {
    const n = this.queue.shift();
    if (n && this.canShow(n[2] !== "preview")) return this.play(...n);
    this.close();
  }

  close() {
    clearTimeout(this.timer);
    this.queue = [];
    this.current = null;
    this.fx.stop();
    this.el.classList.add("hidden");
    this.el.classList.remove("on");
    this.el.querySelector(".bs-scene").innerHTML = "";
  }
}
