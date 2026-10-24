// Performance and blank-card check: the UI from app/www (or another build folder given as the first argument) in
// headless Edge with the CPU slowed 4x (CDP Emulation.setCPUThrottlingRate), portrait 390x844 and landscape
// 844x390, every card of the live layout in turn: frames per second while it is on screen, long frames, and
// whether it is blank (no text, nothing drawn) after 1 s. Frames: C:/tmp/desk-dashboard/perf/<label>-<orient>-<card>.png
// Usage: node scripts/e2e-perf.mjs [buildRoot] [label]
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const require = createRequire(import.meta.url);
const { launchEdge } = require("./lib/browser.cjs");

const ROOT = path.resolve(process.argv[2] || fileURLToPath(new URL("../app/www/", import.meta.url))) + path.sep;
const LABEL = process.argv[3] || "now";
const OUT = "C:/tmp/desk-dashboard/perf";
fs.mkdirSync(OUT, { recursive: true });
const killer = setTimeout(() => { console.error("e2e-perf: hard timeout"); process.exit(2); }, 480000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  const file = p.endsWith(path.sep) ? path.join(p, "index.html") : p;
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const CARDS = ["age", "clock", "weather", "alarms", "agent", "prayer", "countdown", "board", "photos", "quote", "ambient", "verse", "moon", "sun"];
const now = Date.now();
const hh = (i) => `${String((new Date(now).getHours() + i) % 24).padStart(2, "0")}:00`;
const state = {
  settings: { theme: "ember", city: { name: "Pune", country: "IN", lat: 18.52043, lon: 73.85674 }, tz: "Asia/Kolkata", goodnightMode: false, quiet: { on: false } },
  birthdays: [{ name: "Ben", birth: "2023-11-28" }, { name: "Leo", birth: "2026-05-12" }, { name: "Maya", birth: "1994-06-09", tag: "female" }],
  alarms: [{ id: "a1", kind: "alarm", label: "School run", time: "07:30", repeat: "daily" }], events: [{ id: "e1", kind: "once", name: "Trip", date: "2026-12-25" }],
  board: { notes: [{ text: "Milk and bread" }], todos: [{ text: "Water plants", done: false }] },
  weather: { at: now, city: "Pune", current: { temp: 32, feels: 34, humidity: 40, wind: 12, code: 1, text: "Mostly clear", icon: "sun" },
    hourly: Array.from({ length: 8 }, (_, i) => ({ time: hh(i), temp: 32 - (i % 3), rain: 0, icon: i < 2 ? "sun" : "partly" })),
    umbrella: { yes: false, why: "" }, daily: ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"].map((date, i) => ({ date, max: 33 - i, min: 21, icon: "partly" })),
    sunrise: null, sunset: null },
  agent: { enabled: true }, customWidgets: {}, photos: [], verse: null, prayer: null, islamic: null,
  activeLayout: "home", layouts: [{ id: "home", name: "Home", cycleSeconds: 600, widgets: CARDS.map((type, i) => ({ id: `w${i}`, type })) }],
};

const results = [];
const { page, close, context } = await launchEdge({ headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Kolkata" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  const cdp = await (context || page.context()).newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (const [orient, w, h] of [["portrait", 390, 844], ["landscape", 844, 390]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${base}index.html`);
    await page.evaluate((s) => { localStorage.setItem("dash.state", JSON.stringify(s)); localStorage.removeItem("dash.lowpower"); }, state);
    await page.goto(`${base}index.html`);
    await page.waitForFunction(() => window.__dash && window.__dash.cards.length > 10, null, { timeout: 30000 });
    await page.evaluate(() => { document.getElementById("pair").classList.add("hidden"); if (window.__dash.perf) clearTimeout(window.__dash.perf.timer); });
    await sleep(1500);
    for (const card of CARDS) {
      await page.evaluate((t) => window.__dash.goTo(t), card);
      await sleep(1000);
      const blank = await page.evaluate((t) => {
        const b = document.querySelector(`.card[data-type="${t}"] .card-body`);
        const text = (b.innerText || "").trim();
        const drawn = [...b.querySelectorAll("svg, canvas, img")].some((n) => n.getBoundingClientRect().width > 8);
        const fallback = !!b.querySelector(".card-fallback");
        // content cut off: an in-flow element (two levels down) reaching outside the card's box
        const card = b.closest(".card").getBoundingClientRect();
        const over = [...b.querySelectorAll(":scope > *, :scope > * > *")].some((n) => {
          if (getComputedStyle(n).position === "absolute" || n.closest(".wx-scene, .clock-sky")) return false;
          const q = n.getBoundingClientRect();
          return q.height > 0 && (q.bottom > card.bottom + 2 || q.top < card.top - 2);
        });
        return { blank: !text && !drawn, fallback, over };
      }, card);
      // frames while the card is on screen (its animations running), 2.5 s
      const f = await page.evaluate(() => new Promise((res) => {
        let n = 0, long = 0, prev = 0; const t0 = performance.now();
        const step = (t) => { if (prev && t - prev > 50) long++; prev = t; n++; if (t - t0 < 2500) requestAnimationFrame(step); else res({ fps: Math.round(((n - 1) * 1000) / (t - t0)), long }); };
        requestAnimationFrame(step);
      }));
      await page.screenshot({ path: path.join(OUT, `${LABEL}-${orient}-${card}.png`) });
      results.push({ orient, card, ...f, ...blank });
      console.log(`${orient.padEnd(9)} ${card.padEnd(10)} ${String(f.fps).padStart(3)} fps ${String(f.long).padStart(3)} long${blank.blank ? "  BLANK" : ""}${blank.fallback ? "  fallback" : ""}${blank.over ? "  overflows" : ""}`);
    }
  }
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
const avg = (o) => { const r = results.filter((x) => x.orient === o); return Math.round(r.reduce((a, x) => a + x.fps, 0) / r.length); };
const blanks = results.filter((r) => r.blank).map((r) => `${r.orient}/${r.card}`);
console.log(`\n${LABEL}: average ${avg("portrait")} fps portrait, ${avg("landscape")} fps landscape (CPU 4x slower); blank: ${blanks.join(", ") || "none"}; overflow: ${results.filter((r) => r.over).map((r) => `${r.orient}/${r.card}`).join(", ") || "none"}; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify({ results, errors }, null, 1));
process.exit(blanks.length || errors.length ? 1 : 0);
