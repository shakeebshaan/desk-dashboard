// Next alarm or reminder big, then the list. Motion: a ring drains over the last 12 hours toward the next one and
// its bell wobbles more as the time nears (gently in the last hour, eagerly in the last 10 minutes).
import { nextFire } from "../alarms.js";

const RING = 2 * Math.PI * 42;
const WINDOW = 12 * 3600000;
const urgency = (ms) => (ms <= 60000 ? "now" : ms <= 600000 ? "soon" : ms <= 3600000 ? "near" : "far");

const pad = (n) => String(n).padStart(2, "0");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const when = (t) => {
  const d = new Date(t), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === d.toDateString();
  return `${sameDay ? "Today" : tomorrow ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const left = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m} min`;
};

export default {
  type: "alarms",
  title: "Alarms & reminders",
  mount(el) {
    let st = null;
    let key = "";
    const render = () => {
      const now = Date.now();
      const list = (st && st.alarms ? st.alarms : []).map((a) => ({ a, t: nextFire(a, now) })).filter((x) => x.t).sort((x, y) => x.t - y.t);
      if (!list.length) {
        key = "";
        el.innerHTML = `<p class="empty">No alarms.<br>Send <code>/alarm 07:30 Wake up</code><br>or <code>/remind 20m Tea</code></p>`;
        return;
      }
      const n = list[0];
      const ms = n.t - now;
      const frac = Math.max(0.015, Math.min(1, ms / WINDOW));
      const nextText = `${n.a.kind === "reminder" ? "Next reminder" : "Next alarm"} in ${left(ms)}`;
      // Same list as last time: move the ring, the bell's mood and the "in ..." text in place (no entrance replay).
      const k = JSON.stringify(list.slice(0, 5).map(({ a, t }) => [a.id, a.label, t, a.repeat])) + when(n.t);
      if (k === key && el.querySelector(".al-hero")) {
        el.querySelector(".al-hero").className = `al-hero ${urgency(ms)}`;
        el.querySelector(".al-prog").style.strokeDashoffset = (RING * (1 - frac)).toFixed(1);
        el.querySelector(".al-next").textContent = nextText;
        return;
      }
      key = k;
      el.innerHTML = `
        <div class="al-hero ${urgency(ms)}">
          <div class="al-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="al-track" cx="50" cy="50" r="42"/>
            <circle class="al-prog" cx="50" cy="50" r="42" style="stroke-dasharray:${RING.toFixed(1)};stroke-dashoffset:${(RING * (1 - frac)).toFixed(1)}"/></svg>
            <span class="al-bell">${n.a.kind === "reminder" ? "🔔" : "⏰"}</span></div>
          <div><div class="al-next">${nextText}</div>
            <div class="al-big grad">${pad(new Date(n.t).getHours())}:${pad(new Date(n.t).getMinutes())}</div></div>
        </div>
        <div class="al-label">${esc(n.a.label)}</div>
        <div class="al-list">${list.slice(0, 5).map(({ a, t }) => `
          <div class="al-row"><span>${a.kind === "reminder" ? "🔔" : "⏰"} ${esc(a.label)}</span><span><b>${when(t)}</b> ${a.repeat ? "<small>daily</small>" : ""}</span></div>`).join("")}
        </div>`;
    };
    let last = 0;
    return {
      update(state) { st = state; render(); },
      tick() { if (Date.now() - last > 30000) { last = Date.now(); render(); } },
      show() { last = Date.now(); render(); },
    };
  },
};
