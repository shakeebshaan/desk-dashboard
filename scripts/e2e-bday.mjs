// Browser check of the birthday takeover (src/bdayshow.js): the real UI from app/www in headless Edge at 390x844,
// Asia/Kolkata, state seeded into the phone's saved snapshot (no hub). Each of the 5 screens is opened the way
// /birthday preview does it (state.bdayPreview), screenshotted, and checked: right kind, wording, particles drawing,
// tap closes it, an alarm closes it, the day's own takeover comes up by itself on start, motion "off" still draws.
// Frames: C:/tmp/desk-dashboard/bday/*.png.   Usage: node scripts/e2e-bday.mjs
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
const OUT = "C:/tmp/desk-dashboard/bday";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const TZ = "Asia/Kolkata";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e-bday: hard timeout"); process.exit(2); }, 180000);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  const file = p.endsWith(path.sep) ? path.join(p, "index.html") : p;
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const ymd = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const today = ymd(Date.now());
// Sample people covering every tag; Felix (8) shows the default screen.
const FAMILY = [
  { name: "Ben", birth: "2023-11-28" }, { name: "Leo", birth: "2026-05-12" },
  { name: "Omar", birth: "1985-02-08", tag: "head" }, { name: "Maya", birth: "1994-06-09", tag: "female" },
  { name: "Felix", birth: "2018-01-12" },
];
const makeState = ({ birthdays = FAMILY, preview = null, motion } = {}) => ({
  settings: { theme: "aurora", ...(motion ? { motion } : {}) }, birthdays, alarms: [], events: [], weather: null, customWidgets: {}, photos: [],
  agent: { enabled: false }, activeLayout: "home", serverTime: Date.now(),
  bdayPreview: preview ? { name: preview, until: Date.now() + 30000 } : null,
  layouts: [{ id: "home", name: "Home", cycleSeconds: 600, widgets: ["clock", "age"].map((type, i) => ({ id: `w${i}`, type })) }],
});

const { page, close } = await launchEdge({
  headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TZ,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const load = async (st) => {
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => { localStorage.setItem("dash.state", JSON.stringify(s)); }, st);
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length > 1, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById("pair").classList.add("hidden")); // stand-in: no pairing here
};
const view = () => page.evaluate(() => {
  const el = document.getElementById("bday");
  const cv = el.querySelector(".bs-fx");
  // particles drawn: any non-transparent pixel in a coarse grid of the canvas
  let lit = 0;
  try {
    const g = cv.getContext("2d");
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
  } catch {}
  return { open: !el.classList.contains("hidden"), kind: el.dataset.kind, title: el.querySelector(".bs-title").textContent,
    line: el.querySelector(".bs-line").textContent, big: el.querySelector(".bs-big b").textContent, lit, log: window.__dash.bday.log };
});

const SCREENS = [
  ["Leo", "newborn", /^Happy \d+ months?, Leo$/],
  ["Ben", "toddler", /^Happy \d+(st|nd|rd|th) birthday, Ben$/],
  ["Maya", "female", /^Happy \d+(st|nd|rd|th) birthday, Maya$/],
  ["Omar", "head", /^Happy birthday, Omar$/],
  ["Felix", "default", /^Happy \d+(st|nd|rd|th) birthday, Felix$/],
];

try {
  for (const [name, kind, title] of SCREENS) {
    await load(makeState({ preview: name }));
    await sleep(2600); // entrances done, particles flowing
    const v = await view();
    await page.screenshot({ path: path.join(OUT, `${kind}.png`) });
    check(`${kind}: /birthday preview ${name} opens the ${kind} screen`, v.open && v.kind === kind && title.test(v.title), `${v.kind} "${v.title}" / "${v.line}" / ${v.big}`);
    if (kind === "head") check("head: says head of the family, with the age they turn", /head of the family/.test(v.line) && /^\d+$/.test(v.big));
    if (kind !== "toddler") check(`${kind}: particles drawing on the canvas`, v.lit > 0, `lit samples ${v.lit}`);
  }

  // tap closes it
  await load(makeState({ preview: "Maya" }));
  await sleep(800);
  await page.mouse.click(195, 420);
  await sleep(200);
  check("tap closes the takeover", !(await view()).open);

  // alarms win
  await load(makeState({ preview: "Omar" }));
  await sleep(600);
  await page.evaluate(() => window.__dash.ring({ id: "a", kind: "alarm", label: "Test" }));
  await sleep(200);
  const al = await page.evaluate(() => !document.getElementById("alarm").classList.contains("hidden"));
  check("an alarm closes the takeover and rings on top", al && !(await view()).open);
  await page.evaluate(() => window.__dash.stopRing());

  // preview ends by itself (30 s, shortened here through the same method)
  await load(makeState());
  await page.evaluate(() => window.__dash.bday.preview("Ben", 1500));
  await sleep(2200);
  check("a preview closes by itself when its time is up", !(await view()).open);

  // on the day: comes up by itself at start, with the real wording
  await load(makeState({ birthdays: [{ name: "Maya", birth: `1995-${today.slice(5)}`, tag: "female" }] }));
  await sleep(1800);
  const day = await view();
  check("on the day the takeover comes up by itself (start / wake)", day.open && day.kind === "female" && day.log.some((l) => l.why === "start"), `${day.title} ${JSON.stringify(day.log)}`);
  await page.screenshot({ path: path.join(OUT, "on-the-day.png") });

  // night mode: no automatic takeover over the dim clock
  const ns = makeState({ birthdays: [{ name: "Maya", birth: `1995-${today.slice(5)}`, tag: "female" }] });
  ns.night = { until: Date.now() + 3600000 };
  await load(ns);
  await sleep(1500);
  check("no automatic takeover in night mode", !(await view()).open);

  // motion off: still screen, no canvas, text readable
  await load(makeState({ preview: "Omar", motion: "off" }));
  await sleep(1200);
  const off = await page.evaluate(() => ({ running: document.getAnimations().filter((a) => a.playState === "running").length,
    fx: getComputedStyle(document.querySelector(".bs-fx")).display, title: document.querySelector(".bs-title").textContent }));
  check("motion off: no running animations, no particles, wording shown", off.running === 0 && off.fx === "none" && /Omar/.test(off.title), JSON.stringify(off));

  // frame rate: the canvas draws at no more than ~30 fps
  await load(makeState({ preview: "Omar" }));
  const fps = await page.evaluate(() => new Promise((ok) => {
    const cv = document.querySelector(".bs-fx"); const g = cv.getContext("2d"); const orig = g.clearRect.bind(g); let n = 0;
    g.clearRect = (...a) => { n++; return orig(...a); };
    setTimeout(() => ok(n / 2), 2000);
  }));
  check("particles capped at ~30 fps", fps > 5 && fps <= 32, `${fps} frames/s`);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, e.stack);
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
