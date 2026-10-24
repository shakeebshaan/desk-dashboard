// Browser check of the motion layer (src/motion.js + the widgets): the real UI from app/www in headless Edge at
// 390x844, Asia/Kolkata, with a stand-in state seeded into the phone's saved snapshot (no hub, no relay: the app
// draws from its cache). Checks: no page errors, digits roll, the odometer lands on the number, a weather scene and
// the night moon, a birthday cake + confetti, the alarm bell's mood, each card's own entrance, and the three motion
// levels (calm drops particles, off stills everything). Frames: C:/tmp/desk-dashboard/motion/*.png.
// Usage: node scripts/e2e-motion.mjs
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
const OUT = "C:/tmp/desk-dashboard/motion";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const TZ = "Asia/Kolkata";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e-motion: hard timeout"); process.exit(2); }, 240000);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// static server for app/www (the shell starts the built-in UI bundle from app/)
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

// wall clock in the zone, for stand-in times relative to now
const wall = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, y: +p.year, md: `${p.month}-${p.day}` };
};
const now = Date.now();
const today = wall(now);

function makeState({ icon = "storm", text = "Thunderstorm", night = false, motion } = {}) {
  const hrs = Array.from({ length: 8 }, (_, i) => wall(now + i * 3600000).hm.slice(0, 2) + ":00");
  return {
    settings: { theme: "aurora", city: { name: "Pune" }, clockStyle: "rings", ...(motion ? { motion } : {}) },
    birthdays: [{ name: "Aria", birth: `${today.y - 6}-${today.md}` }, { name: "Sam", birth: "1990-03-14" }],
    alarms: [{ id: "a1", kind: "alarm", label: "Tea break", at: now + 4 * 60000 }, { id: "a2", kind: "alarm", label: "School run", time: "07:30", repeat: "daily" }],
    events: [{ id: "e1", kind: "daily", name: "Walk", time: wall(now + 40 * 60000).hm }, { id: "e2", kind: "once", name: "Trip", date: "2026-12-25" }],
    board: { notes: [{ text: "Milk and bread" }, { text: "Call the plumber" }], todos: [{ text: "Pay the bill", done: true }, { text: "Water plants", done: false }] },
    weather: {
      at: now, city: "Pune", current: { temp: 27, feels: 30, humidity: 81, wind: 18, text, icon },
      hourly: hrs.map((time, i) => ({ time, temp: 26 + (i % 3), rain: [60, 80, 70, 40, 20, 10, 5, 5][i], icon: ["storm", "rain", "rain", "cloud", "partly", "sun", "sun", "sun"][i] })),
      umbrella: { yes: true, why: "80% rain this hour" },
      daily: ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"].map((date, i) => ({ date, max: 31 - i, min: 21, icon: ["storm", "partly", "sun", "snow", "cloud"][i] })),
      sunrise: `${today.ymd}T${night ? "23:58" : "00:01"}`, sunset: `${today.ymd}T${night ? "23:59" : "23:59"}`,
    },
    agent: { enabled: true }, customWidgets: {}, photos: [],
    activeLayout: "home",
    layouts: [{ id: "home", name: "Home", cycleSeconds: 600, widgets: ["clock", "weather", "age", "alarms", "countdown", "board", "quote", "ambient", "agent"].map((type, i) => ({ id: `w${i}`, type })) }],
  };
}

const { page, close } = await launchEdge({
  headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: TZ,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const frames = {};
const shot = async (name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }); (frames[name.split("-")[0]] ||= []).push(f); return f; };
const load = async (st) => {
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => { localStorage.setItem("dash.state", JSON.stringify(s)); }, st);
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length > 5, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById("pair").classList.add("hidden")); // stand-in: no pairing here
};
const showCard = async (type, wait = 1300) => { await page.evaluate((t) => window.__dash.goTo(t), type); await sleep(wait); };

try {
  await load(makeState());
  check("motion level defaults to full", (await page.evaluate(() => document.body.dataset.motion)) === "full");
  // entrances: every card carries its own transition
  const fx = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".card")].map((c) => [c.dataset.type, c.dataset.fx])));
  check("each widget has its own entrance", fx.clock === "flip" && fx.weather === "drop" && fx.age === "zoom" && fx.alarms === "swing" && fx.agent === "iris", JSON.stringify(fx));
  check("shooting-star layer and fireflies layer mounted", await page.evaluate(() => !!document.querySelector(".fx-shoot") && !!document.querySelector(".sky .fx-flies")));

  // clock: entrance mid-flight, rolling digits, the comet sweeping
  await page.evaluate(() => window.__dash.goTo("weather"));
  await sleep(1200);
  await page.evaluate(() => window.__dash.goTo("clock"));
  await sleep(250);
  await shot("clock-1-entering");
  await sleep(1300);
  check("clock digits are rolling columns", await page.evaluate(() => document.querySelectorAll(".clock-hm .odo").length === 4));
  check("comet sweeps the seconds ring", await page.evaluate(() => getComputedStyle(document.querySelector(".clock-comet")).animationName === "spin"));
  await shot("clock-2");
  // force a minute change mid-frame: roll the minute digit from a fake value
  await page.evaluate(() => { const h = document.querySelector(".clock-hm"); const t = h.dataset.roll; h.dataset.roll = t.slice(0, 4) + ((+t[4] + 9) % 10); });
  // the next tick rolls the last digit back to the real one: old leaves upward, new enters from below
  const rolled = await page.waitForFunction(() => document.querySelector(".clock-hm .odo-in") && document.querySelector(".clock-hm .odo-out"), null, { timeout: 2500 }).then(() => true, () => false);
  await sleep(200);
  await shot("clock-3-roll");
  check("a changed digit rolls (old leaves, new enters)", rolled);

  // weather: storm scene with rain, splashes, lightning and rumble
  await showCard("weather", 1500);
  check("storm scene: rain drops, splashes, lightning", await page.evaluate(() => document.querySelectorAll(".wx-rain i").length === 26 && !!document.querySelector(".wx-splash i") && !!document.querySelector(".wx-flash")));
  await shot("weather-1-storm");
  // catch the lightning: jump its animation to the flash
  await page.evaluate(() => { for (const n of document.querySelectorAll(".wx-flash, .wx-top.storm")) n.style.animationDelay = "-6.09s"; });
  await sleep(60);
  await shot("weather-2-lightning");

  // birthdays: today is Aria's (a stand-in) -> cake with a candle, confetti, sparkle trail, odometer
  await showCard("age", 300);
  await shot("age-1-enter");
  await sleep(900);
  await shot("age-2-burst");
  check("birthday: cake with a flickering candle", await page.evaluate(() => !!document.querySelector(".cake .cake-flame") && getComputedStyle(document.querySelector(".cake-flame")).animationName === "flicker"));
  check("birthday: confetti falling", await page.evaluate(() => document.querySelectorAll(".bd-confetti i").length === 24));
  await sleep(2600);
  const odo = await page.evaluate(() => { const b = document.querySelector("[data-odo]"); return b ? { want: b.dataset.odo, cols: b.querySelectorAll(".odm").length } : null; });
  check("days-old odometer has a column per digit", odo && odo.cols === odo.want.replace(/\D/g, "").length, JSON.stringify(odo));
  await shot("age-3");

  // alarms: next one in 4 minutes -> the bell is restless ("soon")
  await showCard("alarms", 1400);
  check("alarm bell mood: soon", await page.evaluate(() => document.querySelector(".al-hero").classList.contains("soon") && getComputedStyle(document.querySelector(".al-bell")).animationName === "bell-wob"));
  await shot("alarms-1");
  await sleep(1100);
  await shot("alarms-2");

  // countdown: under an hour -> heartbeat, rolling seconds
  await showCard("countdown", 1400);
  check("countdown: last hour beats, seconds roll", await page.evaluate(() => document.querySelector(".cd-top").classList.contains("beat") && document.querySelectorAll(".cd-n .odo").length >= 4));
  await shot("countdown-1");

  await showCard("board", 1200);
  await shot("board-1");
  await page.evaluate(() => window.__dash.goTo("quote"));
  await sleep(700);
  await shot("quote-1-reveal");
  await sleep(1400);
  await shot("quote-2");
  check("quote words revealed one by one", await page.evaluate(() => document.querySelectorAll(".qw").length > 3));
  await showCard("ambient", 1500);
  await page.evaluate(() => { for (const n of document.querySelectorAll(".amb-shoot i")) n.style.animationDelay = "-0.45s"; });
  await sleep(40);
  await shot("ambient-1-shootingstar");

  // night: clear sky -> tonight's moon in place of the sun, twinkling stars
  await load(makeState({ icon: "sun", text: "Clear", night: true }));
  await showCard("weather", 1500);
  check("night: the moon replaces the sun, stars twinkle", await page.evaluate(() => !!document.querySelector(".ic.moonic .moon") && document.querySelectorAll(".wx-stars i").length === 18));
  await shot("weather-3-night");
  await load(makeState({ icon: "snow", text: "Snow" }));
  await showCard("weather", 2500);
  await shot("weather-4-snow");
  await load(makeState({ icon: "sun", text: "Sunny" }));
  await showCard("weather", 1500);
  await shot("weather-5-sun");

  // calm: particles gone, movement stays; off: nothing animates
  await load(makeState({ motion: "calm" }));
  await showCard("weather", 1200);
  check("calm: no rain particles, no lightning", await page.evaluate(() => document.body.dataset.motion === "calm" && getComputedStyle(document.querySelector(".wx-rain")).display === "none" && getComputedStyle(document.querySelector(".wx-flash")).display === "none"));
  await load(makeState({ motion: "off" }));
  await showCard("clock", 300);
  const still = await page.evaluate(() => {
    const running = document.getAnimations().filter((a) => a.playState === "running" && (a.effect.getComputedTiming().duration > 5));
    return { running: running.length, roll: document.querySelectorAll(".clock-hm .odo").length, text: document.querySelector(".clock-hm").textContent };
  });
  check("off: no running animations, digits still readable", still.running === 0 && /^\d\d:\d\d$/.test(still.text), JSON.stringify(still));
  // layout motion wins over the setting
  const st = makeState({ motion: "off" });
  st.layouts[0].motion = "calm";
  await load(st);
  check("a layout's motion wins over settings.motion", (await page.evaluate(() => document.body.dataset.motion)) === "calm");

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("run", false, e.stack);
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
fs.writeFileSync(path.join(OUT, "frames.json"), JSON.stringify(frames, null, 1));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
