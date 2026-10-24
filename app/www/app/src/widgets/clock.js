// Clock in four styles (/clockstyle): rings (the original), analogue, flip, minimal.
// Motion: digits roll when they change, a comet rides the seconds ring and the ring flashes as each minute
// completes, the analogue second hand sweeps, and a soft sky tint behind the clock follows the hour of the day.
import { roll, moving } from "../motion.js";
const R = 140, C = 2 * Math.PI * R;
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "--:--");
// Replays a one-shot CSS animation: remove the class, force a style flush, add it again.
const restart = (node, cls) => { if (!node || !moving()) return; node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };
// Sky tint behind the clock by hour: dawn rose, morning blue, noon cyan, golden hour, dusk violet, night indigo.
const SKY = [[5, "#ff8a8a", "#ffc58a"], [8, "#6fb7ff", "#a6e3ff"], [11, "#38d1f8", "#7cf0c8"], [15, "#ffb347", "#ff7e5f"],
  [18, "#c05cff", "#ff6f91"], [20, "#2a3ba8", "#5b2a86"]];
const skyFor = (h) => { let c = SKY[SKY.length - 1]; for (const x of SKY) if (h >= x[0]) c = x; return h < 5 ? SKY[SKY.length - 1] : c; };
const longDate = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

const STYLES = {
  rings: {
    html: `
      <div class="clock-wrap">
        <svg viewBox="0 0 300 300"><defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="var(--a1)"/><stop offset="1" stop-color="var(--a2)"/></linearGradient></defs>
          <circle class="track" cx="150" cy="150" r="${R}"/><circle class="min" cx="150" cy="150" r="${R - 14}"/>
          <circle class="sec" cx="150" cy="150" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
        <div class="clock-comet"><i></i></div><div class="clock-flash"></div>
        <div class="clock-center"><div class="clock-hm">--:--</div><div class="clock-s"></div></div>
      </div>`,
    tick(el, d) {
      roll(el.querySelector(".clock-hm"), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
      el.querySelector(".clock-s").textContent = `${pad(d.getSeconds())} s`;
      if (d.getSeconds() === 0) restart(el.querySelector(".clock-flash"), "go");
      const sec = el.querySelector(".sec");
      sec.style.transition = d.getSeconds() === 0 ? "none" : "";
      sec.setAttribute("stroke-dashoffset", String(C * (1 - d.getSeconds() / 60)));
      const c2 = 2 * Math.PI * (R - 14);
      el.querySelector(".min").setAttribute("stroke-dasharray", `${c2 * (d.getMinutes() / 60)} ${c2}`);
    },
  },
  analogue: {
    html: `
      <div class="an-wrap"><svg viewBox="0 0 300 300">
        <circle cx="150" cy="150" r="142" class="an-face"/>
        ${Array.from({ length: 60 }, (_, i) => `<line x1="150" y1="${i % 5 ? 14 : 10}" x2="150" y2="${i % 5 ? 20 : 32}" class="${i % 5 ? "an-tick" : "an-hour"}" transform="rotate(${i * 6} 150 150)"/>`).join("")}
        <line x1="150" y1="150" x2="150" y2="78" class="an-h"/><line x1="150" y1="150" x2="150" y2="44" class="an-m"/>
        <line x1="150" y1="172" x2="150" y2="30" class="an-s"/><circle cx="150" cy="150" r="6" class="an-pin"/></svg></div>
      <div class="an-digital"></div>`,
    tick(el, d) {
      const s = d.getSeconds(), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
      el.querySelector(".an-h").setAttribute("transform", `rotate(${h * 30} 150 150)`);
      el.querySelector(".an-m").setAttribute("transform", `rotate(${m * 6} 150 150)`);
      el.querySelector(".an-s").setAttribute("transform", `rotate(${s * 6} 150 150)`);
      roll(el.querySelector(".an-digital"), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
    },
  },
  flip: {
    html: `<div class="flip">${["h1", "h2", "", "m1", "m2"].map((k) => (k ? `<div class="fl" data-k="${k}"><b>0</b></div>` : `<div class="fl-sep">:</div>`)).join("")}</div>
      <div class="flip-s"></div>`,
    tick(el, d) {
      const v = { h1: pad(d.getHours())[0], h2: pad(d.getHours())[1], m1: pad(d.getMinutes())[0], m2: pad(d.getMinutes())[1] };
      for (const [k, x] of Object.entries(v)) {
        const card = el.querySelector(`[data-k="${k}"]`);
        const b = card.querySelector("b");
        if (b.textContent !== x) {
          b.textContent = x;
          card.classList.remove("flipping");
          void card.offsetWidth;
          card.classList.add("flipping");
        }
      }
      roll(el.querySelector(".flip-s"), `${pad(d.getSeconds())}`);
    },
  },
  minimal: {
    html: `<div class="mini"><div class="mini-hm"></div><div class="mini-bar"><i></i></div></div>`,
    tick(el, d) {
      roll(el.querySelector(".mini-hm"), `${pad(d.getHours())}:${pad(d.getMinutes())}`);
      el.querySelector(".mini-bar i").style.transform = `scaleX(${(d.getSeconds() + 1) / 60})`;
    },
  },
};

export default {
  type: "clock",
  title: "Time",
  mount(el) {
    let style = null;
    const body = document.createElement("div");
    body.className = "clock-body";
    const date = document.createElement("div");
    date.className = "clock-date";
    const sun = document.createElement("div");
    sun.className = "clock-sun";
    const sky = document.createElement("div");
    sky.className = "clock-sky";
    sky.setAttribute("aria-hidden", "true");
    el.append(sky, body, date, sun);
    let skyHour = -1;
    // The analogue second hand and the ring comet run as 60 s CSS loops started at the current second.
    const sync = () => {
      const d = new Date();
      const lag = `-${(d.getSeconds() + d.getMilliseconds() / 1000).toFixed(2)}s`;
      for (const n of body.querySelectorAll(".an-s, .clock-comet")) { n.style.animationDelay = lag; restart(n, "sweep"); }
    };
    const setStyle = (st) => {
      const s = STYLES[st] ? st : "rings";
      if (s === style) return;
      style = s;
      body.dataset.style = s;
      body.innerHTML = STYLES[s].html;
      sync();
    };
    setStyle("rings");
    return {
      update(state) {
        setStyle(state.settings && state.settings.clockStyle);
        const w = state.weather;
        sun.innerHTML = w && w.sunrise ? `<span>☀ ${hhmm(w.sunrise)}</span><span>☾ ${hhmm(w.sunset)}</span>` : "";
      },
      tick(state) {
        if (state) setStyle(state.settings && state.settings.clockStyle);
        const d = new Date();
        STYLES[style].tick(body, d);
        date.textContent = longDate(d);
        if (d.getHours() !== skyHour) {
          skyHour = d.getHours();
          const [, a, b] = skyFor(skyHour);
          sky.style.background = `radial-gradient(60% 45% at 50% 38%, ${a}, transparent 70%), radial-gradient(70% 40% at 50% 85%, ${b}, transparent 70%)`;
        }
      },
      show: sync,
    };
  },
};
