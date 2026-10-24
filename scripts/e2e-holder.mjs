// The phone in its wall holder: every card at the phone's size (360x780, portrait) with the holder drawn over the
// bottom band (28 % unless the second argument says otherwise), screenshots in C:/tmp/desk-dashboard/holder/<label>/,
// and for each card: how much of the visible card its content fills, and whether anything of it reaches the band.
// Usage: node scripts/e2e-holder.mjs [label] [band%]

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const require = createRequire(import.meta.url);
const { launchEdge } = require("./lib/browser.cjs");

const ROOT = fileURLToPath(new URL("../app/www/", import.meta.url));
const LABEL = process.argv[2] || "now";
const BAND = Number(process.argv[3] ?? 28);
const OUT = `C:/tmp/desk-dashboard/holder/${LABEL}`;
fs.mkdirSync(OUT, { recursive: true });
const killer = setTimeout(() => { console.error("e2e-holder: hard timeout"); process.exit(2); }, 480000);
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
state.settings.holder = BAND;

const { page, close } = await launchEdge({ headless: true, viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Kolkata" });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const rows = [];
try {
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem("dash.state", JSON.stringify(s)); }, state);
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length > 10, null, { timeout: 30000 });
  await page.evaluate((band) => {
    document.getElementById("pair").classList.add("hidden");
    clearTimeout(window.__dash.perf.timer);
    const h = document.createElement("div");
    h.dataset.nosnap = "1";
    h.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${band}vh;z-index:99;background:rgba(214,206,236,0.82);border-top:2px solid #b9aedc;color:#5b5480;font:600 13px sans-serif;display:flex;align-items:flex-end;justify-content:center;padding-bottom:8px;pointer-events:none`;
    h.textContent = `wall holder (bottom ${band}%)`;
    document.body.appendChild(h);
  }, BAND);
  await sleep(1500);
  for (const card of CARDS) {
    await page.evaluate((t) => window.__dash.goTo(t), card);
    await sleep(2600);
    const m = await page.evaluate(({ t, band }) => {
      const el = document.querySelector(`.card[data-type="${t}"]`);
      const c = el.getBoundingClientRect();
      const bandTop = innerHeight * (1 - band / 100);
      // content: text runs and drawn things (svg, canvas, img) that can be seen
      let top = Infinity, bottom = -Infinity, under = [], small = 0;
      const walker = document.createTreeWalker(el.querySelector(".card-body"), NodeFilter.SHOW_TEXT);
      const boxes = [];
      for (let n; (n = walker.nextNode());) {
        if (!n.textContent.trim()) continue;
        const p = n.parentElement, cs = getComputedStyle(p);
        if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        const q = r.getBoundingClientRect();
        if (!q.height || q.top >= c.bottom || q.bottom <= c.top) continue; // clipped away by the card (a scrolling verse)
        boxes.push(q);
        if (parseFloat(cs.fontSize) < 12) small++;
        if (Math.min(q.bottom, c.bottom) > bandTop + 1) under.push(n.textContent.trim().slice(0, 24));
      }
      for (const n of el.querySelectorAll(".card-body svg, .card-body canvas, .card-body img, .card-body .amb")) { // .amb: the ambient card's sky is its content
        const q = n.getBoundingClientRect();
        if (q.width > 20 && q.height > 20) boxes.push(q);
      }
      for (const q of boxes) { top = Math.min(top, q.top); bottom = Math.max(bottom, Math.min(q.bottom, c.bottom)); }
      const visH = Math.min(c.bottom, bandTop) - c.top;
      return { fill: boxes.length ? Math.round(((Math.min(bottom, bandTop) - Math.max(top, c.top)) / visH) * 100) : 0,
        empty: [...el.querySelectorAll(".card-body .empty:not(.card-fallback)")].some((e) => e.textContent.trim() && getComputedStyle(e).display !== "none"),
        cardBottom: Math.round(c.bottom), bandTop: Math.round(bandTop), under, small, scaled: el.querySelector(".card-body").style.transform || "" };
    }, { t: card, band: BAND });
    await page.screenshot({ path: path.join(OUT, `${card}.png`) });
    rows.push({ card, ...m });
    console.log(`${card.padEnd(10)}${m.empty ? " (empty: left out)" : ""} fill ${String(m.fill).padStart(3)}%  card ends ${m.cardBottom} (band from ${m.bandTop})${m.scaled ? `  ${m.scaled}` : ""}${m.small ? `  ${m.small} texts under 12px` : ""}${m.under.length ? `  UNDER BAND: ${m.under.join(" | ")}` : ""}`);
  }
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ rows, pageErrors }, null, 1));
// empty cards are left out of the cycle on the phone, so they are not judged here
const bad = rows.filter((r) => !r.empty && (r.under.length || r.fill < 55 || /scale\(0\.[0-8]/.test(r.scaled)));
console.log(`page errors: ${pageErrors.join(" | ") || "none"}; under the band or under 55 % filled: ${bad.map((r) => r.card).join(", ") || "none"}`);
process.exit(bad.length || pageErrors.length ? 1 : 0);
