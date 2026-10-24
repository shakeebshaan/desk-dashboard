// Prayer times for the dashboard city (hub: Aladhan; method and Asr school from /prayer): the next prayer with a
// live countdown, and today's five. A bell marks prayers with an alarm (/prayer alarm).
// Motion: the countdown rolls each second, tonight's moon sits by the Hijri date, a few stars twinkle around the
// next prayer and a soft light sweeps its row.
import { prayerBoard } from "../prayer.js";
import { roll, moonHtml, moonPhase } from "../motion.js";
import { wallNow } from "../events.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pad = (n) => String(n).padStart(2, "0");

export default {
  type: "prayer",
  title: "Prayer times",
  mount(el) {
    let key = "", st = null;
    const draw = () => {
      const now = wallNow();
      const b = st && prayerBoard(st.prayer, now);
      const k = b ? `${b.day.date}|${b.next && b.next.key}|${JSON.stringify((st.settings.prayer || {}).alarms || {})}` : `none|${!!(st && st.settings && st.settings.city)}`;
      if (k !== key) {
        key = k;
        if (!b) {
          el.innerHTML = `<p class="empty">${st && st.settings && st.settings.city ? "Fetching prayer times..." : "Send <code>/city Pune</code><br>to the bot."}</p>`;
          return;
        }
        const alarms = (st.settings.prayer || {}).alarms || {};
        el.innerHTML = `
          <div class="pr-head muted">${moonHtml(moonPhase(), "pr-moon")}${esc(st.prayer.city)} · ${esc(b.day.hijri || "")}</div>
          <div class="pr-next"><i class="pr-star fx-p"></i><i class="pr-star fx-p"></i><i class="pr-star fx-p"></i><span class="pr-label">${b.next ? (b.next.tomorrow ? "Next · tomorrow" : "Next") : ""}</span>
            <div class="pr-name">${b.next ? b.next.name : "-"}</div><div class="pr-at">${b.next ? b.next.time : ""}</div>
            <div class="pr-count">in <span></span></div></div>
          <div class="pr-list">${b.list.map((p, i) => `
            <div class="pr-row ${p.past ? "past" : ""} ${b.next && !b.next.tomorrow && b.next.key === p.key ? "next" : ""}" style="animation-delay:${i * 0.06}s">
              <b>${p.name}</b><span>${alarms[p.key] && alarms[p.key] !== "off" ? `<i title="${alarms[p.key]}">🔔</i>` : ""}${p.time}</span></div>`).join("")}
          </div>
          <div class="pr-foot muted">Sunrise ${b.sunrise} · ${esc(st.prayer.methodName || "")} · Asr ${esc(st.prayer.asr || "")}</div>`;
      }
      const c = el.querySelector(".pr-count span");
      if (c && b && b.next) {
        const s = Math.max(0, Math.floor((b.next.at - now) / 1000));
        roll(c, `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`);
      }
    };
    return {
      update(state) { st = state; draw(); },
      tick(state) { st = state; draw(); },
    };
  },
};
