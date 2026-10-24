// Photo frame: the photos the owner sends to the bot. They stay on the hub; the phone holds them in memory only
// (files.js). A slow pan-and-zoom, a cross-fade every 9 s, and dimmed between 22:00 and 06:00.
export const NIGHT_FROM = 22, NIGHT_TO = 6;
export const isNightHour = (h) => h >= NIGHT_FROM || h < NIGHT_TO;

export default {
  type: "photos",
  title: "Photo frame",
  mount(el, ctx) {
    el.style.padding = "0";
    el.innerHTML = `<div class="pf"><div class="pf-a"></div><div class="pf-b"></div><p class="empty pf-empty"></p><div class="pf-count"></div></div>`;
    const box = el.querySelector(".pf"), layers = [el.querySelector(".pf-a"), el.querySelector(".pf-b")];
    const empty = el.querySelector(".pf-empty"), count = el.querySelector(".pf-count");
    let ids = [], i = 0, front = 0, timer = null, shown = null, want = null;
    const ready = () => ids.filter((id) => ctx.files && ctx.files.url(id));
    const paint = () => {
      const r = ready();
      empty.innerHTML = !ids.length ? "The photo frame is empty.<br>Send a photo to the bot:<br>it stays on the hub only." : r.length ? "" : "Loading photos...";
      empty.style.display = r.length ? "none" : "";
      count.textContent = r.length > 1 ? `${(i % r.length) + 1} / ${r.length}` : "";
      if (!r.length) { layers.forEach((l) => { l.style.backgroundImage = ""; l.classList.remove("on"); }); shown = null; return; }
      if (want && r.includes(want)) { i = r.indexOf(want); want = null; } // a photo that just arrived goes first
      const id = r[i % r.length];
      if (id === shown) return;
      shown = id;
      front ^= 1;
      const l = layers[front];
      l.style.backgroundImage = `url("${ctx.files.url(id)}")`;
      l.classList.remove("on");
      void l.offsetWidth;
      l.classList.add("on");
      layers[front ^ 1].classList.remove("on");
    };
    const night = () => box.classList.toggle("dim", isNightHour(new Date().getHours()));
    return {
      update(state) {
        ids = (state.photos || []).map((p) => p.id);
        night();
        paint();
      },
      tick() { night(); if (!shown) paint(); },
      show() {
        clearInterval(timer);
        timer = setInterval(() => { i++; paint(); }, 9000);
        paint();
      },
      hide() { clearInterval(timer); },
      // main.js: a new photo came in; show it as soon as its file is here
      event(ev) { if (ev.photo) { want = ev.photo; paint(); } },
    };
  },
};
