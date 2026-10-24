// Sunrise and sunset for the dashboard city (/city; computed on the phone, astro.js NOAA equations): the times, the
// day length and how it changes, and an arc with the sun where it is now. At night the sun sits below the horizon,
// moving toward the next sunrise.
// Motion: the travelled part of the arc fills, the sun glows and its rays turn; the sky tint follows the sun.
// Events (main.js, 3 s before the moment): sunrise lifts the sun over the horizon with a burst of rays, sunset
// sinks it into an orange glow.
import { sunTimes, sunProgress, fmtDur } from "../astro.js";

const DAY = 86400000;
const hm = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ymdOf = (ms) => { const d = new Date(ms); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; };
const until = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
// the arc: a half ellipse from (20,150) to (320,150), top at y=24
const X0 = 20, X1 = 320, Y0 = 150, H = 126;
const at = (p) => [X0 + (X1 - X0) * p, Y0 - H * Math.sin(Math.PI * p)];
const ARC = `M${X0} ${Y0} A${(X1 - X0) / 2} ${H} 0 0 1 ${X1} ${Y0}`;

export function sunDay(city, now = Date.now()) {
  const t = (ms) => sunTimes(...ymdOf(ms), city.lat, city.lon);
  return { now, today: t(now), tomorrow: t(now + DAY), yesterday: t(now - DAY) };
}

export default {
  type: "sun",
  title: "Sunrise and sunset",
  mount(el) {
    el.innerHTML = `<div class="sn">
      <div class="sn-sky"></div>
      <div class="sn-head"><span class="sn-next"></span><b class="sn-in"></b></div>
      <svg class="sn-arc" viewBox="0 0 340 176" aria-hidden="true">
        <defs><linearGradient id="sn-trail" x1="0" x2="1"><stop offset="0" stop-color="#ff9a4a"/><stop offset="0.5" stop-color="#ffd56b"/><stop offset="1" stop-color="#ff9a4a"/></linearGradient>
          <linearGradient id="sn-earth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
          <radialGradient id="sn-glow"><stop offset="0" stop-color="#fff6c2"/><stop offset="0.35" stop-color="#ffd56b"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient></defs>
        <path d="${ARC}" class="sn-path"/>
        <path d="${ARC}" class="sn-done" stroke="url(#sn-trail)" pathLength="1000"/>
        <line x1="6" y1="${Y0}" x2="334" y2="${Y0}" class="sn-horizon"/>
        <g class="sn-sun"><g class="sn-lift"><circle r="26" fill="url(#sn-glow)" class="sn-halo"/><g class="sn-rays">${[...Array(8)].map((_, i) => `<line x1="0" y1="-15" x2="0" y2="-21" transform="rotate(${i * 45})"/>`).join("")}</g><circle r="10" class="sn-disc"/></g></g>
        <rect x="0" y="${Y0 + 1}" width="340" height="26" fill="url(#sn-earth)"/>
      </svg>
      <div class="sn-times"><div><span>Sunrise</span><b class="sn-rise"></b></div><div><span>Sunset</span><b class="sn-set"></b></div></div>
      <div class="sn-facts"><div><b class="sn-len"></b><span>day length</span></div><div><b class="sn-delta"></b><span>vs tomorrow</span></div><div><b class="sn-noon"></b><span>solar noon</span></div></div>
      <p class="empty sn-empty"></p>
    </div>`;
    const q = (c) => el.querySelector(c);
    let st = null;
    let evtTimer = null;
    const draw = () => {
      const city = st && st.settings && st.settings.city;
      const box = q(".sn");
      if (!city) { box.classList.add("none"); q(".sn-empty").innerHTML = "Send <code>/city Pune</code><br>to the bot."; return; }
      box.classList.remove("none");
      const d = sunDay(city);
      const { today, tomorrow } = d;
      if (!today.rise || !today.set) { q(".sn-empty").textContent = "No sunrise or sunset today here."; box.classList.add("none"); return; }
      const p = sunProgress(d.now, today, tomorrow, d.yesterday);
      q(".sn-rise").textContent = hm(today.rise);
      q(".sn-set").textContent = hm(today.set);
      q(".sn-len").textContent = fmtDur(today.dayMs).replace(" min", " m");
      const delta = Math.round(((tomorrow.dayMs || today.dayMs) - today.dayMs) / 60000 * 10) / 10;
      q(".sn-delta").textContent = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} min`;
      q(".sn-noon").textContent = hm(today.noon);
      const sun = q(".sn-sun");
      let x, y;
      if (p.day !== null) {
        [x, y] = at(p.day);
        q(".sn-next").textContent = "Sunset in";
        q(".sn-in").textContent = until(today.set - d.now);
        q(".sn-done").style.strokeDasharray = `${Math.round(p.day * 1000)} 1000`;
        box.dataset.sky = p.day < 0.12 ? "dawn" : p.day > 0.88 ? "dusk" : "day";
      } else {
        // night: below the horizon, from the sunset side back toward sunrise
        const n = p.night === null ? 0.5 : p.night;
        x = X1 - (X1 - X0) * n; y = Y0 + 16;
        const nextRise = d.now < today.rise ? today.rise : tomorrow.rise;
        q(".sn-next").textContent = "Sunrise in";
        q(".sn-in").textContent = until(nextRise - d.now);
        q(".sn-done").style.strokeDasharray = d.now < today.rise ? "0 1000" : "1000 0";
        box.dataset.sky = "night";
      }
      sun.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    };
    return {
      update(state) { st = state; draw(); },
      tick(state) { st = state; if (new Date().getSeconds() % 10 === 0) draw(); },
      show() { draw(); },
      // main.js: a sunrise or sunset is about to happen
      event(ev) {
        const box = q(".sn");
        clearTimeout(evtTimer);
        box.classList.remove("evt-rise", "evt-set");
        void box.offsetWidth;
        box.classList.add(ev.kind === "sunrise" ? "evt-rise" : "evt-set");
        evtTimer = setTimeout(() => { box.classList.remove("evt-rise", "evt-set"); draw(); }, 14000);
      },
    };
  },
};
