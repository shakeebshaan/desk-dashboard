// Agent card: the 3D character, what it says, and push-to-talk (disabled while the hub's agent is off).
import { Agent3D } from "../agent3d.js";

const MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;

export default {
  type: "agent",
  title: "Jarvis",
  mount(el, ctx) {
    el.style.padding = "0";
    el.innerHTML = `<div class="agent-canvas"></div>
      <div class="agent-ui"><div class="agent-caption"></div><div class="agent-state">idle</div>
      <button class="ptt" disabled title="Push to talk">${MIC}</button></div>`;
    let a3d = null;
    try {
      a3d = new Agent3D(el.querySelector(".agent-canvas"));
    } catch (e) {
      el.querySelector(".agent-canvas").innerHTML = `<div class="pair-orb" style="margin-top:30%"></div>`;
    }
    const cap = el.querySelector(".agent-caption"), stateEl = el.querySelector(".agent-state"), ptt = el.querySelector(".ptt");
    ptt.addEventListener("click", () => ctx.onTalk && ctx.onTalk());
    const api = {
      a3d,
      setState(s) {
        stateEl.textContent = s;
        el.dataset.state = s;
        if (a3d) a3d.setState(s);
      },
      caption(text) {
        cap.innerHTML = "";
        String(text).split(/\s+/).forEach((w, i) => {
          const s = document.createElement("span");
          s.className = "w";
          s.textContent = w + " ";
          s.style.animationDelay = `${i * 0.09}s`;
          cap.appendChild(s);
        });
      },
      pulse(v) { if (a3d) a3d.pulse(v); },
      update(state) {
        const on = state.agent && state.agent.enabled;
        ptt.disabled = !on;
        ptt.title = on ? "Push to talk" : "Agent offline";
        // The placeholder follows the hub's on/off state; a spoken caption stays until the next one.
        if (!cap.textContent || cap.querySelector(".muted[data-ph]")) {
          cap.innerHTML = `<span class="muted" data-ph>${on ? "Tap the mic to talk." : "Agent offline. Send me text from Telegram and I'll say it."}</span>`;
        }
        const cs = getComputedStyle(document.body);
        if (a3d) a3d.setColors(cs.getPropertyValue("--a1").trim() || "#38e1d0", cs.getPropertyValue("--a2").trim() || "#8b6cff");
      },
      show() { if (a3d) { a3d.resize(); a3d.setVisible(true); } },
      hide() { if (a3d) a3d.setVisible(false); },
    };
    ctx.agentCard = api;
    return api;
  },
};
