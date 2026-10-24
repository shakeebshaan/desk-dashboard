// Browser end-to-end for the camera, /play and push-to-talk: real hub + bot + a local ntfy-compatible relay + fake
// Telegram, and the real app in headless Edge (390x844) with Chromium's FAKE camera and microphone (a test pattern
// and a beep; no real device is opened). What only the phone can prove: the Android permission prompts, the real
// cameras, MediaRecorder's format on that WebView, YouTube in the WebView, and the on-device speech recognizer.
// Writes screenshots and the received photo to C:/tmp/desk-dashboard/shots-cam. Usage: node scripts/e2e-camera.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startHub } from "../hub/src/index.js";
import { fakeTelegram, testConfig, tmpDir, OWNER } from "../hub/test/helpers.js";
import { fakeNtfy } from "../hub/test/fakeNtfy.js";

os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
const require = createRequire(import.meta.url);
const { launchEdge } = require("./lib/browser.cjs");

const OUT = "C:/tmp/desk-dashboard/shots-cam";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killer = setTimeout(() => { console.error("e2e-camera: hard timeout"); process.exit(2); }, 300000);
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
};

const tg = fakeTelegram();
const fake = await fakeNtfy();
const cfg = testConfig({
  telegramApi: await tg.start(), serveApp: true, port: 0,
  relay: { enabled: true, url: fake.base, hubKeyFile: path.join(tmpDir(), "hub.key") },
});
const hub = await startHub(cfg);
const base = `http://127.0.0.1:${hub.hub.port}`;
let sent = 0;
const bot = async (text) => { tg.push(OWNER, text); return tg.waitSent(++sent, 15000); };
const botSaid = async (re, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const t = await tg.waitSent(sent + 1, Math.max(1000, ms - (Date.now() - t0)));
    sent++;
    if (re.test(t)) return t;
  }
};
const filesOf = (re) => tg.files.filter((f) => re.test(f.method));
const code = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})/.exec(await bot("/pair"))[1];

const { page, close } = await launchEdge({
  headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  permissions: ["camera", "microphone"],
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const recState = () => page.evaluate(() => ({
  visible: !document.getElementById("rec").classList.contains("hidden"),
  label: document.getElementById("rec-label").textContent,
  border: document.body.classList.contains("cam-on"),
  preview: !!document.getElementById("rec-preview").srcObject,
}));
// REC must be on screen for as long as the camera is on: sample it every 100 ms in the page
const watchRec = () => page.evaluate(() => {
  window.__recLog = [];
  const rec = document.getElementById("rec");
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await orig(c);
    window.__recLog.push({ ev: "open", rec: !rec.classList.contains("hidden"), audio: !!c.audio });
    for (const t of s.getTracks()) {
      const stop = t.stop.bind(t);
      t.stop = () => { stop(); window.__recLog.push({ ev: "stop", kind: t.kind, rec: !rec.classList.contains("hidden") }); };
    }
    window.__liveStreams = (window.__liveStreams || []).concat([s]);
    return s;
  };
});
const liveTracks = () => page.evaluate(() => (window.__liveStreams || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);

try {
  await page.goto(`${base}/?relay=${encodeURIComponent(fake.base)}`);
  await page.waitForSelector("#pair:not(.hidden)");
  await page.fill("#pair-code", code);
  await page.click("#pair-go");
  await page.waitForSelector("#paired:not(.hidden)", { timeout: 45000 });
  await botSaid(/Fingerprint/);
  await page.click("#paired-ok");
  await page.waitForFunction(() => window.__dash.link === "on", null, { timeout: 20000 });
  check("paired through the relay", true);
  await watchRec();
  check("camera off and no REC before any command", !(await recState()).visible && (await liveTracks()) === 0);

  // ---------- /snap ----------
  check("/snap answered", /Taking a photo with the front camera/.test(await bot("/snap")));
  await page.waitForFunction(() => !document.getElementById("rec").classList.contains("hidden"), null, { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById("rec-preview").srcObject, null, { timeout: 15000 }).catch(() => {});
  const r1 = await recState();
  await shot("01-snap-rec");
  check("REC indicator on while the camera takes the photo (dot, label, red frame, preview)", r1.visible && r1.label === "REC · CAMERA" && r1.border && r1.preview, JSON.stringify(r1));
  const photo = await until(() => filesOf(/sendPhoto/)[0], 30000, "photo in Telegram");
  const jpg = Buffer.from(photo.file.bytes);
  fs.writeFileSync(path.join(OUT, "snap-received.jpg"), jpg);
  check("photo reached Telegram as a JPEG", jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 5000, `${jpg.length} bytes, caption "${photo.fields.caption}"`);
  await until(async () => !(await recState()).visible, 5000, "REC off");
  check("camera released and REC off after the photo", (await liveTracks()) === 0 && !(await recState()).visible);

  // ---------- /clip ----------
  check("/clip answered", /Recording 3 s with the back camera and the mic/.test(await bot("/clip 3 back")));
  await page.waitForFunction(() => !document.getElementById("rec").classList.contains("hidden"), null, { timeout: 15000 });
  const r2 = await recState();
  await shot("02-clip-rec");
  check("REC shows camera + mic during a clip", r2.label === "REC · CAMERA + MIC", r2.label);
  const clip = await until(() => filesOf(/sendVideo|sendDocument/)[0], 40000, "clip in Telegram");
  const cb = Buffer.from(clip.file.bytes);
  const isMp4 = cb.subarray(4, 8).toString() === "ftyp";
  const isWebm = cb.readUInt32BE(0) === 0x1a45dfa3;
  check("clip reached Telegram as a video file", (isMp4 || isWebm) && cb.length > 10000, `${clip.method} ${clip.file.name} ${cb.length} bytes, "${clip.fields.caption}"`);
  await until(async () => (await liveTracks()) === 0 && !(await recState()).visible, 5000, "clip camera off");
  check("camera and mic released after the clip", true);

  // ---------- /live + /stop ----------
  check("/live answered", /Live view for 1:00/.test(await bot("/live 1")));
  await until(() => filesOf(/sendPhoto/).length >= 2, 20000, "first live frame");
  await until(() => filesOf(/editMessageMedia/).length >= 1, 20000, "second live frame");
  const r3 = await recState();
  await sleep(300);
  await shot("03-live-rec");
  check("LIVE indicator on during the live view", r3.visible && r3.label === "LIVE · CAMERA", r3.label);
  const live = filesOf(/sendPhoto/)[1];
  check("live view: one Telegram photo, then edits of that same message", filesOf(/editMessageMedia/).every((f) => f.fields.message_id === String(1001 + tg.files.indexOf(live))), live.fields.caption);
  check("/stop answered", /Stopped/.test(await bot("/stop")));
  await until(async () => (await liveTracks()) === 0 && !(await recState()).visible, 8000, "live camera off");
  const endCap = await until(() => filesOf(/editMessageCaption/)[0], 8000, "end caption");
  check("/stop turns the camera off and closes the live view", /Live view ended \(stopped\)/.test(endCap.fields.caption), endCap.fields.caption);
  const log = await page.evaluate(() => window.__recLog);
  check("every camera open and track stop happened with REC on screen", log.length >= 6 && log.every((e) => e.rec), JSON.stringify(log.map((e) => `${e.ev}${e.kind ? ":" + e.kind : ""}${e.rec ? "" : "!NO-REC"}`)));

  // ---------- /play ----------
  check("/play answered", /Playing on the dashboard/.test(await bot("/play https://www.youtube.com/watch?v=aqz-KE-bpKQ")));
  await page.waitForSelector("#player:not(.hidden) iframe", { timeout: 10000 });
  const src = await page.getAttribute("#player iframe", "src");
  check("YouTube link plays full screen in the privacy-enhanced embed", src.startsWith("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1"), src);
  await sleep(2500);
  await shot("04-play-youtube");
  await bot("/stop");
  await page.waitForSelector("#player.hidden", { state: "attached", timeout: 10000 });
  check("/stop brings the widgets back", await page.evaluate(() => !document.querySelector("#player iframe")));
  await bot("/play https://127.0.0.1:9/missing.mp4");
  const perr = await botSaid(/\/play:/, 20000);
  check("a video the phone cannot play is reported to the bot and the widgets come back", /could not play/.test(perr) && (await page.evaluate(() => document.getElementById("player").classList.contains("hidden"))), perr);

  // ---------- push-to-talk ----------
  await page.evaluate(() => {
    window.__micSeen = false;
    new MutationObserver(() => { if (!document.getElementById("mic").classList.contains("hidden")) window.__micSeen = true; })
      .observe(document.getElementById("mic"), { attributes: true });
    window.__dashTestVoice = "what is on today";
    window.__dash.goTo("agent");
    window.__dash.talk();
  });
  await page.waitForFunction(() => window.__dash.spoken.some((s) => s.text === "Agent offline."), null, { timeout: 15000 });
  check("push-to-talk: MIC indicator while listening, the words go to the hub agent, its answer is spoken",
    await page.evaluate(() => window.__micSeen && document.getElementById("mic").classList.contains("hidden")));

  // ---------- privacy ----------
  const stored = [...fake.files.values()];
  const plainMarks = stored.filter((b) => (b[0] === 0xff && b[1] === 0xd8) || b.includes(Buffer.from("ftyp")) || b.includes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  check("the relay held only ciphertext (no JPEG / MP4 / WebM headers in any upload)", stored.length >= 4 && plainMarks.length === 0, `${stored.length} files`);
  const lsBytes = await page.evaluate(() => Object.keys(localStorage).reduce((n, k) => n + k.length + (localStorage.getItem(k) || "").length, 0));
  check("nothing stored on the phone (localStorage stays small)", lsBytes < 60000, `${lsBytes} chars`);
  check("hub keeps no camera jobs after delivery", hub.desk.jobs.size === 0);
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("e2e-camera run", false, e.message);
  console.log("DEBUG errors", errors.slice(-8).join(" || "));
  await shot("99-failure").catch(() => {});
} finally {
  await close();
  await hub.stop().catch(() => {});
  await tg.close();
  await fake.close();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  clearTimeout(killer);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed; shots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}
