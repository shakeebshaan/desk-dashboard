// Browser check of the verse, moon and sun cards and the event-driven cycle: the real UI from app/www in headless
// Edge at 390x844, Asia/Kolkata, state seeded into the phone's saved snapshot (no hub). Checks the three cards draw
// (verse in English and Urdu exactly as given, the moon's phase matches astro.js, the sun on its arc), a sunset event
// plays on the sun card, and the cycle: an alarm and a prayer due at the same minute come forward 3 s early, the
// alarm first (it rings), the prayer queued behind it and shown after, then normal cycling; a new photo comes
// forward; an alarm still rings over night mode.
// Shots: C:/tmp/desk-dashboard/shots/*.png.   Usage: node scripts/e2e-cards3.mjs [verse.json]
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
const TZ = "Asia/Kolkata";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e-cards3: hard timeout"); process.exit(2); }, 240000);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// a verse as api.alquran.cloud gave it (hub/src/quran.js verseOfDay); the stand-in keeps the same shape
const verseFile = process.argv[2] || "C:/tmp/desk-dashboard/verse-today.json";
const VERSE = fs.existsSync(verseFile) ? JSON.parse(fs.readFileSync(verseFile, "utf8")) : {
  n: 262, date: "2026-10-24", surah: { number: 2, name: "سُورَةُ البَقَرَةِ", englishName: "Al-Baqara", meaning: "The Cow" }, ayah: 255,
  arabic: "ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ", tr: { en: { text: "Allah - there is no deity except Him", name: "Saheeh International" }, ur: { text: "خدا", name: "Fateh Muhammad Jalandhry" } }, source: "api.alquran.cloud",
};

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

const wall = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
// the next whole minute at least 12 s away: the alarm and the maghrib prayer are both set to it
let target = Math.ceil((Date.now() + 12000) / 60000) * 60000;
const tw = wall(target);
const prayerTimes = (maghrib) => ({ fajr: "00:01", sunrise: "00:02", dhuhr: "00:03", asr: "00:04", maghrib, isha: "23:59" });

const makeState = (extra = {}) => ({
  settings: { theme: "aurora", city: { name: "Pune", country: "IN", lat: 18.52043, lon: 73.85674 }, clockStyle: "rings" },
  birthdays: [], events: [], weather: null, customWidgets: {}, photos: [{ id: "p1" }], agent: { enabled: true },
  verse: VERSE, alarms: [],
  prayer: { city: "Pune", methodName: "Karachi", asr: "Hanafi", today: { date: tw.ymd, times: prayerTimes("23:58"), hijri: "" }, tomorrow: null },
  activeLayout: "home",
  layouts: [{ id: "home", name: "Home", cycleSeconds: 600, widgets: ["clock", "verse", "moon", "sun", "prayer", "alarms", "photos", "agent"].map((type, i) => ({ id: `w${i}`, type })) }],
  ...extra,
});

const { page, close } = await launchEdge({
  headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TZ,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const load = async (st) => {
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem("dash.state", JSON.stringify(s)); }, st);
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length > 5, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById("pair").classList.add("hidden"));
};
const current = () => page.evaluate(() => window.__dash.cards[window.__dash.index]);
const showCard = async (type, wait = 2600) => { await page.evaluate((t) => window.__dash.goTo(t), type); await sleep(wait); };

try {
  await load(makeState());
  // ---------- the three cards ----------
  await showCard("verse");
  const vs = await page.evaluate(() => ({ ar: document.querySelector(".vs-ar").textContent, tr: document.querySelector(".vs-tr").textContent,
    ref: document.querySelector(".vs-ref").textContent, foot: document.querySelector(".vs-foot").textContent, dir: document.querySelector(".vs-ar").dir }));
  check("verse: Arabic and English exactly as the source gave them, with surah, ayah and translation name",
    vs.ar === VERSE.arabic && vs.tr === VERSE.tr.en.text && vs.ref === `${VERSE.surah.englishName} · ${VERSE.surah.number}:${VERSE.ayah}` && vs.foot.startsWith(VERSE.tr.en.name) && vs.dir === "rtl",
    `${vs.ref} | ${vs.foot}`);
  await page.screenshot({ path: path.join(OUT, "verse.png") });
  await page.evaluate((s) => window.__dash.applyState({ ...s, settings: { ...s.settings, verseLang: "ur" } }), makeState());
  await sleep(1800);
  const ur = await page.evaluate(() => ({ tr: document.querySelector(".vs-tr").textContent, dir: document.querySelector(".vs-tr").dir, foot: document.querySelector(".vs-foot").textContent }));
  check("verse: /verse urdu shows the Urdu translation, right to left, named", ur.tr === VERSE.tr.ur.text && ur.dir === "rtl" && ur.foot.startsWith(VERSE.tr.ur.name), ur.foot);
  await page.screenshot({ path: path.join(OUT, "verse-urdu.png") });
  await page.evaluate((s) => window.__dash.applyState(s), makeState());

  await showCard("moon", 2400);
  const mn = await page.evaluate(async () => {
    const { moonNow, moonPath } = await import("./app/src/astro.js");
    const m = moonNow();
    return { name: document.querySelector(".mn-name").textContent, pct: document.querySelector(".mn-pct b").textContent, want: m.name, wantPct: String(Math.round(m.illum * 100)),
      d: document.querySelector(".mn-lit").getAttribute("d"), wantD: moonPath(m.illum, m.waxing, 50), full: document.querySelector(".mn-full span").textContent };
  });
  check("moon: phase name, % lit and the drawn shape are today's (astro.js)", mn.name === mn.want && mn.pct === mn.wantPct && mn.d === mn.wantD, `${mn.name} ${mn.pct}% | full ${mn.full}`);
  await page.screenshot({ path: path.join(OUT, "moon.png") });

  await showCard("sun", 2400);
  const sn = await page.evaluate(() => ({ rise: document.querySelector(".sn-rise").textContent, set: document.querySelector(".sn-set").textContent,
    len: document.querySelector(".sn-len").textContent, sky: document.querySelector(".sn").dataset.sky, tr: document.querySelector(".sn-sun").getAttribute("transform") }));
  check("sun: today's sunrise, sunset, day length and the sun placed on the arc", /^\d\d:\d\d$/.test(sn.rise) && /^\d\d:\d\d$/.test(sn.set) && /^\d+ h \d\d m$/.test(sn.len) && /^translate\(/.test(sn.tr), JSON.stringify(sn));
  await page.screenshot({ path: path.join(OUT, "sun.png") });

  // ---------- a sunset event on the sun card ----------
  await showCard("clock", 300);
  await page.evaluate(() => { window.__dash.focus.push({ key: "test-sunset", widget: "sun", dur: 9000, kind: "sunset" }); window.__dash.focusTick(); });
  await sleep(500);
  const ev = await page.evaluate(() => ({ card: window.__dash.cards[window.__dash.index], cls: document.querySelector(".sn").className }));
  check("event: a sunset brings the sun card forward and plays its animation", ev.card === "sun" && /evt-set/.test(ev.cls), JSON.stringify(ev));
  await sleep(4500);
  await page.screenshot({ path: path.join(OUT, "sun-sunset-event.png") });
  await page.evaluate(() => window.__dash.focus.release("test-sunset"));

  // ---------- alarm + prayer at the same minute: priority and queue ----------
  target = Math.ceil((Date.now() + 14000) / 60000) * 60000;
  const tw2 = wall(target);
  await load(makeState({
    alarms: [{ id: "a1", kind: "alarm", label: "Tea", at: target }],
    prayer: { city: "Pune", methodName: "Karachi", asr: "Hanafi", today: { date: tw2.ymd, times: prayerTimes(tw2.hm), hijri: "" }, tomorrow: null },
  }));
  await showCard("verse", 200);
  const lead = target - 3000 - Date.now();
  await sleep(Math.max(0, lead - 1500));
  check("before the lead time the normal card stays", (await current()) === "verse");
  await sleep(2500); // now about 2 s before the moment
  const early = await page.evaluate(() => ({ card: window.__dash.cards[window.__dash.index], queue: window.__dash.focus.queue, t: Date.now() }));
  check("3 s early: the alarm comes forward first, the prayer queued behind it",
    early.card === "alarms" && early.queue[0].startsWith("alarm:") && early.queue.some((k) => k.startsWith("prayer:maghrib")) && target - early.t <= 3000 && target - early.t > 0,
    `${early.card} ${JSON.stringify(early.queue)} ${target - early.t} ms before`);
  await sleep(target - Date.now() + 1500);
  const ringing = await page.evaluate(() => ({ alarm: !document.getElementById("alarm").classList.contains("hidden"), queue: window.__dash.focus.queue, card: window.__dash.cards[window.__dash.index] }));
  check("at the moment the alarm rings and holds the screen; the prayer still waits", ringing.alarm && ringing.queue.includes("ring") && ringing.queue.some((k) => k.startsWith("prayer:")) && ringing.card === "alarms", JSON.stringify(ringing));
  await sleep(6000);
  check("the ringing alarm keeps the screen as long as it rings", (await current()) === "alarms" && (await page.evaluate(() => window.__dash.focus.queue[0])) === "ring");
  await page.evaluate(() => window.__dash.stopRing());
  await sleep(1300);
  check("alarm dismissed: the queued prayer comes forward (not dropped)", (await current()) === "prayer", await current());
  const log = await page.evaluate(() => window.__dash.focusLog.map((l) => l.key.split("@")[0]));
  check("focus order: alarm, ring, prayer", JSON.stringify(log.filter((k, i) => log.indexOf(k) === i)) === JSON.stringify(["alarm:a1", "ring", "prayer:maghrib"]), JSON.stringify(log));
  const prayerDone = await page.waitForFunction(() => !window.__dash.focus.cur && !document.body.classList.contains("focus-on"), null, { timeout: 16000 }).then(() => true, () => false);
  check("after the prayer's moment and animation the normal cycle resumes", prayerDone);

  // ---------- a new photo ----------
  await showCard("clock", 300);
  await page.evaluate(() => { const s = window.__dash.state; window.__dash.applyState({ ...s, photos: [...s.photos, { id: "p2" }] }); });
  await sleep(1300);
  check("a new photo brings the photo frame forward", (await current()) === "photos" && (await page.evaluate(() => window.__dash.focus.queue.includes("photo:p2"))));

  // ---------- night mode: dim, but an alarm breaks through ----------
  await load(makeState({ night: { until: Date.now() + 3600000 } }));
  await page.evaluate(() => window.__dash.ring({ id: "n1", kind: "alarm", label: "Wake" }));
  await sleep(500);
  const nt = await page.evaluate(() => {
    const a = document.getElementById("alarm"), n = document.getElementById("night");
    const r = a.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { night: !n.classList.contains("hidden"), alarm: !a.classList.contains("hidden"), onTop: a.contains(top) };
  });
  check("night mode stays on, the ringing alarm shows above it", nt.night && nt.alarm && nt.onTop, JSON.stringify(nt));
  await page.evaluate(() => window.__dash.stopRing());

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
