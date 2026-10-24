// Self-test tour (/selftest from the bot, and once by itself after each new UI version): every card of the layout is
// shown for 3 s in turn, and for each one the phone measures what it really did: drawn or blank, errors thrown, time to
// the first painted frame, frames per second, long frames, plus a picture of the screen (snap.js). The rows go to the
// hub ({t:"selftest"}) and the pictures as one contact sheet (an encrypted upload, kind "selftest"); the bot sends
// the owner one short table. A card that does not pass is left out of the cycle until a later test passes it (main.js).
import { nextFrame } from "./motion.js";
import { snapScreen } from "./snap.js";

export const PASS_FPS = 40;
const SHOW_MS = 3000;
const THUMB = 0.5; // pictures at half the CSS size
const LABEL_H = 30;
const COLS = 4;

const frame = () => new Promise((r) => nextFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shows one card and measures it. show(i) is main.js show(); errors come from diag.js listeners.
async function measure(i, { show, el, isBlank, diag }) {
  const errs = [];
  const listen = (e) => { if (e.kind !== "fetch") errs.push(e.msg); }; // a failed fetch now is the relay link, not the card
  diag.listeners.add(listen);
  try {
    const t0 = performance.now();
    show(i);
    await frame();
    await frame(); // the second callback runs after the first frame with the card in it was painted
    const paint = Math.round(performance.now() - t0);
    // frame rate over the rest of the 3 s
    let frames = 0, long = 0, worst = 0, prev = 0;
    const f0 = performance.now();
    await new Promise((done) => {
      const step = (now) => {
        if (prev) { const g = now - prev; if (g > 50) long++; if (g > worst) worst = g; }
        prev = now;
        frames++;
        if (now - t0 < SHOW_MS) nextFrame(step); else done();
      };
      nextFrame(step);
    });
    const fps = Math.round(((frames - 1) * 1000) / Math.max(1, prev - f0));
    const blank = isBlank(el);
    const fallback = !!el.querySelector(".card-fallback");
    return { paint, fps, long, worst: Math.round(worst), blank, fallback, errs };
  } finally {
    diag.listeners.delete(listen);
  }
}

// cards: [{ type, el }]; show(i); isBlank(el); diag: Diag; restore(): back to the normal screen
export async function runSelfTest({ cards, show, isBlank, diag, restore = () => {}, badge = null, onRow = () => {} }) {
  const rows = [];
  const n = cards.length;
  const rowsN = Math.ceil(n / COLS);
  const W = Math.round(window.innerWidth * THUMB), H = Math.round(window.innerHeight * THUMB);
  let sheet = document.createElement("canvas");
  sheet.width = W * Math.min(COLS, n);
  sheet.height = (H + LABEL_H) * rowsN;
  const g = sheet.getContext("2d");
  g.fillStyle = "#111";
  g.fillRect(0, 0, sheet.width, sheet.height);
  let shots = 0, shotErr = "";
  const pngs = []; // { name, bytes }: each card at its full CSS size, for the hub's per-card files
  try {
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      if (badge) badge.textContent = `Self-test ${i + 1}/${n}`;
      const m = await measure(i, { show, el: c.el, isBlank, diag });
      const ok = !m.blank && !m.fallback && !m.errs.length && m.fps >= PASS_FPS;
      const empty = !!c.el.querySelector(".card-body .empty:not(.card-fallback)") && [...c.el.querySelectorAll(".card-body .empty:not(.card-fallback)")].some((e) => e.textContent.trim() && getComputedStyle(e).display !== "none");
      const row = { card: c.type, ok, empty, blank: m.blank || m.fallback, errors: m.errs.length, err: (m.errs[0] || "").slice(0, 120),
        paint: m.paint, fps: m.fps, long: m.long, worst: m.worst };
      // the picture, after the measured window so it does not cost the card frames
      const x = (i % COLS) * W, y = Math.floor(i / COLS) * (H + LABEL_H);
      try {
        const shot = await snapScreen(1);
        if (shot) {
          g.drawImage(shot, x, y, W, H);
          shots++;
          const b = await new Promise((r) => { try { shot.toBlob(r, "image/png"); } catch { r(null); } });
          if (b) pngs.push({ name: c.type, bytes: new Uint8Array(await b.arrayBuffer()) });
        }
      } catch (e) { shotErr = String(e && e.message || e).slice(0, 120); }
      g.fillStyle = ok ? "#14532d" : "#7f1d1d";
      g.fillRect(x, y + H, W, LABEL_H);
      g.fillStyle = "#fff";
      g.font = "bold 15px sans-serif";
      g.fillText(`${ok ? "OK" : "FAIL"} ${c.type} ${m.fps}fps`, x + 6, y + H + 20);
      rows.push(row);
      onRow(row);
      await sleep(50);
    }
  } finally {
    if (badge) badge.textContent = "";
    restore();
  }
  let jpeg = null;
  if (shots) {
    const blob = await new Promise((r) => { try { sheet.toBlob(r, "image/jpeg", 0.72); } catch { r(null); } });
    if (blob) jpeg = new Uint8Array(await blob.arrayBuffer());
  }
  sheet = null;
  return { rows, jpeg, shots, shotErr, pack: pngs.length ? packFiles(pngs) : null };
}

// Several files as one upload: [4-byte header length][header JSON {files:[{name,len}]}][the files, in order].
// The hub unpacks it (hub selftest.js unpack) into one PNG per card.
export function packFiles(files) {
  const head = new TextEncoder().encode(JSON.stringify({ files: files.map((f) => ({ name: f.name, len: f.bytes.length })) }));
  const out = new Uint8Array(4 + head.length + files.reduce((n, f) => n + f.bytes.length, 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let o = 4 + head.length;
  for (const f of files) { out.set(f.bytes, o); o += f.bytes.length; }
  return out;
}
