// Countdowns: the owner's events (/event) and the next Islamic dates (hub: Aladhan, calculated), soonest first.
// Motion: the big number rolls digit by digit, a light sweeps the top card, the last hour beats like a heart,
// Islamic dates show tonight's moon, and "Today" gets a confetti burst.
import { upcoming, wallNow, countdownText } from "../events.js";
import { roll, burst, moonHtml, moonPhase } from "../motion.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const when = (x) => { const d = new Date(x.at); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}${x.allDay ? "" : ` · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`}`; };

// Big live countdown for the first item: days + hh:mm:ss
function big(at, now, allDay) {
  if (allDay && countdownText(at, now, true) === "today") return { n: "Today", u: "" };
  const ms = Math.max(0, at - now);
  const d = Math.floor(ms / 86400000);
  const s = Math.floor(ms / 1000) % 86400;
  const hms = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  return d >= 1 ? { n: String(d), u: d === 1 ? "day" : "days", sub: hms } : { n: hms, u: "", clock: true };
}

export default {
  type: "countdown",
  title: "Countdowns",
  mount(el) {
    let key = "", items = [], top = null;
    const draw = () => {
      if (!top) return;
      const now = wallNow();
      const b = big(items[0].at, now, items[0].allDay);
      const n = top.querySelector(".cd-n");
      n.classList.toggle("clock", !!b.clock);
      roll(n, b.n);
      top.querySelector(".cd-uu").textContent = b.u + (b.sub ? " · " : "");
      roll(top.querySelector(".cd-hms"), b.sub || "");
      top.classList.toggle("beat", items[0].at - now < 3600000 && items[0].at > now);
    };
    return {
      update(state) {
        const now = wallNow();
        items = upcoming({ events: state.events || [], islamic: (state.islamic && state.islamic.items) || [] }, now, 6);
        const k = JSON.stringify(items.map((x) => [x.name, x.at])) + new Date().getDate();
        if (k === key) return draw();
        key = k;
        if (!items.length) {
          top = null;
          el.innerHTML = `<p class="empty">No countdowns yet.<br>Send <code>/event 2026-12-25 Trip</code><br>or <code>/event Tuesday 11:00 Work</code>.</p>`;
          return;
        }
        const [f, ...rest] = items;
        const islamic = items.some((x) => x.kind === "islamic");
        el.innerHTML = `
          <div class="cd-top ${f.kind}">
            <div class="cd-name">${f.kind === "islamic" ? "🌙 " : ""}${esc(f.name)}</div>
            ${f.kind === "islamic" ? `<div class="cd-sky" aria-hidden="true">${moonHtml(moonPhase(), "cd-moon")}<i></i><i></i><i></i></div>` : ""}
            <div class="cd-n"></div><div class="cd-u"><span class="cd-uu"></span><span class="cd-hms"></span></div>
            <div class="cd-when">${when(f)}${f.repeat ? ` · ${f.repeat}` : ""}${f.hijri ? ` · ${esc(f.hijri)}` : ""}</div>
          </div>
          <div class="cd-list">${rest.map((x, i) => `
            <div class="cd-row ${x.kind}" style="animation-delay:${i * 0.06}s"><div><b>${x.kind === "islamic" ? "🌙 " : ""}${esc(x.name)}</b><small>${when(x)}${x.repeat ? ` · ${x.repeat}` : ""}</small></div><span>${countdownText(x.at, now, x.allDay)}</span></div>`).join("")}
          </div>
          ${islamic ? `<p class="cd-note">🌙 Islamic dates are calculated and can move a day either way with the moon sighting.</p>` : ""}`;
        top = el.querySelector(".cd-top");
        draw();
      },
      tick() { draw(); },
      show() {
        if (top && items.length && countdownText(items[0].at, wallNow(), items[0].allDay) === "today") setTimeout(() => burst(top, { n: 20, y: "40%" }), 500);
      },
    };
  },
};
