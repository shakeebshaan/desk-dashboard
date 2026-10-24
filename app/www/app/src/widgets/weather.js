// Weather now: the current reading big (temperature, feels like, condition, humidity, wind), the next hours, an
// umbrella flag, and the next days. Comes from the hub (Open-Meteo, fetched there); the phone calls no weather service.
// Motion: a living scene behind the reading, matched to the real condition, its strength (WMO code) and day/night:
// sun with slow rays and heat shimmer, layered clouds drifting at the wind's pace, rain light to heavy with streaks,
// splashes and mist, thunder with lightning and a bolt, snow that settles, rolling fog, the moon's glow and twinkling
// stars at night, and wind as bending gust lines and tumbling leaves at the real wind speed. A new condition
// crossfades in; the temperature counts to its new value; the hourly strip slides in; the event-driven cycle
// (focus.js weatherEvent) plays a short attention animation when rain starts or the temperature jumps.
import { moonHtml, moonPhase, moving, lively, nextFrame, cancelFrame } from "../motion.js";
export function iconHtml(kind, cls = "") {
  const parts = {
    sun: `<div class="rays"></div><div class="sun"></div>`,
    partly: `<div class="sun"></div><div class="cloud"></div>`,
    cloud: `<div class="cloud"></div>`,
    fog: `<div class="cloud"></div><div class="fogl" style="bottom:8%"></div><div class="fogl" style="bottom:0;left:20%"></div>`,
    drizzle: `<div class="cloud"></div><div class="drops" style="opacity:.6"></div>`,
    rain: `<div class="cloud"></div><div class="drops"></div>`,
    snow: `<div class="cloud"></div><div class="drops" style="background:repeating-linear-gradient(90deg,transparent 0 8px,#fff 8px 11px)"></div>`,
    storm: `<div class="cloud" style="filter:brightness(.7)"></div><div class="bolt"></div>`,
  };
  return `<div class="ic ${kind} ${cls}">${parts[kind] || parts.cloud}</div>`;
}

// Night between sunset and sunrise (the hub's local times for the city); without them, 19:00 to 06:00.
const localIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export function isNight(w, d = new Date()) {
  if (w && w.sunrise && w.sunset) {
    const t = localIso(d).slice(11), a = w.sunrise.slice(11, 16), b = w.sunset.slice(11, 16);
    return t < a || t >= b;
  }
  return d.getHours() >= 19 || d.getHours() < 6;
}

// Strength of the precipitation from the WMO code: 1 light, 2 moderate, 3 heavy (no code: moderate).
const LIGHT = new Set([51, 56, 61, 71, 77, 80, 85]);
const HEAVY = new Set([55, 57, 65, 67, 75, 82, 86, 96, 99]);
export const strength = (code) => (HEAVY.has(code) ? 3 : LIGHT.has(code) ? 1 : 2);
// Wind in km/h -> 0 calm (< 8), 1 breeze (< 20), 2 windy (< 38), 3 gale.
export const windLevel = (kmh) => (!(kmh >= 8) ? 0 : kmh < 20 ? 1 : kmh < 38 ? 2 : 3);
export const HOT = 32; // from this temperature a clear day shimmers harder

// The scene: every layer is a few absolutely placed elements moved by CSS transforms; particle layers carry
// .fx-p so "calm" motion drops them. Counts are fixed and small (an old phone draws this all day).
const n = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("");
const CLOUDS = (k, dim, pace) => n(k, (i) => {
  const near = i % 2 === 1; // far layer: small, faint, slow; near layer: bigger and quicker
  const dur = Math.round(((near ? 38 : 64) + i * 11) / pace);
  return `<i class="wx-cl ${near ? "near" : "far"}" style="top:${4 + i * 12}%;--x:${(i * 97) % 260 - 60}px;animation-duration:${dur}s;animation-delay:-${Math.round(dur * ((i * 0.37) % 1))}s;opacity:${(dim ? 0.07 : 0.1) + (near ? 0.05 : 0)};--s:${near ? 1.1 + (i % 3) * 0.15 : 0.6 + (i % 3) * 0.1}"></i>`;
});
const DROPS = (k, d0, dv) => n(k, (i) => `<i style="left:${(i * 37 + 5) % 104 - 4}%;animation-delay:-${((i * 0.29) % 1).toFixed(2)}s;animation-duration:${(d0 + (i % 4) * dv).toFixed(2)}s"></i>`);
const SPLASH = (k) => n(k, (i) => `<i style="left:${(i * 53 + 11) % 96}%;animation-delay:-${((i * 0.37) % 1.1).toFixed(2)}s"></i>`);
const FLAKES = (k) => n(k, (i) => `<i style="left:${(i * 41 + 3) % 100}%;animation-delay:-${(i * 0.83).toFixed(1)}s;animation-duration:${7 + (i % 5)}s;--s:${0.6 + (i % 3) * 0.3}"></i>`);
const STARS = (k) => n(k, (i) => `<i style="left:${4 + ((i * 37 + 11) % 92)}%;top:${4 + ((i * 53 + 7) % 44)}%;animation-delay:-${(i * 0.7).toFixed(1)}s;animation-duration:${(2 + (i % 4) * 0.6).toFixed(1)}s;--s:${0.6 + (i % 3) * 0.4}"></i>`);
const GUSTS = (k, dur) => n(k, (i) => `<i style="top:${18 + ((i * 29) % 64)}%;animation-duration:${(dur + (i % 3) * 0.4).toFixed(1)}s;animation-delay:-${(i * dur / k).toFixed(1)}s;--w:${100 + (i % 3) * 40}px"></i>`);
const LEAVES = (k, dur) => n(k, (i) => `<i class="${i % 2 ? "b" : ""}" style="top:${30 + ((i * 23) % 50)}%;animation-duration:${(dur + (i % 3) * 0.9).toFixed(1)}s;animation-delay:-${(i * dur / k).toFixed(1)}s"></i>`);

// opts: { level 1..3, wind km/h, temp }. Wind sets the rain's slant, the clouds' pace, gust lines and leaves.
export function sceneHtml(kind, night, { level = 2, wind = 0, temp = null } = {}) {
  const wet = kind === "rain" || kind === "drizzle" || kind === "storm";
  const wl = windLevel(wind);
  const pace = 1 + Math.min(wind || 0, 60) / 20; // clouds: calm 1x .. gale 4x
  const slant = Math.round(4 + Math.min(wind || 0, 60) * 0.45); // degrees
  const lvl = kind === "drizzle" ? 0 : kind === "storm" ? 3 : level; // rain: 0 drizzle, 1 light, 2 moderate, 3 heavy
  const rain = [[8, 1.25, 0.12, 4], [12, 0.95, 0.1, 5], [18, 0.78, 0.09, 7], [26, 0.56, 0.07, 10]][lvl];
  const clouds = { sun: 0, partly: 2, cloud: 4, fog: 2, drizzle: 3, rain: 4, storm: 5, snow: 4 }[kind] ?? 3;
  const clear = kind === "sun" || kind === "partly";
  const hot = !night && clear && temp != null && temp >= HOT;
  return `<div class="wx-scene ${kind} lv${lvl}${night ? " wx-dark" : ""}" style="--slant:${slant}deg" aria-hidden="true">
    ${night && clear ? `<div class="wx-moonglow"></div><div class="wx-stars fx-p">${STARS(18)}</div>` : ""}
    ${night && (kind === "cloud" || kind === "fog") ? `<div class="wx-stars dim fx-p">${STARS(6)}</div>` : ""}
    ${!night && clear ? `<div class="wx-glow"></div><div class="wx-beams"></div><div class="wx-shimmer${hot ? " hot" : ""}">${n(hot ? 6 : 4, (i) => `<i style="bottom:${6 + i * 9}%;animation-delay:-${(i * 0.7).toFixed(1)}s"></i>`)}</div>` : ""}
    ${clouds ? `<div class="wx-clouds">${CLOUDS(clouds, night, pace)}</div>` : ""}
    ${kind === "fog" ? `<div class="wx-haze"></div><div class="wx-fog">${n(4, (i) => `<i style="top:${24 + i * 17}%;animation-duration:${26 + i * 8}s;animation-delay:-${i * 7}s"></i>`)}</div>` : ""}
    ${wet ? `<div class="wx-rain fx-p">${DROPS(rain[0], rain[1], rain[2])}</div><div class="wx-splash fx-p">${SPLASH(rain[3])}</div>${lvl >= 2 ? `<div class="wx-mist"></div>` : ""}` : ""}
    ${kind === "snow" ? `<div class="wx-snow fx-p">${FLAKES([10, 10, 14, 20][level])}</div><div class="wx-settle"></div>` : ""}
    ${kind === "storm" ? `<div class="wx-bolt"></div><div class="wx-bolt b"></div><div class="wx-flash"></div><div class="wx-flash b"></div>` : ""}
    ${wl ? `<div class="wx-wind fx-p">${GUSTS([0, 2, 4, 6][wl], [0, 4.2, 2.8, 1.8][wl])}</div>${wl >= 2 && kind !== "snow" ? `<div class="wx-leaves fx-p">${LEAVES(wl === 2 ? 2 : 4, wl === 2 ? 5.5 : 3.6)}</div>` : ""}` : ""}
    <div class="wx-scrim"></div>
  </div>`;
}
const sceneKey = (c, night) => `${c.icon}|${night}|${strength(c.code)}|${windLevel(c.wind)}|${!night && c.temp >= HOT}`;

// The big icon: at night a clear or partly cloudy sky shows tonight's moon instead of the sun.
const nowIcon = (kind, night) => (night && (kind === "sun" || kind === "partly")
  ? `<div class="ic moonic ${kind}">${moonHtml(moonPhase())}${kind === "partly" ? `<div class="cloud"></div>` : ""}</div>`
  : iconHtml(kind));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
const r = (x) => (x == null ? "-" : Math.round(x));

// The temperature counts from `from` to `to` (eased); returns a stop function.
function countTo(node, from, to, ms) {
  if (!moving() || from === to) { node.textContent = to; return () => {}; }
  let raf = 0;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) raf = nextFrame(step);
  };
  node.textContent = from;
  raf = nextFrame(step);
  return () => { cancelFrame(raf); node.textContent = to; };
}

const ALERTS = {
  storm: ["⛈️", "Thunderstorm starting"], rain: ["🌧️", "Rain starting"], snow: ["🌨️", "Snow starting"], dry: ["🌤️", "The rain has stopped"],
  warm: ["🌡️", "Warming up"], cool: ["🌡️", "Cooling down"],
};

export default {
  type: "weather",
  title: "Weather",
  mount(el) {
    let key = "", sKey = "", kind = "";
    let stop = () => {};
    let visible = false;
    let shownTemp = null; // the temperature as last shown, so a change counts from the old value
    let attnTimer = 0;
    el.innerHTML = `<div class="wx-body"></div>`;
    const body = el.querySelector(".wx-body");
    const curTemp = () => { const t = el.querySelector(".wx-temp [data-n]"); return t ? +t.dataset.n : null; };
    const count = () => {
      stop();
      const t = el.querySelector(".wx-temp [data-n]");
      if (!t) return;
      const to = +t.dataset.n;
      const changed = shownTemp != null && shownTemp !== to;
      stop = countTo(t, changed ? shownTemp : 0, to, changed ? 1400 : 900);
      if (changed) delta(to - shownTemp);
      shownTemp = to;
    };
    const delta = (d) => {
      const host = el.querySelector(".wx-temp");
      if (!host || !d) return;
      host.querySelector(".wx-delta")?.remove();
      host.insertAdjacentHTML("beforeend", `<span class="wx-delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}°</span>`);
    };
    // a new condition crossfades in over the old scene; the old one is removed when it has faded
    const swapScene = (html) => {
      const old = [...el.querySelectorAll(":scope > .wx-scene")];
      body.insertAdjacentHTML("beforebegin", html);
      if (!old.length) return;
      const nu = body.previousElementSibling;
      nu.classList.add("wx-in");
      for (const o of old) { o.classList.add("wx-out"); setTimeout(() => o.remove(), moving() ? 1700 : 0); }
    };
    return {
      show() { visible = true; count(); },
      hide() { visible = false; stop(); },
      update(state) {
        const w = state.weather;
        const night = w ? isNight(w) : false;
        const k = w ? `${w.at}|${night}` : "none";
        if (k === key) return;
        key = k;
        if (!w) {
          for (const o of el.querySelectorAll(":scope > .wx-scene")) o.remove();
          sKey = "";
          body.innerHTML = `<p class="empty">${state.settings && state.settings.city ? "Fetching the weather..." : "Send <code>/city Pune</code><br>to the bot."}</p>`;
          return;
        }
        const c = w.current;
        const sk = sceneKey(c, night);
        if (sk !== sKey) { sKey = sk; swapScene(sceneHtml(c.icon, night, { level: strength(c.code), wind: c.wind, temp: c.temp })); }
        const iconChanged = kind && kind !== c.icon;
        kind = c.icon;
        const before = curTemp();
        const u = w.umbrella || { yes: false, why: "" };
        const hours = (w.hourly || []).slice(1, 7);
        body.innerHTML = `
          <div class="wx-city muted">${esc(w.city)} · now</div>
          <div class="wx-top ${c.icon}"><div><div class="wx-temp"><span data-n="${r(c.temp)}">${r(c.temp)}</span><sup>°</sup></div><div class="wx-text">${esc(c.text)}</div></div>${nowIcon(c.icon, night).replace('class="ic ', `class="ic ${iconChanged ? "chg " : ""}`)}</div>
          <div class="wx-now">
            <div><small>Feels like</small><b>${r(c.feels)}°</b></div>
            <div><small>Humidity</small><b>${r(c.humidity)}%</b></div>
            <div><small>Wind</small><b>${r(c.wind)}<i> km/h</i></b></div>
          </div>
          <div class="wx-umb ${u.yes ? "yes" : "no"}">${u.yes ? `☂️ Take an umbrella <span>${esc(u.why)}</span>` : `🌂 No umbrella needed${u.why ? ` <span>${esc(u.why)}</span>` : ""}`}</div>
          ${hours.length ? `<div class="wx-hours">${hours.map((h, i) => `
            <div class="wx-hour" style="animation-delay:${(0.15 + i * 0.07).toFixed(2)}s"><small>${h.time}</small>${iconHtml(h.icon)}<b>${r(h.temp)}°</b><em>${h.rain != null ? `${h.rain}%` : ""}</em></div>`).join("")}</div>` : ""}
          <div class="wx-days">${w.daily.slice(1, 5).map((d) => `
            <div class="wx-dd"><small>${day(d.date)}</small>${iconHtml(d.icon)}<b>${r(d.max)}°</b><span>${r(d.min)}°</span></div>`).join("")}
          </div>
          <div class="muted wx-upd">Updated ${new Date(w.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</div>`;
        if (shownTemp == null && before != null) shownTemp = before;
        if (visible) count();
      },
      // The event-driven cycle brought the card forward (weatherEvent in focus.js): a banner, and per kind a
      // lightning strike, a downpour, a snow flurry, a clearing glow or a warm/cool pulse on the temperature.
      event(ev) {
        const a = ALERTS[ev.kind];
        if (!a) return;
        clearTimeout(attnTimer);
        el.querySelector(".wx-alert")?.remove();
        el.querySelector(".wx-fxo")?.remove();
        el.classList.remove(...[...el.classList].filter((c) => c.startsWith("wx-attn")));
        void el.offsetWidth;
        el.classList.add("wx-attn", `wx-attn-${ev.kind}`);
        body.insertAdjacentHTML("afterbegin", `<div class="wx-alert ${ev.kind}" role="status"><span>${a[0]}</span>${a[1]}${ev.delta ? ` <b>${ev.delta > 0 ? "+" : ""}${ev.delta}°</b>` : ""}</div>`);
        if (lively()) {
          const fx = { storm: `<div class="wx-strike"></div><div class="wx-bolt big"></div>`, rain: `<div class="wx-rain pour">${DROPS(30, 0.5, 0.06)}</div>`,
            snow: `<div class="wx-snow flurry">${FLAKES(24)}</div>`, dry: `<div class="wx-clearing"></div>`, warm: "", cool: "" }[ev.kind];
          if (fx) body.insertAdjacentHTML("beforebegin", `<div class="wx-scene wx-fxo" aria-hidden="true">${fx}</div>`);
        }
        attnTimer = setTimeout(() => {
          el.classList.remove(...[...el.classList].filter((c) => c.startsWith("wx-attn")));
          el.querySelector(".wx-fxo")?.remove();
          const al = el.querySelector(".wx-alert");
          if (al) { al.classList.add("gone"); setTimeout(() => al.remove(), 700); }
        }, 8000);
      },
    };
  },
};
