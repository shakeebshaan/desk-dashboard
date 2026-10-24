// Browser check of night mode on the phone (main.js nightCheck + night.js): the real UI from app/www in headless Edge,
// Asia/Kolkata, with a faked clock (Playwright page.clock). Goodnight at 22:00, 01:30 and 07:30: the phone counts the
// end on its own clock (07:00 that morning / the next morning) and stays dim until then; a /goodnight 06:30 night ends
// at 06:30. A reminder and the midnight birthday screen show above the dim clock and close back to it; the hourly
// birthday repeat does not wake the night; a tap ends it. Quiet hours (01:00-07:00 by default, their switch, other
// times across midnight), both at once, the goodnight switch, and a tap in quiet hours: bright 2 min, then dim. Frames: C:/tmp/desk-dashboard/shots/night-*.png.
// Usage: node scripts/e2e-night.mjs
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
const OUT = "C:/tmp/desk-dashboard/shots";
fs.mkdirSync(OUT, { recursive: true });
const killer = setTimeout(() => { console.error("e2e-night: hard timeout"); process.exit(2); }, 240000);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

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

// Kolkata is UTC+5:30 all year
const IST = (d, hh, mm, ss = 0) => Date.UTC(2026, 9, d, hh, mm, ss) - 5.5 * 3600e3;
const QOFF = { quiet: { on: false } }; // goodnight alone (quiet hours are on 01:00-07:00 by default)
const state = (night, birthdays = [], settings = {}) => ({
  settings: { theme: "aurora", city: { name: "Pune" }, ...settings }, birthdays, alarms: [], events: [], weather: null, agent: { enabled: false },
  customWidgets: {}, photos: [], night, activeLayout: "home",
  layouts: [{ id: "home", name: "Home", cycleSeconds: 600, widgets: ["clock", "quote"].map((type, i) => ({ id: `w${i}`, type })) }],
});

const { page, close } = await launchEdge({ headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: "Asia/Kolkata" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const nightOn = () => page.evaluate(() => window.__dash.nightOn && !document.getElementById("night").classList.contains("hidden"));
const visible = (id) => page.evaluate((i) => !document.getElementById(i).classList.contains("hidden"), id);
const at = async (ms) => { await page.clock.setSystemTime(ms); await page.clock.runFor(2100); };

// a fresh page with the clock at `now` and the hub's state in the saved snapshot (no hub, no relay)
async function boot(now, st) {
  await page.goto("about:blank");
  await page.clock.install({ time: now });
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => localStorage.setItem("dash.state", JSON.stringify(s)), st);
  await page.goto(`${base}index.html`);
  await page.clock.runFor(1500);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length >= 2, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById("pair").classList.add("hidden"));
}

try {
  // the hub's `until` is deliberately wrong (1 h): the phone counts from `since` on its own clock
  for (const [label, since, end] of [["22:00", IST(24, 22, 0), IST(25, 7, 0)], ["01:30", IST(25, 1, 30), IST(25, 7, 0)], ["07:30", IST(25, 7, 30), IST(26, 7, 0)]]) {
    await boot(since + 1000, state({ since, wake: "07:00", until: since + 3600e3 }, [], QOFF));
    const e = await page.evaluate(() => window.__dash.dimNow().goodnightUntil);
    check(`goodnight at ${label}: the phone counts the end to ${new Date(end + 5.5 * 3600e3).toISOString().slice(5, 16).replace("T", " ")} IST`, e === end, new Date(e).toISOString());
    check(`goodnight at ${label}: dim now`, await nightOn());
    await at(since + 3600e3 + 60e3);
    check(`goodnight at ${label}: still dim an hour later (no fixed span)`, await nightOn());
    await at(end - 60e3);
    check(`goodnight at ${label}: still dim at 06:59`, await nightOn());
    if (label === "22:00") await page.screenshot({ path: path.join(OUT, "night-1-dim.png") });
    await at(end + 1000);
    check(`goodnight at ${label}: widgets back at 07:00`, !(await nightOn()));
  }

  // /goodnight 06:30 -> the night carries wake 06:30
  await boot(IST(24, 22, 0), state({ since: IST(24, 22, 0), wake: "06:30", until: 0 }, [], QOFF));
  await at(IST(25, 6, 29));
  const on629 = await nightOn();
  await at(IST(25, 6, 31));
  check("wake time 06:30: dim at 06:29, awake at 06:31", on629 && !(await nightOn()));

  // a reminder shows above the dim clock at full brightness, then it is back to dim
  await boot(IST(24, 23, 0), state({ since: IST(24, 22, 0), wake: "07:00", until: 0 }));
  await page.evaluate(() => window.__dash.ring({ id: "r1", kind: "reminder", label: "Take the medicine" }));
  await page.clock.runFor(500);
  const z = await page.evaluate(() => [getComputedStyle(document.getElementById("alarm")).zIndex, getComputedStyle(document.getElementById("night")).zIndex].map(Number));
  check("a reminder shows above the dim clock", (await visible("alarm")) && (await nightOn()) && z[0] > z[1], JSON.stringify(z));
  await page.screenshot({ path: path.join(OUT, "night-2-reminder.png") });
  await page.evaluate(() => window.__dash.stopRing());
  await page.clock.runFor(1100);
  check("after the reminder: back to the dim clock", !(await visible("alarm")) && (await nightOn()));

  // the birthday screen: shows as the day starts at midnight above the night, closes back to it; not every hour
  const bdays = [{ name: "Aria", birth: "2020-10-25" }];
  await boot(IST(24, 23, 59, 50), state({ since: IST(24, 22, 0), wake: "07:00", until: 0 }, bdays));
  check("before midnight: no birthday screen over the night", !(await page.evaluate(() => window.__dash.bday.open)));
  await at(IST(25, 0, 0, 2));
  const bd = await page.evaluate(() => ({ open: window.__dash.bday.open, z: [getComputedStyle(document.getElementById("bday")).zIndex, getComputedStyle(document.getElementById("night")).zIndex].map(Number) }));
  check("midnight: the birthday screen lights up above the dim clock", bd.open && bd.z[0] > bd.z[1] && (await nightOn()), JSON.stringify(bd));
  await page.clock.runFor(1500);
  await page.screenshot({ path: path.join(OUT, "night-3-birthday.png") });
  await page.evaluate(() => window.__dash.bday.close());
  await page.clock.runFor(1500);
  check("birthday closed: back to the dim clock", !(await page.evaluate(() => window.__dash.bday.open)) && (await nightOn()));
  await at(IST(25, 1, 0, 2));
  check("01:00: the hourly birthday repeat does not wake the night", !(await page.evaluate(() => window.__dash.bday.open)) && (await nightOn()));
  await at(IST(25, 7, 0, 2));
  check("07:00: awake", !(await nightOn()));

  // a tap on the dim clock ends the night at once
  await boot(IST(24, 23, 0), state({ since: IST(24, 22, 0), wake: "07:00", until: 0 }));
  await page.click("#night");
  await page.clock.runFor(1100);
  check("a tap ends the night", !(await nightOn()));

  // ---- quiet hours: dim 01:00-07:00 every night with no goodnight ----
  await boot(IST(25, 0, 58), state(null));
  check("quiet hours: bright at 00:58 with no goodnight", !(await nightOn()));
  await at(IST(25, 1, 0, 1));
  const why1 = await page.evaluate(() => window.__dash.dimNow());
  check("quiet hours: dim from 01:00, and it is quiet hours doing it", (await nightOn()) && why1.quiet && !why1.goodnight, JSON.stringify(why1));
  await page.screenshot({ path: path.join(OUT, "night-4-quiet.png") });
  // a tap: bright for 2 minutes, then dim again
  await page.click("#night");
  await page.clock.runFor(1100);
  check("tap in quiet hours: bright", !(await nightOn()));
  await page.clock.runFor(110e3);
  check("tap in quiet hours: still bright 1 min 50 s later", !(await nightOn()));
  await page.clock.runFor(12e3);
  check("tap in quiet hours: dim again after 2 minutes", await nightOn());
  // /wake from the hub (state.quietWake) does the same
  await page.evaluate((u) => { const s = structuredClone(window.__dash.state); s.quietWake = { until: u }; window.__dash.applyState(s); }, IST(25, 1, 5));
  await page.clock.runFor(1100);
  const bright = !(await nightOn());
  await at(IST(25, 1, 5, 2));
  check("/wake in quiet hours (hub's quietWake): bright until it runs out, then dim", bright && (await nightOn()));
  await at(IST(25, 7, 0, 1));
  check("quiet hours: bright again at 07:00", !(await nightOn()));

  // ---- quiet hours off: nothing at 03:00 ----
  await boot(IST(25, 3, 0), state(null, [], QOFF));
  check("quiet hours off: bright at 03:00", !(await nightOn()));

  // ---- other times, across midnight: 23:30-06:30 ----
  await boot(IST(24, 23, 29), state(null, [], { quiet: { on: true, from: "23:30", to: "06:30" } }));
  const b2329 = !(await nightOn());
  await at(IST(24, 23, 30, 1));
  const d2330 = await nightOn();
  await at(IST(25, 0, 30));
  const d0030 = await nightOn();
  await at(IST(25, 6, 30, 1));
  check("quiet hours 23:30-06:30: bright 23:29, dim 23:30 and past midnight, bright 06:30", b2329 && d2330 && d0030 && !(await nightOn()));

  // ---- both: goodnight at 23:00 stays dim through quiet hours to 07:00; a tap at 02:00 ends the goodnight,
  //      bright 2 min, then quiet hours dim it again ----
  await boot(IST(24, 23, 0, 5), state({ since: IST(24, 23, 0), wake: "07:00", until: 0 }));
  const g = await page.evaluate(() => window.__dash.dimNow());
  await at(IST(25, 2, 0));
  const both = await page.evaluate(() => window.__dash.dimNow());
  check("goodnight 23:00: goodnight alone at 23:00, goodnight + quiet hours at 02:00", g.goodnight && !g.quiet && both.goodnight && both.quiet && (await nightOn()));
  await page.click("#night");
  await page.clock.runFor(1100);
  const afterTap = await page.evaluate(() => window.__dash.dimNow());
  await page.clock.runFor(125e3);
  check("tap at 02:00: goodnight ended, bright 2 min, then quiet hours dim it again", !afterTap.dim && !afterTap.goodnight && (await nightOn()) && (await page.evaluate(() => window.__dash.dimNow().quiet)));

  // ---- goodnight mode off: a goodnight in the state does not dim ----
  await boot(IST(24, 23, 0), state({ since: IST(24, 22, 0), wake: "07:00", until: 0 }, [], { goodnightMode: false, quiet: { on: false } }));
  check("goodnight mode off: no dimming from a goodnight", !(await nightOn()));
  // and the quiet hours switch still works with goodnight mode off
  await boot(IST(25, 2, 0), state(null, [], { goodnightMode: false }));
  check("goodnight mode off, quiet hours on: dim at 02:00", await nightOn());

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, e.stack || e.message);
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed; frames in ${OUT}/night-*.png`);
process.exit(failed ? 1 : 0);
