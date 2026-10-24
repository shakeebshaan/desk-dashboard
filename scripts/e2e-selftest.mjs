// Self-test tour (selftest.js) and the error catcher (diag.js) in headless Edge, CPU 4x slower, portrait 390x844:
// runs the phone's own /selftest, prints its rows, saves its contact sheet to C:/tmp/desk-dashboard/selftest/sheet.jpg,
// then makes a script error, a rejected promise, console.error, a 404 fetch and a broken picture and checks diag caught each.
// Usage: node scripts/e2e-selftest.mjs [buildRoot]

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
const OUT = "C:/tmp/desk-dashboard/selftest";
fs.mkdirSync(OUT, { recursive: true });
const killer = setTimeout(() => { console.error("e2e-selftest: hard timeout"); process.exit(2); }, 480000);
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



const { page, close, context } = await launchEdge({ headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Kolkata" });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
let fail = 0;
try {
  const cdp = await (context || page.context()).newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem("dash.state", JSON.stringify(s)); }, state);
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length > 10, null, { timeout: 30000 });
  await page.evaluate(() => { document.getElementById("pair").classList.add("hidden"); clearTimeout(window.__dash.perf.timer); });
  await sleep(1500);
  const t0 = Date.now();
  const r = await page.evaluate(async () => {
    await window.__dash.selfTest("manual");
    const x = window.__dash.lastSelfTest;
    let b64 = "";
    if (x && x.jpeg) { let s = ""; for (let i = 0; i < x.jpeg.length; i += 8192) s += String.fromCharCode(...x.jpeg.subarray(i, i + 8192)); b64 = btoa(s); }
    return { pack: x && x.pack ? x.pack.length : 0, rows: x ? x.rows : null, shots: x && x.shots, shotErr: x && x.shotErr, b64, skips: window.__dash.skips, index: window.__dash.index, touring: window.__dash.touring };
  });
  console.log(`self-test took ${((Date.now() - t0) / 1000).toFixed(1)} s, ${r.shots} pictures, card PNG pack ${Math.round(r.pack / 1024)} KB${r.shotErr ? ` (picture error: ${r.shotErr})` : ""}`);
  for (const x of r.rows || []) console.log(`${x.ok ? "OK  " : "FAIL"} ${x.card.padEnd(10)} ${String(x.fps).padStart(3)} fps ${String(x.paint).padStart(5)} ms paint ${x.long} long${x.blank ? " BLANK" : ""}${x.errors ? ` ${x.errors} errors: ${x.err}` : ""}`);
  if (r.b64) fs.writeFileSync(path.join(OUT, "sheet.jpg"), Buffer.from(r.b64, "base64"));
  if (!r.rows || r.rows.length !== CARDS.length) { fail++; console.log("FAIL: not one row per card"); }
  if (!r.shots) { fail++; console.log("FAIL: no pictures"); }
  if (r.touring) { fail++; console.log("FAIL: still touring"); }
  console.log(`left out: ${JSON.stringify(Object.keys(r.skips))}`);

  // diag.js: each kind of error is caught, with the card on screen; the same error twice = one entry, n = 2
  const d = await page.evaluate(async () => {
    window.__dash.goTo("clock");
    setTimeout(() => { throw new Error("boom-js"); }, 0);
    setTimeout(() => { throw new Error("boom-js"); }, 5);
    Promise.reject(new Error("boom-promise"));
    console.error("boom-console", { a: 1 });
    await fetch("/nope-404.json").catch(() => {});
    await fetch("http://127.0.0.1:1/x").catch(() => {});
    const img = new Image(); img.src = "/missing.png"; document.body.appendChild(img);
    await new Promise((r) => setTimeout(r, 1500));
    img.remove();
    return [...window.__dash.diag.entries.values()].map((e) => ({ kind: e.kind, card: e.card, n: e.n, msg: e.msg }));
  });
  for (const e of d) console.log(`diag ${e.kind.padEnd(8)} card=${e.card} n=${e.n} ${e.msg.slice(0, 90)}`);
  const want = [["js", /boom-js/, 2], ["promise", /boom-promise/, 1], ["console", /boom-console/, 1], ["fetch", /404 .*nope-404/, 1], ["fetch", /127\.0\.0\.1:1/, 1], ["asset", /img did not load: .*missing\.png/, 1]];
  for (const [kind, re, n] of want) {
    const hit = d.find((e) => e.kind === kind && re.test(e.msg));
    if (!hit || hit.n !== n || hit.card !== "clock") { fail++; console.log(`FAIL: diag ${kind} ${re} (got ${hit ? `n=${hit.n} card=${hit.card}` : "nothing"})`); }
  }
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
console.log(`page errors (expected: boom-js, boom-promise): ${pageErrors.join(" | ") || "none"}`);
console.log(fail ? `${fail} check(s) FAILED` : "all checks passed");
process.exit(fail ? 1 : 0);
