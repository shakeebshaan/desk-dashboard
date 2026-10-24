// Browser end-to-end: real hub + relay + fake Telegram + headless Edge at 390x844.
// The app talks to the hub ONLY through the relay (sealed frames); the hub serves the page on 127.0.0.1 just so a
// desktop browser can load it. Relay: a local ntfy-compatible fake (default; it also checks that the relay saw only
// ciphertext) or the real one with E2E_RELAY=https://ntfy.sh (uses ~40 of this IP's 250 ntfy.sh messages a day).
// Checks: pairing + fingerprint, cycling widgets, bot text spoken, hub restart, a reminder ringing and its ack,
// and UI pushes: the real shell switches to a pushed, signed UI v2, and rolls back from a hanging v3 (20 s watchdog)
// and a crashing v4, with the phone's reports reaching the bot. Pushes use a temp copy of app/www/app.
// Writes screenshots + a screen recording to C:/tmp/desk-dashboard/shots. Usage: node scripts/e2e.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startHub } from "../hub/src/index.js";
import { fakeTelegram, testConfig, tmpDir, OWNER } from "../hub/test/helpers.js";
import { fakeNtfy } from "../hub/test/fakeNtfy.js";

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); // Edge inherits it
const require = createRequire(import.meta.url);
const { launchEdge } = require("./lib/browser.cjs");

const OUT = "C:/tmp/desk-dashboard/shots";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "video"), { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e: hard timeout"); process.exit(2); }, 600000);

const tg = fakeTelegram();
const fake = process.env.E2E_RELAY ? null : await fakeNtfy();
const relayBase = process.env.E2E_RELAY || fake.base;
// The UI source the hub pushes from: a temp copy, so the test can change it (and break it) freely.
const uiSrc = path.join(tmpDir(), "app");
fs.cpSync(path.resolve(import.meta.dirname, "..", "app", "www", "app"), uiSrc, { recursive: true });
const keysDir = tmpDir();
const cfg = testConfig({
  ui: { srcDir: uiSrc, keyFile: path.join(keysDir, "ui-sign.key"), adminTokenFile: path.join(keysDir, "admin.token") },
  // prayer times / Islamic dates off: the real Aladhan, paced 1 s per call, holds the /city reply ~20 s (e2e-widgets covers them with a fake)
  telegramApi: await tg.start(), serveApp: true, weatherEnabled: true, islamicEnabled: false, port: 0,
  relay: { enabled: true, url: relayBase, hubKeyFile: path.join(tmpDir(), "dashboard-hub.key") },
});
console.log("relay:", relayBase);
let hub = await startHub(cfg);
const port = hub.hub.port;
const base = `http://127.0.0.1:${port}`;
let sent = 0;
const bot = async (text) => { tg.push(OWNER, text); return tg.waitSent(++sent, 15000); };
// next bot message matching re (skips others), e.g. the phone's UI report
const botSaid = async (re, ms) => {
  const t0 = Date.now();
  for (;;) {
    const t = await tg.waitSent(sent + 1, Math.max(1000, ms - (Date.now() - t0)));
    sent++;
    if (re.test(t)) return t;
  }
};
const uiActive = (page) => page.evaluate(() => (window.__shell && window.__dash ? window.__shell.active() : 0)).catch(() => 0);

// Demo data.
// Sample people: one birthday today, one in 3 days (local dates, like the phone).
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (years, days) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); d.setDate(d.getDate() + days); return ymd(d); };
await bot("/birthday Aria 2023-12-05");
await bot(`/birthday Kabir ${shift(6, 0)}`);
await bot(`/birthday Mira ${shift(31, 3)}`);
await bot("/birthday Dev 2026-05-14");
await bot(`/birthday Noor ${shift(40, 1)}`); // birthday tomorrow: the hours countdown
console.log("city:", await bot("/city Pune"));
await bot("/alarm 07:30 daily Wake up");
await bot("/remind 2h Call the plumber");
await bot("/remind 45m Tea break");
const code = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})/.exec(await bot("/pair"))[1];

const { page, context, close } = await launchEdge({
  headless: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: path.join(OUT, "video"), size: { width: 390, height: 844 } },
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const consoleLog = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => consoleLog.push(`${m.type()}: ${m.text()}`));
// connection refused while the hub is deliberately down is expected
page.on("console", (m) => m.type() === "error" && !/ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  await page.goto(`${base}/?relay=${encodeURIComponent(relayBase)}`);
  await page.waitForSelector("#pair:not(.hidden)");
  await page.fill("#pair-code", code.toLowerCase()); // typed loosely on purpose
  await shot("01-pair");
  await page.click("#pair-go");
  await page.waitForSelector("#paired:not(.hidden)", { timeout: 45000 });
  const fpPhone = (await page.textContent("#paired-fp")).trim();
  const fpBot = /Fingerprint: ([0-9A-F ]+)/.exec(await tg.waitSent(++sent, 15000));
  await sleep(400);
  await shot("02-paired-fingerprint");
  check("pairing through the relay; phone and bot show the same fingerprint", fpBot && fpBot[1].trim() === fpPhone, fpPhone);
  await page.click("#paired-ok");
  await page.waitForFunction(() => window.__dash.link === "on", null, { timeout: 20000 });
  await page.waitForFunction(() => window.__dash.state.child, null, { timeout: 20000 });
  check("app gets the hub state through the relay", true);

  await page.waitForFunction(() => window.__dash.state.weather, null, { timeout: 15000 }).catch(() => {});
  const cardsList = await page.evaluate(() => window.__dash.cards);
  check("layout has the 11 default widgets", cardsList.join() === "age,clock,weather,alarms,agent,prayer,countdown,board,photos,quote,ambient", cardsList.join());

  // Birthdays: today's birthday comes first, with a celebration; three frames of the opening animation
  await bot("/cycle 120"); // keep the card on screen while it rotates through the people
  await page.waitForFunction(() => window.__dash.state.layouts[0].cycleSeconds === 120, null, { timeout: 15000 });
  await page.evaluate(() => window.__dash.goTo("age"));
  const nameIs = (n, ms) => page.waitForFunction((x) => document.querySelector('[data-type="age"] .bd-name')?.textContent === x, n, { timeout: ms, polling: 50 });
  // wait for Kabir to be drawn afresh, so the frames show the opening animation
  await page.evaluate(() => {
    window.__fresh = 0;
    new MutationObserver(() => {
      if (document.querySelector('[data-type="age"] .bd-name')?.textContent === "Kabir") window.__fresh = window.__fresh || 1;
    }).observe(document.querySelector('[data-type="age"] .bd-stage'), { childList: true });
  });
  await page.waitForFunction(() => window.__fresh === 1, null, { timeout: 30000, polling: 30 });
  const card = () => page.evaluate(() => {
    const c = document.querySelector('[data-type="age"]');
    const txt = (sel) => (c.querySelector(sel) || {}).textContent || "";
    return {
      name: txt(".bd-name"), hb: txt(".bd-hb"), age: txt(".bd-age").replace(/\s+/g, ""), count: txt(".bd-count > b"), clock: !!c.querySelector(".bd-count b.clock"),
      facts: [...c.querySelectorAll(".bd-facts > div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()),
      next: txt(".bd-next").replace(/\s+/g, " ").trim(), confetti: c.querySelectorAll(".bd-confetti i").length,
      chips: [...c.querySelectorAll(".bd-chip")].map((x) => `${x.textContent}|${x.className.replace("bd-chip", "").trim()}`),
      ring: (c.querySelector(".bd-prog") || { style: {} }).style.strokeDashoffset,
    };
  });
  const k = await card();
  check("birthday today: celebration with name, Happy birthday, confetti, the age they turn", k.name === "Kabir" && k.hb === "Happy birthday!" && k.confetti === 24 && /turns 6/.test(await page.textContent('[data-type="age"] .bd-count em')), JSON.stringify(k).slice(0, 200));
  for (const [i, wait] of [[1, 120], [2, 300], [3, 800]]) {
    await sleep(wait);
    await shot(`13-bday-anim-${i}`);
  }
  check("family strip: everyone, who is next, today / this week marked", k.chips.length === 5 && /Next upKabir/.test(k.next) && k.chips.some((c) => /^Kabir.*today/.test(c)) && k.chips.some((c) => /^Mira3d\|soon/.test(c)) && k.chips.some((c) => /^Noor1d\|soon/.test(c)), k.chips.join(" "));
  // the widget moves on to the next person by itself
  await nameIs("Aria", 70000);
  await sleep(1600);
  const a = await card();
  check("per person: age, total days, next birthday with weekday, countdown + age they turn, milestone, born weekday",
    /^\d+yrs\d+mo\d+days?$/.test(a.age) && /^\d{1,3}$/.test(a.count) && a.facts.length === 4 && /^[\d,]+ ?days old$/.test(a.facts[0]) &&
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 5 Dec ?next birthday, \d{4}$/.test(a.facts[1]) && /(days|Half-birthday)/.test(a.facts[2]) && /^\w+day ?born on a$/.test(a.facts[3]) && +a.ring > 0,
    `${a.age} | ${a.count} | ${a.facts.join(" / ")} | ring ${a.ring}`);
  // the eve of a birthday counts down in hours
  await nameIs("Noor", 70000);
  await sleep(1200);
  const nz = await card();
  check("the day before a birthday: hours countdown", nz.clock && /^\d\d:\d\d:\d\d$/.test(nz.count), nz.count);
  await shot("14-bday-eve-hours");
  await bot("/cycle 12");
  const n = { age: "02b-age", clock: "03-clock", weather: "04-weather", alarms: "05-alarms", agent: "06-agent-idle" };
  for (const [type, name] of Object.entries(n)) {
    await page.evaluate((t) => window.__dash.goTo(t), type);
    await sleep(type === "agent" ? 2500 : 1300);
    await shot(name);
  }
  const gl = await page.evaluate(() => !!document.querySelector('[data-type="agent"] canvas'));
  check("3D agent renders (WebGL canvas present)", gl);
  const idle = await page.evaluate(() => document.querySelector(".agent-caption").textContent.trim());
  check("agent card says 'Agent offline' with no key file", idle.startsWith("Agent offline"), idle);

  // automatic cycling: shorten the cycle and watch the index move by itself
  await bot("/cycle 3");
  await page.waitForFunction(() => window.__dash.state.layouts[0].cycleSeconds === 3);
  await page.evaluate(() => window.__dash.show(0));
  const i0 = await page.evaluate(() => window.__dash.index);
  const seq = [];
  for (let k = 0; k < 8; k++) { await sleep(500); seq.push(await page.evaluate(() => window.__dash.index)); }
  console.log("cycle seq", seq.join(" "), JSON.stringify(await page.evaluate(() => window.__dash.debug)));
  const i1 = seq[seq.length - 1];
  const cyc = await page.evaluate(() => window.__dash.state.layouts.map((l) => l.cycleSeconds).join());
  check("widgets cycle on their own", i1 === (i0 + 1) % 5, `${i0} -> ${i1} (cycle ${cyc}s)`);
  await bot("/cycle 12");

  // bot text -> spoken on the app
  const phrase = "Hello Omar, dinner is ready";
  const reply = await bot(phrase);
  await page.waitForFunction((p) => window.__dash.spoken.some((s) => s.text === p), phrase, { timeout: 8000 });
  await sleep(900);
  await shot("07-agent-speaking");
  const caption = await page.evaluate(() => document.querySelector(".agent-caption").textContent.trim());
  check("bot text arrives and is spoken on the app", caption === phrase && /Speaking on 1 phone/.test(reply), `${reply} | ${caption}`);

  // hub restart: the phone only knows the relay, so it does not even notice; speech flows again after it
  await hub.stop();
  await sleep(1500);
  hub = await startHub({ ...cfg, port });
  const back = "Back online after the restart";
  const r2 = await bot(`/say ${back}`);
  await page.waitForFunction((p) => window.__dash.spoken.some((s) => s.text === p), back, { timeout: 8000 });
  check("after a hub restart the app speaks again", /Speaking on 1 phone/.test(r2), r2);

  // a reminder set from the bot rings on the phone
  await bot("/remind 8s Tea is ready");
  await page.waitForSelector("#alarm:not(.hidden)", { timeout: 12000 });
  await sleep(700);
  await shot("09-reminder-ringing");
  check("reminder from the bot rings on the phone", (await page.textContent("#alarm-label")) === "Tea is ready");
  await page.click("#alarm-stop");
  await sleep(1500);
  const left = (await bot("/alarms")).includes("Tea is ready");
  check("rung one-shot reminder is removed on the hub", !left);

  // ---------- UI pushes (no new APK) ----------
  check("starts on the UI built into the APK", (await uiActive(page)) === 1);
  await bot("/title 1 Our family");
  await page.waitForFunction(() => document.querySelector('[data-type="age"] .card-head span').textContent === "Our family", null, { timeout: 15000 });
  check("data-driven: a widget title changes from the bot without any push", true);
  await bot("/title 1");
  await page.waitForFunction(() => document.querySelector('[data-type="age"] .card-head span').textContent === "Birthdays", null, { timeout: 15000 });
  await page.evaluate(() => window.__dash.goTo("age"));
  await sleep(1500);
  await shot("11-ui-before-push");

  // v2: a visible change in the widget code and the styles
  const ageW = path.join(uiSrc, "src", "widgets", "age.js");
  fs.writeFileSync(ageW, fs.readFileSync(ageW, "utf8").replace('title: "Birthdays"', 'title: "Family birthdays"'));
  fs.appendFileSync(path.join(uiSrc, "styles.css"), "\n.bd-name { color: #ffd56b; -webkit-text-fill-color: #ffd56b; }\n.bd-facts > div { border-radius: 12px; }\n");
  const pushReply = await bot("/ui push");
  check("/ui push: built, signed and sent", /UI v2 .*signed\) sent to 1 phone/.test(pushReply), pushReply);
  const on2 = await botSaid(/is on UI v2/, 60000);
  await page.waitForFunction(() => window.__shell && window.__shell.active() === 2 && window.__dash, null, { timeout: 30000 });
  check("the phone switched to UI v2 and the bot confirmed it", (await uiActive(page)) === 2, on2);
  await page.evaluate(() => window.__dash.goTo("age"));
  await sleep(1500);
  await shot("12-ui-after-push-v2");
  const title2 = await page.textContent('[data-type="age"] .card-head span');
  check("the pushed change is on screen", title2 === "Family birthdays", title2);

  // v3: hangs before it can report healthy -> the 20 s watchdog rolls back to v2
  const mainF = path.join(uiSrc, "src", "main.js");
  const mainGood = fs.readFileSync(mainF, "utf8");
  fs.writeFileSync(mainF, mainGood.replace('import "./body.js"; // first: puts the markup in the page', 'import "./body.js"; // first: puts the markup in the page\nawait new Promise(() => {}); // deliberately broken: never reports healthy'));
  await bot("/ui push");
  const t3 = Date.now();
  const bad3 = await botSaid(/UI v3 did not work/, 90000);
  check("hanging v3 rolled back by the watchdog and reported", /no healthy report within 20 s.*runs UI v2/.test(bad3), `${bad3} (${Math.round((Date.now() - t3) / 1000)} s)`);
  await page.waitForFunction(() => window.__shell && window.__shell.active() === 2 && window.__dash, null, { timeout: 30000 });

  // v4: throws while loading -> rolled back at once
  fs.writeFileSync(mainF, mainGood.replace('import "./body.js"; // first: puts the markup in the page', 'import "./body.js"; // first: puts the markup in the page\nthrow new Error("deliberately broken UI");'));
  await bot("/ui push");
  const bad4 = await botSaid(/UI v4 did not work/, 60000);
  check("crashing v4 rolled back and reported", /deliberately broken UI.*runs UI v2/.test(bad4), bad4);
  await page.waitForFunction(() => window.__shell && window.__shell.active() === 2 && window.__dash, null, { timeout: 30000 });
  const st = await page.evaluate(() => window.__shell.state());
  check("phone stays on the last good UI; v3 and v4 are never tried again", st.active === 2 && st.lastGood === 2 && st.bad.includes(3) && st.bad.includes(4), JSON.stringify(st));
  // a forged bundle handed straight to the shell is refused
  const forged = await page.evaluate(() => window.__shell.stage(JSON.stringify({ format: 1, v: 99, entry: "src/main.js", files: { "src/main.js": "" } }), "A".repeat(86)));
  check("unsigned / wrongly signed bundle refused by the shell", forged.ok === false && forged.why === "bad signature", JSON.stringify(forged));
  fs.writeFileSync(mainF, mainGood);
  errors.length = 0; // the deliberate failures above log errors by design

  await bot("/theme ember");
  await page.evaluate(() => window.__dash.goTo("weather"));
  await sleep(1300);
  await shot("10-theme-ember");
  await bot("/theme aurora");

  if (fake) {
    const plain = ["Hello Omar", "Tea is ready", "Aria", "Pune", "ember", fpPhone];
    const frames = fake.messages.filter((m) => !m.attachment);
    const leaks = frames.filter((m) => !/^(d1|p1)\.[A-Za-z0-9_-]+$/.test(m.message) || plain.some((p) => m.message.includes(p)));
    const fileLeaks = [...fake.files.values()].filter((b) => ["Family birthdays", "src/main.js", "import"].some((p) => b.includes(p)));
    check("the relay saw only sealed frames and encrypted UI files", leaks.length === 0 && fileLeaks.length === 0 && frames.length > 5 && fake.files.size === 3,
      `${frames.length} frames + ${fake.files.size} UI files, ${leaks.length + fileLeaks.length} with plaintext`);
  }
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("e2e run", false, e.message);
  console.log("DEBUG shell", JSON.stringify(await page.evaluate(() => window.__shell && window.__shell.state()).catch((x) => String(x))));
  console.log("DEBUG errors", errors.slice(-8).join(" || "));
  console.log("DEBUG console", consoleLog.slice(-15).join(" || "));
  await shot("99-failure").catch(() => {});
} finally {
  const video = page.video();
  await close();
  if (video) {
    const p = await video.path().catch(() => null);
    if (p && fs.existsSync(p)) fs.renameSync(p, path.join(OUT, "dashboard-demo.webm"));
  }
  fs.rmSync(path.join(OUT, "video"), { recursive: true, force: true });
  await hub.stop().catch(() => {});
  await tg.close();
  if (fake) await fake.close();
  fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  clearTimeout(killer);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed; shots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
