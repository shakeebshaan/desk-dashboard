// Ambient: slow aurora ribbons and drifting motes behind a small clock. Transform/opacity only (cheap on an old
// GPU), and the clock wanders a few pixels over minutes so nothing stays lit in one place (burn-in).
const pad = (n) => String(n).padStart(2, "0");

export default {
  type: "ambient",
  title: "Ambient",
  mount(el) {
    el.style.padding = "0";
    const motes = Array.from({ length: 18 }, (_, i) =>
      `<i style="left:${(i * 53) % 100}%;animation-delay:-${(i * 2.3) % 17}s;animation-duration:${14 + (i % 5) * 3}s;--s:${0.5 + (i % 4) * 0.35}"></i>`).join("");
    el.innerHTML = `<div class="amb"><div class="amb-r r1"></div><div class="amb-r r2"></div><div class="amb-r r3"></div>
      <div class="amb-motes fx-p">${motes}</div><div class="amb-shoot fx-p"><i></i><i></i></div><div class="amb-flies fx-p"></div>
      <div class="amb-clock"><b></b><span></span></div></div>`;
    const flies = el.querySelector(".amb-flies");
    let night = null;
    const b = el.querySelector(".amb-clock b"), s = el.querySelector(".amb-clock span");
    return {
      update() {},
      tick() {
        const d = new Date();
        const n = d.getHours() >= 19 || d.getHours() < 6;
        if (n !== night) {
          night = n;
          flies.innerHTML = n ? Array.from({ length: 7 }, (_, i) => `<i style="left:${10 + ((i * 37) % 80)}%;top:${25 + ((i * 31) % 55)}%;animation-delay:-${i * 1.9}s,-${(i * 0.8).toFixed(1)}s"></i>`).join("") : "";
        }
        b.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        s.textContent = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
      },
    };
  },
};
