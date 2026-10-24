// Browser check of the weather scene (widgets/weather.js): the real UI from app/www in headless Edge at 390x844,
// a stand-in state seeded into the phone's saved snapshot (no hub). Checks the scene per condition (clear and hot
// with wind, heavy rain, thunder, a clear night), the motion levels, the crossfade to a new condition, the
// temperature counting to its new value, and the attention animation when the event-driven cycle brings the card
// forward (rain starting, a big temperature jump). Frames: C:/tmp/desk-dashboard/shots/weather-*.png, 3 per
// condition, and a contact sheet weather-sheet.png.
// Usage: node scripts/e2e-weather.mjs
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
for (const f of fs.readdirSync(OUT)) if (f.startsWith("weather-")) fs.rmSync(path.join(OUT, f));
const TZ = "Asia/Kolkata";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e-weather: hard timeout"); process.exit(2); }, 240000);
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

const wall = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
const now = Date.now();
const today = wall(now);

function weather({ icon, code, text, temp, wind, night = false, at = now, hourIcon = icon }) {
  const hrs = Array.from({ length: 8 }, (_, i) => wall(now + i * 3600000).hm.slice(0, 2) + ":00");
  const wet = ["rain", "drizzle", "storm"].includes(icon);
  return {
    at, city: "Pune", current: { temp, feels: temp + 2, humidity: wet ? 88 : 40, wind, code, text, icon },
    hourly: hrs.map((time, i) => ({ time, temp: temp - (i % 3), rain: wet ? [80, 70, 60, 40, 20, 10, 5, 5][i] : 0, icon: i < 3 ? hourIcon : "partly" })),
    umbrella: wet ? { yes: true, why: "80% rain this hour" } : { yes: false, why: "" },
    daily: ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"].map((date, i) => ({ date, max: temp + 2 - i, min: temp - 8, icon: ["sun", "partly", "rain", "storm", "cloud"][i] })),
    sunrise: `${today.ymd}T${night ? "23:58" : "00:01"}`, sunset: `${today.ymd}T23:59`,
  };
}
const state = (w, motion) => ({
  settings: { theme: "aurora", city: { name: "Pune" }, ...(motion ? { motion } : {}) },
  birthdays: [], alarms: [], events: [], weather: w, agent: { enabled: false }, customWidgets: {}, photos: [],
  activeLayout: "home",
  layouts: [{ id: "home", name: "Home", cycleSeconds: 600, widgets: ["clock", "weather", "quote"].map((type, i) => ({ id: `w${i}`, type })) }],
});

const SCENES = {
  clear: weather({ icon: "sun", code: 0, text: "Clear", temp: 34, wind: 26 }),
  rain: weather({ icon: "rain", code: 65, text: "Heavy rain", temp: 24, wind: 22 }),
  thunder: weather({ icon: "storm", code: 95, text: "Thunderstorm", temp: 25, wind: 30 }),
  night: weather({ icon: "sun", code: 0, text: "Clear", temp: 21, wind: 5, night: true }),
};

const { page, close } = await launchEdge({ headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, timezoneId: TZ });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const frames = {};
const shot = async (group, name) => { const f = path.join(OUT, `weather-${group}-${name}.png`); await page.screenshot({ path: f }); (frames[group] ||= []).push(f); };
const load = async (st) => {
  await page.goto(`${base}index.html`);
  await page.evaluate((s) => { localStorage.setItem("dash.state", JSON.stringify(s)); }, st);
  await page.goto(`${base}index.html`);
  await page.waitForFunction(() => window.__dash && window.__dash.cards.length >= 3, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById("pair").classList.add("hidden"));
  await page.evaluate(() => window.__dash.goTo("weather"));
  await sleep(1500);
};
const q = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

try {
  // ---- clear, hot, windy ----
  await load(state(SCENES.clear));
  check("clear day: glow, rays, hot heat shimmer", (await q(".wx-scene.sun .wx-glow")) === 1 && (await q(".wx-beams")) === 1 && (await q(".wx-shimmer.hot i")) === 6);
  check("wind 26 km/h: 4 gust lines and 2 leaves", (await q(".wx-wind i")) === 4 && (await q(".wx-leaves i")) === 2);
  check("temperature counted up to 34", (await page.evaluate(() => document.querySelector(".wx-temp [data-n]").textContent)) === "34");
  check("hourly strip slides in", await page.evaluate(() => getComputedStyle(document.querySelector(".wx-hour")).animationName === "wx-slide"));
  for (const k of [1, 2, 3]) { await shot("clear", k); await sleep(700); }

  // ---- heavy rain ----
  await load(state(SCENES.rain));
  const rain = await page.evaluate(() => ({ lv: document.querySelector(".wx-scene").classList.contains("lv3"), drops: document.querySelectorAll(".wx-rain i").length,
    mist: !!document.querySelector(".wx-mist"), slant: document.querySelector(".wx-scene").style.getPropertyValue("--slant") }));
  check("heavy rain (WMO 65): 26 long drops, splashes, mist", rain.lv && rain.drops === 26 && rain.mist && (await q(".wx-splash i")) === 10, JSON.stringify(rain));
  check("rain slant follows the wind (22 km/h -> 14deg)", rain.slant === "14deg", rain.slant);
  for (const k of [1, 2, 3]) { await shot("rain", k); await sleep(450); }
  // the same city with light rain: fewer, shorter drops
  await load(state(weather({ icon: "rain", code: 61, text: "Light rain", temp: 24, wind: 4 })));
  check("light rain (WMO 61): 12 drops, no mist, no wind", (await q(".wx-scene.lv1 .wx-rain i")) === 12 && (await q(".wx-mist")) === 0 && (await q(".wx-wind")) === 0);

  // ---- thunder ----
  await load(state(SCENES.thunder));
  check("thunder: two bolts and two flashes out of step, heavy rain", (await q(".wx-bolt")) === 2 && (await q(".wx-flash")) === 2 && (await q(".wx-rain i")) === 26);
  await shot("thunder", 1);
  // catch the strike: hold the first flash, its bolt and the rumble at 87 % of their 7 s cycle
  await page.evaluate(() => { for (const n of document.querySelectorAll(".wx-scene > .wx-flash:not(.b), .wx-scene > .wx-bolt:not(.b), .wx-top.storm")) for (const a of n.getAnimations()) { a.pause(); a.currentTime = 6100; } });
  await sleep(60);
  check("lightning: the flash and the bolt light up", await page.evaluate(() => +getComputedStyle(document.querySelector(".wx-scene > .wx-flash")).opacity > 0.4 && +getComputedStyle(document.querySelector(".wx-scene > .wx-bolt")).opacity > 0.4));
  await shot("thunder", 2);
  await page.evaluate(() => { for (const n of document.querySelectorAll(".wx-scene > .wx-flash, .wx-scene > .wx-bolt, .wx-top.storm")) for (const a of n.getAnimations()) a.play(); });
  await sleep(900);
  await shot("thunder", 3);

  // ---- clear night ----
  await load(state(SCENES.night));
  check("clear night: moon icon, moon glow, 18 twinkling stars, no sun", (await q(".ic.moonic .moon")) === 1 && (await q(".wx-moonglow")) === 1 && (await q(".wx-stars i")) === 18 && (await q(".wx-glow")) === 0);
  check("night tint on the scene", (await q(".wx-scene.wx-dark")) === 1);
  for (const k of [1, 2, 3]) { await shot("night", k); await sleep(900); }

  // ---- motion levels ----
  await load(state(SCENES.thunder, "calm"));
  check("calm: no particles, no lightning", await page.evaluate(() => getComputedStyle(document.querySelector(".wx-rain")).display === "none" && getComputedStyle(document.querySelector(".wx-flash")).display === "none" && getComputedStyle(document.querySelector(".wx-bolt")).display === "none"));
  await load(state(SCENES.rain, "off"));
  const off = await page.evaluate(() => { const c = document.querySelector(".wx-cl"); const s = getComputedStyle(c); return { anim: s.animationName, t: s.transform }; });
  check("off: clouds stand still where they are (not drifted off)", off.anim === "none" && off.t !== "none", JSON.stringify(off));

  // ---- event-driven: clouds -> rain starting; then a 6-degree jump ----
  await load(state(weather({ icon: "cloud", code: 3, text: "Overcast", temp: 27, wind: 12, at: now - 600000 })));
  await page.evaluate(() => window.__dash.goTo("clock"));
  await sleep(1200);
  await page.evaluate((w) => { const s = structuredClone(window.__dash.state); s.weather = w; window.__dash.applyState(s); }, weather({ icon: "rain", code: 63, text: "Rain", temp: 26, wind: 12, at: now }));
  await page.waitForFunction(() => document.querySelector(".card.show")?.dataset.type === "weather", null, { timeout: 4000 }).catch(() => {});
  await sleep(400);
  const ev = await page.evaluate(() => ({ on: document.querySelector(".card.show")?.dataset.type, alert: document.querySelector(".wx-alert")?.textContent, pour: !!document.querySelector(".wx-fxo .pour"),
    scenes: [...document.querySelectorAll(".card[data-type=weather] .card-body > .wx-scene:not(.wx-fxo)")].map((s) => s.className), log: window.__dash.focusLog.slice(-1)[0]?.key }));
  check("rain starting: the weather card comes forward with a 'Rain starting' banner and a downpour", ev.on === "weather" && /Rain starting/.test(ev.alert || "") && ev.pour && /^wx:rain@/.test(ev.log || ""), JSON.stringify(ev));
  check("the rain scene crossfades in over the cloud scene", ev.scenes.some((c) => c.includes("rain") && c.includes("wx-in")) && ev.scenes.some((c) => c.includes("cloud") && c.includes("wx-out")), JSON.stringify(ev.scenes));
  await shot("event", 1);
  await sleep(1300);
  await shot("event", 2);
  await sleep(700);
  check("the old scene is removed once faded", (await q(".card[data-type=weather] .card-body > .wx-scene.cloud")) === 0);
  await page.evaluate(() => { for (const k of window.__dash.focus.queue) window.__dash.focus.release(k); window.__dash.focusTick(); window.__dash.goTo("clock"); });
  await sleep(9000); // the first banner's 8 s run ends
  await page.evaluate((w) => { const s = structuredClone(window.__dash.state); s.weather = w; window.__dash.applyState(s); }, weather({ icon: "rain", code: 63, text: "Rain", temp: 32, wind: 12, at: now + 600000 }));
  await page.waitForFunction(() => document.querySelector(".card.show")?.dataset.type === "weather", null, { timeout: 4000 }).catch(() => {});
  await sleep(500);
  const mid = await page.evaluate(() => +document.querySelector(".wx-temp [data-n]").textContent);
  await sleep(1300);
  const t = await page.evaluate(() => ({ end: document.querySelector(".wx-temp [data-n]").textContent, delta: document.querySelector(".wx-delta")?.textContent, alert: document.querySelector(".wx-alert")?.textContent, warm: document.querySelector(".card[data-type=weather] .card-body").classList.contains("wx-attn-warm") }));
  check("warming 26 -> 32: counts from the old value, not from 0", mid > 26 && mid < 32, `mid ${mid}`);
  check("lands on 32 with a +6 chip and a 'Warming up +6°' banner", t.end === "32" && t.delta === "▲6°" && /Warming up \+6°/.test(t.alert || "") && t.warm, JSON.stringify(t));
  await shot("event", 3);

  check("no page errors", errors.length === 0, errors.join(" | "));

  // contact sheet: a row per condition
  const rows = ["clear", "rain", "thunder", "night", "event"].map((g) => `<div class="row"><h2>${g === "event" ? "rain starts, then +6°" : g}</h2>${(frames[g] || []).map((f) => `<img src="data:image/png;base64,${fs.readFileSync(f).toString("base64")}">`).join("")}</div>`).join("");
  await page.setViewportSize({ width: 860, height: 600 });
  await page.setContent(`<html><body style="margin:0;background:#05070d;color:#dfe6ff;font:600 15px system-ui;padding:14px"><style>.row{display:flex;gap:10px;align-items:flex-start;margin-bottom:12px}
    .row h2{writing-mode:vertical-rl;transform:rotate(180deg);margin:0;font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:#7cc4ff}img{width:260px;border-radius:12px}</style>${rows}</body></html>`);
  await page.screenshot({ path: path.join(OUT, "weather-sheet.png"), fullPage: true });
} catch (e) {
  check("run", false, e.stack || e.message);
} finally {
  await close();
  server.close();
  clearTimeout(killer);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed; frames in ${OUT}`);
process.exit(failed ? 1 : 0);
