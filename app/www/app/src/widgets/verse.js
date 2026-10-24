// Quran verse of the day (hub: api.alquran.cloud, cached per local date). Arabic in Uthmani script, the translation
// chosen with /verse english|urdu, the surah and ayah number, and the named translation it comes from.
// The text is the source's, set with textContent: nothing on the phone changes a word.
// Motion: an eight-point star turns slowly behind the heading, a soft light passes over the Arabic, and a verse too
// long for the card scrolls gently.
import { nextFrame } from "../motion.js";

const STAR = `<svg class="vs-star" viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.2">
  <rect x="22" y="22" width="56" height="56"/><rect x="22" y="22" width="56" height="56" transform="rotate(45 50 50)"/>
  <circle cx="50" cy="50" r="13"/></g></svg>`;

export default {
  type: "verse",
  title: "Verse of the day",
  mount(el) {
    el.innerHTML = `<div class="vs">
      <div class="vs-head">${STAR}<div class="vs-surah" dir="rtl" lang="ar"></div><div class="vs-ref"></div></div>
      <div class="vs-win"><div class="vs-roll"><p class="vs-ar" dir="rtl" lang="ar"></p><p class="vs-tr"></p></div></div>
      <div class="vs-foot muted"></div>
    </div>`;
    const q = (c) => el.querySelector(c);
    let key = "";
    let st = null;
    const fit = () => {
      // a verse longer than the card scrolls slowly up and back while the card is on screen
      const win = q(".vs-win"), roll = q(".vs-roll");
      const over = roll.scrollHeight - win.clientHeight;
      roll.classList.toggle("scrolls", over > 8);
      roll.style.setProperty("--over", `${-Math.max(0, over)}px`);
      roll.style.setProperty("--dur", `${Math.max(14, over / 8)}s`);
    };
    const draw = () => {
      const v = st && st.verse;
      const lang = st && st.settings && st.settings.verseLang === "ur" ? "ur" : "en";
      const k = v ? `${v.date}|${v.n}|${lang}` : "none";
      if (k === key) return;
      key = k;
      const box = q(".vs");
      if (!v) {
        box.classList.add("none");
        q(".vs-ar").textContent = "";
        q(".vs-tr").textContent = "Today's verse comes from api.alquran.cloud through the hub.";
        q(".vs-tr").classList.add("empty"); // nothing to show yet: left out of the cycle (main.js isEmpty)
        q(".vs-surah").textContent = q(".vs-ref").textContent = q(".vs-foot").textContent = "";
        return;
      }
      box.classList.remove("none");
      q(".vs-tr").classList.remove("empty");
      const tr = v.tr[lang];
      q(".vs-surah").textContent = v.surah.name;
      q(".vs-ref").textContent = `${v.surah.englishName} · ${v.surah.number}:${v.ayah}`;
      const ar = q(".vs-ar");
      ar.textContent = v.arabic;
      ar.dataset.len = v.arabic.length > 260 ? "long" : v.arabic.length > 140 ? "mid" : "short";
      const t = q(".vs-tr");
      t.textContent = tr.text;
      t.lang = lang;
      t.dir = lang === "ur" ? "rtl" : "ltr";
      q(".vs-foot").textContent = `${tr.name} · Uthmani text · alquran.cloud`;
      box.classList.remove("in"); void box.offsetWidth; box.classList.add("in");
      nextFrame(fit);
    };
    return {
      update(state) { st = state; draw(); },
      show() { nextFrame(fit); },
    };
  },
};
