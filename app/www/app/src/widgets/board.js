// Family board: notes and a to-do list, edited from the bot (/note, /todo), shown until cleared.
// Motion: notes sway on their tape, toss in when the card comes, ticks pop, and clearing the last to-do throws confetti.
import { burst } from "../motion.js";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TINTS = ["#ffd56b", "#7cf0c8", "#ff9ec4", "#9cc4ff", "#c9a7ff", "#ffb38a"];

export default {
  type: "board",
  title: "Family board",
  mount(el) {
    let key = "";
    let wasLeft = -1;
    return {
      update(state) {
        const b = state.board || { notes: [], todos: [] };
        const k = JSON.stringify(b);
        if (k === key) return;
        key = k;
        if (!b.notes.length && !b.todos.length) {
          el.innerHTML = `<p class="empty">Nothing on the board.<br>Send <code>/note Milk and bread</code><br>or <code>/todo add Pay the bill</code> to the bot.</p>`;
          return;
        }
        const left = b.todos.filter((t) => !t.done).length;
        const cheer = wasLeft > 0 && left === 0 && b.todos.length > 0;
        wasLeft = left;
        el.innerHTML = `
          ${b.notes.length ? `<div class="bd-notes">${b.notes.slice(-6).map((n, i) => `
            <div class="note" style="--tint:${TINTS[i % TINTS.length]};--r:${((i * 37) % 7) - 3}deg;animation-delay:${i * 0.07}s">${esc(n.text)}</div>`).join("")}</div>` : ""}
          ${b.todos.length ? `<div class="todo-head"><b>To-do</b><span>${left ? `${left} left` : "all done 🎉"}</span></div>
          <ul class="todo">${b.todos.map((t, i) => `<li class="${t.done ? "done" : ""}" style="animation-delay:${0.1 + i * 0.05}s"><i></i><span>${esc(t.text)}</span><small>${i + 1}</small></li>`).join("")}</ul>` : ""}`;
        if (cheer) setTimeout(() => burst(el, { n: 24, y: "60%" }), 400);
      },
    };
  },
};
