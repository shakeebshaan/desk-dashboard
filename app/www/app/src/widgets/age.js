// Birthdays: one person at a time, with smooth transitions, counting numbers, a ring toward the next birthday,
// countdown (hours on the last day), facts and milestones, a family strip, and a celebration on the day.
// Always-on AMOLED: dark, only transform/opacity animations, the whole widget drifts a few px to avoid burn-in,
// nothing runs while the card is hidden.
// Motion: balloons sway as they rise, a sparkle trail sweeps the name as a person comes in, the ages count up,
// the days-old number spins like an odometer, the eve's hour countdown rolls each second, and on the day a cake
// with a flickering candle and a confetti burst.
import { moving, roll, odometer, burst, nextFrame, cancelFrame } from "../motion.js";
import {
  ageBetween, localYmd, parseYmd, nextBirthday, nextBirthdayDate, msToNextBirthday, nextSpecial, familyNext, weekday, UPCOMING_DAYS,
} from "../age.js";

const COLORS = ["var(--a1)", "var(--a2)", "var(--a3)", "#ffd56b", "#7cc4ff"];
const ROTATE_MS = 6500; // next person while the card stays on screen
const RING = 2 * Math.PI * 52;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n, w) => `${w}${n === 1 ? "" : "s"}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const pad = (n) => String(n).padStart(2, "0");
const reduced = () => !moving();
const CAKE = `<span class="cake" role="img" aria-label="birthday cake"><i class="cake-flame"></i><i class="cake-candle"></i><i class="cake-top"></i><i class="cake-base"></i></span>`;
const TRAIL = `<div class="bd-trail fx-p" aria-hidden="true">${[...Array(7)].map((_, i) => `<i style="--i:${i}"></i>`).join("")}</div>`;

// Everyone saved with /birthday (older hubs send one person in `child`); birthdays today come first.
function people(state, t) {
  const list = (Array.isArray(state.birthdays) ? state.birthdays : state.child ? [state.child] : [])
    .map((p) => ({ name: String(p.name || ""), birth: p.birth, b: parseYmd(p.birth) })).filter((p) => p.name && p.b);
  const today = (p) => { const nb = nextBirthday(p.b, t); return nb && nb.days === 0 ? 0 : 1; };
  return list.map((p, i) => ({ ...p, i })).sort((x, y) => today(x) - today(y) || x.i - y.i);
}

const inWords = (d) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);

function countdown(p, nb) {
  if (nb.days === 0) return { big: CAKE, small: "today!", celebrate: true };
  if (nb.days === 1) {
    const ms = Math.max(0, msToNextBirthday(p.b));
    const s = Math.floor(ms / 1000);
    return { big: `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`, small: "hours to go", clock: true };
  }
  return { big: fmt(nb.days), small: `${plural(nb.days, "day")} to go`, num: nb.days };
}

export default {
  type: "age",
  title: "Birthdays",
  mount(el) {
    el.innerHTML = `<div class="bd">
      <div class="balloons">${[...Array(6)].map((_, i) =>
        `<i style="left:${10 + i * 15}%;background:${COLORS[i % 5]};animation-delay:-${i * 2.4}s;--dx:${(i % 2 ? -1 : 1) * (10 + i * 4)}px"></i>`).join("")}</div>
      <div class="bd-next"></div>
      <div class="bd-stage"></div>
      <div class="bd-strip"></div>
      <div class="bd-confetti"></div>
    </div>`;
    const q = (c) => el.querySelector(c);
    let list = [];
    let idx = 0;
    let key = "";
    let visible = false;
    let rotate = null;
    let raf = 0;

    const countUp = (root) => {
      cancelFrame(raf);
      const els = [...root.querySelectorAll("[data-n]")];
      if (reduced()) return;
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 1100);
        const e = 1 - Math.pow(1 - k, 3);
        for (const n of els) n.textContent = fmt(+n.dataset.n * e);
        if (k < 1) raf = nextFrame(step);
      };
      for (const n of els) n.textContent = "0";
      raf = nextFrame(step);
    };

    const confetti = (on) => {
      const c = q(".bd-confetti");
      if (!on) { c.innerHTML = ""; return; }
      if (c.childElementCount) return;
      c.innerHTML = [...Array(24)].map((_, i) => `<i style="left:${(i * 41) % 100}%;background:${COLORS[i % 5]};animation-delay:-${(i * 0.37) % 5}s;animation-duration:${4.5 + (i % 5) * 0.6}s;--r:${(i % 2 ? -1 : 1) * (180 + i * 20)}deg"></i>`).join("");
    };

    const strip = (t) => {
      if (list.length < 2) { q(".bd-strip").innerHTML = q(".bd-next").innerHTML = ""; return; }
      const nx = familyNext(list, t);
      q(".bd-next").innerHTML = nx ? `<span>Next up</span><b>${esc(nx.name)}</b><span>${nx.nb.days === 0 ? "\u{1F382} today" : inWords(nx.nb.days)}</span>` : "";
      q(".bd-strip").innerHTML = list.map((p, i) => {
        const nb = nextBirthday(p.b, t);
        const cls = !nb ? "" : nb.days === 0 ? " today" : nb.days <= UPCOMING_DAYS ? " soon" : "";
        const when = !nb ? "soon" : nb.days === 0 ? "\u{1F382}" : `${nb.days}d`;
        return `<span class="bd-chip${cls}${i === idx ? " on" : ""}">${esc(p.name)}<i>${when}</i></span>`;
      }).join("");
    };

    const person = (p, t) => {
      const a = ageBetween(p.b, t);
      if (!a) {
        return `<section class="bd-person"><div class="bd-name grad">${esc(p.name)}</div><div class="bd-sub">arriving soon</div></section>`;
      }
      const nb = nextBirthday(p.b, t);
      const nd = nextBirthdayDate(p.b, t);
      const cd = countdown(p, nb);
      const sp = nextSpecial(p.b, t);
      const baby = a.years === 0;
      const ageRow = `<b data-n="${a.years}">${a.years}</b><span>${a.years === 1 ? "yr" : "yrs"}</span><b data-n="${a.months}">${a.months}</b><span>mo</span><b data-n="${a.days}">${a.days}</b><span>${plural(a.days, "day")}</span>`;
      const oldTile = baby
        ? `<div><b data-n="${Math.floor(a.totalDays / 7)}">${Math.floor(a.totalDays / 7)}</b><span>weeks old (${fmt(a.totalDays)} days)</span></div>`
        : `<div><b class="bd-odo" data-odo="${fmt(a.totalDays)}">${fmt(a.totalDays)}</b><span>days old</span></div>`;
      const nextTile = `<div><b>${weekday(nd).slice(0, 3)} ${nd.d} ${MONTHS[nd.m - 1]}</b><span>${nb.days === 0 ? "birthday today" : `next birthday, ${nd.y}`}</span></div>`;
      const spTile = sp
        ? `<div class="${sp.inDays === 0 ? "hot" : ""}"><b>${sp.inDays === 0 ? "\u{1F389} " : ""}${sp.kind === "half" ? "Half-birthday" : sp.label}</b><span>${sp.kind === "half" ? `${sp.label} ${inWords(sp.inDays)}` : sp.inDays === 0 ? "old today!" : inWords(sp.inDays)}</span></div>`
        : "";
      const bornTile = `<div><b>${weekday(p.b)}</b><span>born on a</span></div>`;
      const ring = `<div class="bd-ring${cd.celebrate ? " party" : ""}">
          <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="bd-track" cx="60" cy="60" r="52"/><circle class="bd-prog" cx="60" cy="60" r="52"
            style="stroke-dasharray:${RING.toFixed(1)};stroke-dashoffset:${RING.toFixed(1)}" data-off="${(RING * (1 - nb.frac)).toFixed(1)}"/></svg>
          <div class="bd-count"><b class="${cd.clock ? "clock" : ""}"${cd.num !== undefined ? ` data-n="${cd.num}"` : ""}>${cd.big}</b><span>${cd.small}</span>
            <em>turns <b>${nb.turns}</b></em></div>
        </div>`;
      return `<section class="bd-person${cd.celebrate ? " celebrate" : ""}">${TRAIL}
        ${cd.celebrate ? `<div class="bd-hb">Happy birthday!</div>` : ""}
        <div class="bd-name grad">${esc(p.name)}</div>
        <div class="bd-age">${ageRow}</div>
        ${ring}
        <div class="bd-facts">${oldTile}${nextTile}${spTile}${bornTile}</div>
      </section>`;
    };

    const render = (animate) => {
      const t = localYmd();
      const stage = q(".bd-stage");
      if (!list.length) {
        stage.innerHTML = `<p class="empty">Send <code>/birthday Name YYYY-MM-DD</code><br>to the bot.</p>`;
        q(".bd-strip").innerHTML = q(".bd-next").innerHTML = "";
        confetti(false);
        return;
      }
      idx = idx % list.length;
      const p = list[idx];
      stage.innerHTML = person(p, t);
      const sec = stage.firstElementChild;
      if (animate && !reduced()) sec.classList.add("enter");
      const prog = sec.querySelector(".bd-prog");
      if (prog) nextFrame(() => nextFrame(() => { prog.style.strokeDashoffset = prog.dataset.off; }));
      if (animate) countUp(sec);
      else for (const n of sec.querySelectorAll("[data-n]")) n.textContent = fmt(+n.dataset.n);
      const odo = sec.querySelector("[data-odo]");
      if (odo && animate) odometer(odo, odo.dataset.odo);
      strip(t);
      const party = visible && sec.classList.contains("celebrate");
      confetti(party);
      if (party && animate) setTimeout(() => burst(q(".bd"), { n: 26, y: "48%", spread: 170 }), 350);
    };

    // Who comes next: on someone's birthday every other turn is theirs; the rest take turns in order.
    let cursor = 0;
    let lastWasToday = false;
    const pick = () => {
      const t = localYmd();
      const today = list.findIndex((p) => { const nb = nextBirthday(p.b, t); return nb && nb.days === 0; });
      if (today >= 0 && !lastWasToday) { lastWasToday = true; return today; }
      lastWasToday = false;
      const others = list.map((_, i) => i).filter((i) => i !== today);
      if (!others.length) return Math.max(0, today);
      return others[cursor++ % others.length];
    };
    const next = () => {
      if (list.length < 2) return;
      idx = pick();
      render(true);
    };

    const sync = (state) => {
      const t = localYmd();
      list = people(state, t);
      const k = `${JSON.stringify(list.map((p) => [p.name, p.birth]))}|${t.y}-${t.m}-${t.d}`;
      if (k !== key) { key = k; render(visible); }
    };

    // Every second while visible: the hour countdown on a birthday's eve.
    const tick = (state) => {
      sync(state);
      const b = q(".bd-count b.clock");
      if (b && list[idx]) roll(b, countdown(list[idx], nextBirthday(list[idx].b, localYmd())).big);
    };

    return {
      update: sync,
      tick,
      show() {
        visible = true;
        if (list.length > 1) idx = pick(); // each visit starts with the next person (birthday person first)
        render(true);
        clearInterval(rotate);
        rotate = setInterval(next, ROTATE_MS);
      },
      hide() {
        visible = false;
        clearInterval(rotate);
        cancelFrame(raf);
        confetti(false);
      },
      get debug() { return { idx, people: list.map((p) => p.name) }; },
    };
  },
};
