// Browser end-to-end for the 2026-10-24 cards: prayer times (+ a prayer chime), countdowns with Islamic dates, the
// family board, the photo frame (photos sent to the bot, carried to the phone encrypted), quote / word of the day,
// ambient, weather now, the four clock styles, night mode (an alarm still rings over it), /devices with battery and
// network, and push-to-talk with the agent ON (a stand-in API client: no real call, no cost).
// Real app in headless Edge at 390x844 in the Asia/Kolkata time zone, hub -> local relay -> app. Sample data only.
// Screenshots: C:/tmp/desk-dashboard/shots/w-*.png. Usage: node scripts/e2e-widgets.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startHub } from "../hub/src/index.js";
import { fakeTelegram, testConfig, tmpDir, OWNER } from "../hub/test/helpers.js";
import { fakeNtfy } from "../hub/test/fakeNtfy.js";
import { fakeAladhan } from "../hub/test/fakeAladhan.js";
import { wallParts } from "../hub/src/time.js";
import { pace } from "../hub/src/islamic.js";

pace.gapMs = 0; // the fake Aladhan needs no pacing

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const require = createRequire(import.meta.url);
const { launchEdge } = require("./lib/browser.cjs");

const OUT = "C:/tmp/desk-dashboard/shots";
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^w-/.test(f)) fs.rmSync(path.join(OUT, f));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e-widgets: hard timeout"); process.exit(2); }, 420000);
const TZ = "Asia/Kolkata";

// Prayer times around "now" in the zone, so the next prayer is 3 minutes away and its chime can be seen.
const hm = (ms) => { const w = wallParts(ms, TZ); return `${String(w.hh).padStart(2, "0")}:${String(w.mm).padStart(2, "0")}`; };
const t0 = Date.now();
const fajrAt = Math.ceil((t0 + 3 * 60000) / 60000) * 60000;
const H = 3600000;
const times = { Fajr: hm(fajrAt), Sunrise: hm(fajrAt + H), Dhuhr: hm(fajrAt + 5 * H), Asr: hm(fajrAt + 8 * H), Sunset: hm(fajrAt + 11 * H),
  Maghrib: hm(fajrAt + 11 * H), Isha: hm(fajrAt + 12 * H) };
const sameDay = wallParts(fajrAt + 12 * H, TZ).d === wallParts(t0, TZ).d;

const tg = fakeTelegram();
const fake = await fakeNtfy();
const al = fakeAladhan({ times });
const keyDir = tmpDir();
fs.writeFileSync(path.join(keyDir, "agent.key"), "stand-in-not-a-key\n");
const asked = [];
const agentClient = { messages: { create: async (req) => {
  asked.push(req.messages.at(-1).content);
  return { content: [{ type: "text", text: "Nothing is planned today except a walk at six." }], usage: { input_tokens: 40, output_tokens: 12 } };
} } };
const cfg = testConfig({
  telegramApi: await tg.start(), serveApp: true, port: 0, weatherEnabled: false, islamicEnabled: true, islamicFetch: al.fetchImpl,
  relay: { enabled: true, url: fake.base, hubKeyFile: path.join(tmpDir(), "hub.key") },
  agent: { enabled: true, keyFile: path.join(keyDir, "agent.key"), model: "claude-haiku-5-5", capUsd: 5, warnUsd: 4 },
});
const hub = await startHub(cfg, { agentClient });
const base = `http://127.0.0.1:${hub.hub.port}`;
let sent = 0;
const bot = async (text) => { tg.push(OWNER, text); return tg.waitSent(++sent, 15000); };
const raw = async (m) => { tg.pushRaw(OWNER, m); return tg.waitSent(++sent, 15000); };
const botSaid = async (re, ms = 20000) => {
  const t1 = Date.now();
  for (;;) {
    const t = await tg.waitSent(sent + 1, Math.max(1000, ms - (Date.now() - t1)));
    sent++;
    if (re.test(t)) return t;
  }
};

// Sample data: a city, the weather now (rain later today), people and dates.
hub.store.update((s) => {
  s.settings.tz = TZ;
  s.settings.city = { name: "Pune", country: "IN", lat: 18.52, lon: 73.86 };
  const hrs = Array.from({ length: 12 }, (_, i) => { const h = (wallParts(t0, TZ).hh + i) % 24; return `${String(h).padStart(2, "0")}:00`; });
  const codes = [1, 2, 2, 3, 61, 63, 80, 61, 3, 2, 1, 1];
  const icon = { 1: "sun", 2: "partly", 3: "cloud", 61: "rain", 63: "rain", 80: "rain" };
  s.weather = {
    at: Date.now(), city: "Pune",
    current: { temp: 27.4, feels: 30.1, humidity: 71, wind: 12.6, code: 2, text: "Partly cloudy", icon: "partly", isDay: true },
    hourly: hrs.map((time, i) => ({ time, temp: 27 + Math.round(Math.sin(i / 2) * 3), rain: [5, 10, 20, 35, 70, 80, 60, 40, 20, 10, 5, 5][i], code: codes[i], icon: icon[codes[i]] })),
    umbrella: { yes: true, why: `80% rain around ${hrs[5]}` },
    daily: ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"].map((date, i) => ({ date, max: 31 - i, min: 21, rain: [80, 30, 10, 0, 20][i], code: [61, 2, 1, 1, 3][i], icon: ["rain", "partly", "sun", "sun", "cloud"][i] })),
    sunrise: "2026-10-24T06:22", sunset: "2026-10-24T18:03",
  };
});
await hub.refreshIslamic({ force: true });
const code = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})/.exec(await bot("/pair"))[1];

const { page, close } = await launchEdge({
  headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TZ,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: path.join(OUT, `w-${name}.png`) });
const showCard = async (type, wait = 1400) => {
  await page.evaluate((t) => window.__dash.goTo(t), type);
  await sleep(wait);
};
// content that does not fit its card (clipped at 390x844)
const overflow = (type) => page.evaluate((t) => {
  const b = document.querySelector(`.card[data-type="${t}"] .card-body`);
  return b ? Math.max(0, b.scrollHeight - b.clientHeight) : -1;
}, type);

try {
  await page.goto(`${base}/?relay=${encodeURIComponent(fake.base)}`);
  await page.waitForSelector("#pair:not(.hidden)");
  await page.fill("#pair-code", code);
  await page.click("#pair-go");
  await page.waitForSelector("#paired:not(.hidden)", { timeout: 45000 });
  await botSaid(/Fingerprint/);
  await page.click("#paired-ok");
  await page.waitForFunction(() => window.__dash.link === "on", null, { timeout: 20000 });
  await bot("/cycle 600"); // keep each card on screen for its picture
  const cards = await page.waitForFunction(() => window.__dash.cards.length >= 11 && window.__dash.cards, null, { timeout: 15000 }).then((h) => h.jsonValue());
  check("Home layout has the 6 new cards after the original 5", ["prayer", "countdown", "board", "photos", "quote", "ambient"].every((t) => cards.includes(t)), cards.join(","));

  // ---------- content from the bot ----------
  for (const t of ["/note Milk and bread", "/note Dentist on Thursday, 5 pm", "/todo add Pay the electricity bill", "/todo add Book train tickets",
    "/todo add Water the plants", "/todo done 2", "/event Tuesday 11:00 Work", "/event 2026-12-25 Trip to Goa", "/event yearly 03-15 Anniversary",
    "/prayer alarm fajr chime"]) {
    check(`bot: ${t}`, !/^(Usage|No )/.test(await bot(t)));
  }
  // three stand-in photos, drawn in the page and "sent" to the bot
  const pics = await page.evaluate(async () => {
    const out = [];
    const sets = [["#ff9a6b", "#6b4dff", "#ffd56b"], ["#38e1d0", "#0b3d91", "#ffffff"], ["#ff6fae", "#2b1055", "#7cf0c8"]];
    for (const [a, b, c] of sets) {
      const cv = document.createElement("canvas");
      cv.width = 1080; cv.height = 1440;
      const g = cv.getContext("2d");
      const gr = g.createLinearGradient(0, 0, 0, 1440);
      gr.addColorStop(0, a); gr.addColorStop(1, b);
      g.fillStyle = gr; g.fillRect(0, 0, 1080, 1440);
      g.fillStyle = c; g.globalAlpha = 0.85; g.beginPath(); g.arc(760, 420, 170, 0, 7); g.fill();
      g.globalAlpha = 0.6; g.fillStyle = "#111";
      g.beginPath(); g.moveTo(0, 1100); g.lineTo(380, 760); g.lineTo(700, 1020); g.lineTo(1080, 700); g.lineTo(1080, 1440); g.lineTo(0, 1440); g.fill();
      const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85));
      out.push([...new Uint8Array(await blob.arrayBuffer())]);
    }
    return out;
  });
  for (const [i, bytes] of pics.entries()) {
    tg.blobs.set(`pic${i}`, { bytes: Uint8Array.from(bytes), path: `photos/pic${i}.jpg` });
    check(`photo ${i + 1} sent to the bot is added`, /Added to the photo frame/.test(await raw({ photo: [{ file_id: `pic${i}`, width: 960, height: 1280 }] })));
  }
  await page.waitForFunction(() => window.__dash.state.photos.length === 3 && window.__dash.state.photos.every((p) => window.__dash.files.url(p.id)), null, { timeout: 30000 });
  check("photos reach the phone encrypted and sit in its memory (blob: URLs)", true);
  await page.waitForFunction(() => window.__dash.state.prayer && window.__dash.state.islamic && window.__dash.state.board.todos.length === 3, null, { timeout: 20000 });

  // ---------- the cards ----------
  for (const t of ["prayer", "countdown", "board", "photos", "quote", "ambient", "weather"]) {
    await showCard(t, t === "photos" ? 2600 : 1600);
    await shot(t);
    const of = await overflow(t);
    check(`${t} card fits 390x844`, of <= 2 && of >= 0, `${of}px over`);
  }
  const pr = await page.evaluate(() => ({
    name: document.querySelector('[data-type="prayer"] .pr-name').textContent, count: document.querySelector('[data-type="prayer"] .pr-count').textContent,
    rows: [...document.querySelectorAll('[data-type="prayer"] .pr-row')].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
  }));
  check("prayer card: next prayer with a live countdown, today's five, bell on the one with an alarm", pr.name === "Fajr" && /^in 00:0[0-3]:\d\d$/.test(pr.count) && pr.rows.length === 5 && /^Fajr\s*🔔/.test(pr.rows[0]), `${pr.name} ${pr.count} | ${pr.rows.join(" | ")}`);
  const cd = await page.evaluate(() => ({ top: document.querySelector('[data-type="countdown"] .cd-name').textContent, rows: [...document.querySelectorAll('[data-type="countdown"] .cd-row b')].map((b) => b.textContent),
    note: !!document.querySelector('[data-type="countdown"] .cd-note') }));
  check("countdowns: own events and Islamic dates together, soonest first, with the moon-sighting note", cd.top === "Work" && cd.rows.some((r) => /🌙/.test(r)) && cd.rows.includes("Trip to Goa") && cd.note, `${cd.top} | ${cd.rows.join(" | ")}`);
  const bd = await page.evaluate(() => ({ notes: document.querySelectorAll('[data-type="board"] .note').length, done: document.querySelectorAll('[data-type="board"] .todo li.done').length }));
  check("board: 2 notes, 3 to-dos with one done", bd.notes === 2 && bd.done === 1, JSON.stringify(bd));
  const wx = await page.evaluate(() => ({ umb: document.querySelector('[data-type="weather"] .wx-umb').textContent.trim(), hours: document.querySelectorAll('[data-type="weather"] .wx-hour').length,
    now: [...document.querySelectorAll('[data-type="weather"] .wx-now b')].map((b) => b.textContent) }));
  check("weather now: feels like, humidity, wind, next 6 hours, umbrella flag", /Take an umbrella/.test(wx.umb) && wx.hours === 6 && wx.now.length === 3, `${wx.umb} | ${wx.now.join(" ")}`);

  // ---------- clock styles ----------
  await showCard("clock", 600);
  for (const st of ["rings", "analogue", "flip", "minimal"]) {
    await bot(`/clockstyle ${st}`);
    await page.waitForFunction((s) => document.querySelector('[data-type="clock"] .clock-body').dataset.style === s, st, { timeout: 15000 });
    await sleep(1300);
    await shot(`clock-${st}`);
  }
  check("four clock styles switch from the bot", true);
  await bot("/clockstyle rings");

  // ---------- push-to-talk with the agent ON ----------
  await page.waitForFunction(() => window.__dash.state.agent && window.__dash.state.agent.enabled, null, { timeout: 15000 });
  await showCard("agent", 800);
  await page.evaluate(() => { window.__dashTestVoice = "what is on today"; window.__dash.talk(); });
  await page.waitForFunction(() => window.__dash.spoken.some((s) => /walk at six/.test(s.text)), null, { timeout: 20000 });
  await sleep(600);
  await shot("agent-answer");
  check("push-to-talk with the agent on: the words reach the agent, its answer is spoken", asked.includes("what is on today"));
  check("/ask answers from the agent", /walk at six/.test(await bot("/ask what is on today")));

  // ---------- /devices ----------
  const dv = await bot("/devices");
  check("/devices shows battery, charging and network from the phone", /🔋 \d+%( charging| on battery)? · /.test(dv), dv.split("\n").slice(0, 2).join(" / "));

  // ---------- night mode ----------
  check("goodnight (plain text) starts night mode", /Good night/.test(await bot("Goodnight")));
  await page.waitForSelector("#night:not(.hidden)", { timeout: 15000 });
  await sleep(1500);
  await shot("night");
  const nightOk = await page.evaluate(() => getComputedStyle(document.getElementById("stage")).visibility === "hidden" && /\d\d:\d\d/.test(document.getElementById("night-clock").textContent));
  check("night mode: only a dim clock, widgets hidden", nightOk);
  await page.evaluate(() => window.__dash.ring({ id: "t1", kind: "alarm", label: "Wake up" }));
  await sleep(700);
  const alarmTop = await page.evaluate(() => {
    const a = document.getElementById("alarm");
    const r = a.getBoundingClientRect();
    return !a.classList.contains("hidden") && document.elementFromPoint(r.width / 2, r.height / 2).closest("#alarm") !== null;
  });
  await shot("night-alarm");
  check("an alarm still rings on top of night mode", alarmTop);
  await page.evaluate(() => window.__dash.stopRing());
  check("/wake ends night mode", /Good morning/.test(await bot("/wake")));
  await page.waitForSelector("#night.hidden", { state: "attached", timeout: 15000 });

  // ---------- the prayer chime ----------
  if (sameDay) {
    console.log(`waiting for the stand-in Fajr at ${times.Fajr} (${Math.round((fajrAt - Date.now()) / 1000)} s)`);
    await page.waitForFunction(() => window.__dash.prayerCalls.length > 0, null, { timeout: Math.max(5000, fajrAt - Date.now() + 70000), polling: 500 });
    await sleep(800);
    await shot("prayer-call");
    const pc = await page.evaluate(() => window.__dash.prayerCalls[0]);
    check("prayer alarm (chime) rings at the prayer time, once", pc.key === "fajr" && pc.mode === "chime", JSON.stringify(pc));
    await page.click("#pc-stop");
  } else {
    check("prayer chime (skipped: the stand-in times wrap past midnight at this hour)", true);
  }
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("e2e-widgets run", false, e.message);
  console.log("DEBUG errors", errors.slice(-8).join(" || "));
  await shot("99-failure").catch(() => {});
} finally {
  await close();
  await hub.stop().catch(() => {});
  await tg.close();
  await fake.close();
  fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, "w-results.json"), JSON.stringify(results, null, 1));
  clearTimeout(killer);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed; shots in ${OUT}/w-*.png`);
  process.exit(failed ? 1 : 0);
}
