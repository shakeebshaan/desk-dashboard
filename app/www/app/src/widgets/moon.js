// Moon phase, computed on the phone (astro.js, Meeus): today's phase drawn to scale (lit fraction and side), the
// percentage lit, the moon's age, and the next full and new moon with a countdown.
// Motion: the moon floats and its halo breathes, stars twinkle, and the lit part sweeps in from dark when the card
// opens (ending exactly on today's phase).
import { moonNow, moonPath } from "../astro.js";
import { moving, nextFrame, cancelFrame } from "../motion.js";

const DAY = 86400000;
const when = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const inDays = (ms, now) => { const d = Math.round((ms - now) / DAY * 10) / 10; return d < 1 ? `in ${Math.max(1, Math.round((ms - now) / 3600000))} h` : `in ${d.toFixed(d < 10 ? 1 : 0)} days`; };
// craters, in a 100 x 100 disc
const CRATERS = [[34, 30, 9], [58, 22, 5], [66, 48, 11], [40, 62, 7], [28, 50, 5], [56, 74, 8], [74, 30, 4], [46, 40, 4]];

export default {
  type: "moon",
  title: "Moon",
  mount(el) {
    el.innerHTML = `<div class="mn">
      <div class="mn-sky" aria-hidden="true">${[...Array(9)].map((_, i) => `<i style="left:${(i * 37) % 92 + 4}%;top:${(i * 53) % 80 + 4}%;animation-delay:-${i * 0.7}s"></i>`).join("")}</div>
      <div class="mn-art"><svg viewBox="-6 -6 112 112" class="mn-svg" role="img">
        <defs>
          <radialGradient id="mn-lit" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#fffdf2"/><stop offset="0.7" stop-color="#e8e4d4"/><stop offset="1" stop-color="#bdb8a6"/></radialGradient>
          <clipPath id="mn-clip"><path class="mn-litpath"/></clipPath>
        </defs>
        <circle cx="50" cy="50" r="50" class="mn-dark"/>
        <path class="mn-litpath mn-lit" fill="url(#mn-lit)"/>
        <g clip-path="url(#mn-clip)" class="mn-craters">${CRATERS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join("")}</g>
        <circle cx="50" cy="50" r="50" class="mn-rim"/>
      </svg></div>
      <div class="mn-name"></div>
      <div class="mn-pct"><b></b><span>% lit</span></div>
      <div class="mn-age muted"></div>
      <div class="mn-next"><div class="mn-full"><i>🌕</i><b>Full moon</b><span></span><em></em></div><div class="mn-new"><i>🌑</i><b>New moon</b><span></span><em></em></div></div>
    </div>`;
    const q = (c) => el.querySelector(c);
    let raf = 0;
    let last = "";
    const paths = () => el.querySelectorAll(".mn-litpath");
    const setPhase = (illum, waxing) => { const d = moonPath(illum, waxing, 50); for (const p of paths()) p.setAttribute("d", d); };
    const draw = (sweep) => {
      const now = Date.now();
      const m = moonNow(now);
      const pct = Math.round(m.illum * 100);
      q(".mn-svg").setAttribute("aria-label", `${m.name}, ${pct}% lit`);
      q(".mn-name").textContent = m.name;
      q(".mn-age").textContent = `${m.ageDays.toFixed(1)} days since the new moon · ${m.waxing ? "growing" : "shrinking"}`;
      q(".mn-full span").textContent = `${when(m.nextFull)}, ${clock(m.nextFull)}`;
      q(".mn-full em").textContent = inDays(m.nextFull, now);
      q(".mn-new span").textContent = `${when(m.nextNew)}, ${clock(m.nextNew)}`;
      q(".mn-new em").textContent = inDays(m.nextNew, now);
      // full and new swap places so the sooner one comes first
      q(".mn-next").classList.toggle("new-first", m.nextNew < m.nextFull);
      cancelFrame(raf);
      if (!sweep || !moving()) { setPhase(m.illum, m.waxing); q(".mn-pct b").textContent = pct; return; }
      // the light grows from a thin sliver to today's phase, the percentage counts with it
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 1400), e = 1 - Math.pow(1 - k, 3);
        setPhase(0.02 + (m.illum - 0.02) * e, m.waxing);
        q(".mn-pct b").textContent = Math.round(pct * e);
        if (k < 1) raf = nextFrame(step);
      };
      raf = nextFrame(step);
    };
    return {
      update() { const k = new Date().toDateString(); if (k !== last) { last = k; draw(false); } },
      tick() { if (new Date().getSeconds() === 0) draw(false); },
      show() { draw(true); },
      hide() { cancelFrame(raf); },
    };
  },
};
