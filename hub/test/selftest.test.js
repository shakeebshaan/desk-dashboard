// The phone's error log and self-test over the relay, end to end without a phone: real hub + bot, a local
// ntfy-compatible relay, a fake Telegram, and the app's real RelayLink standing in for the phone (the phone's own
// part, the tour and the error catcher, runs in Edge: scripts/e2e-selftest.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { pairViaRelay, RelayLink } from "../../app/www/app/src/relaylink.js";
import { startHub } from "../src/index.js";
import { tableText, cleanRows } from "../src/selftest.js";
import { packFiles } from "../../app/www/app/src/selftest.js";
import { fakeNtfy } from "./fakeNtfy.js";
import { fakeTelegram, testConfig, tmpDir, OWNER } from "./helpers.js";

L.useNacl(nacl);

const until = async (fn, ms = 5000, what = "condition") => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function setup() {
  const relay = await fakeNtfy();
  const tg = fakeTelegram();
  const cfg = testConfig({ telegramApi: await tg.start(), relay: { enabled: true, url: relay.base, hubKeyFile: path.join(tmpDir(), "hub.key") } });
  const h = await startHub(cfg);
  let n = 0;
  const bot = async (text) => { tg.push(OWNER, text); return tg.waitSent(++n, 8000); };
  const code = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})/.exec(await bot("/pair"))[1];
  const paired = await pairViaRelay({ base: relay.base, code, name: "test phone", timeoutMs: 5000 });
  await tg.waitSent(++n, 4000); // the "Paired ... fingerprint" message
  const got = [];
  const link = new RelayLink({ cfg: paired.cfg, secretKey: paired.secretKey });
  link.addEventListener("message", (e) => got.push(e.detail));
  link.start();
  await until(() => got.some((m) => m.type === "state"), 5000, "first snapshot");
  const close = async () => { link.stop(); await h.stop(); await relay.close(); await tg.close(); };
  return { cfg, tg, h, bot, link, got, paired, close, next: () => ++n };
}

const ROWS = [
  { card: "clock", ok: true, blank: false, errors: 0, err: "", paint: 60, fps: 59, long: 0, worst: 30 },
  { card: "weather", ok: false, blank: false, errors: 2, err: "TypeError: x is undefined @ src/widgets/weather.js:40", paint: 170, fps: 58, long: 1, worst: 60 },
  { card: "agent", ok: false, blank: true, errors: 0, err: "", paint: 330, fps: 31, long: 9, worst: 120 },
];

test("table: failures first, with what went wrong; all passing says so", () => {
  const t = tableText("dashboard-phone (d1)", { why: "after-push", ui: 11 }, cleanRows(ROWS));
  const lines = t.split("\n");
  assert.match(lines[0], /Self-test on dashboard-phone \(d1\) \(after the UI update\), UI v11: 1\/3 cards OK$/);
  assert.match(lines[1], /^❌ weather .*58 fps · 170 ms · 2 errors$/);
  assert.match(lines[2], /weather\.js:40/);
  assert.match(lines[3], /^❌ agent .*31 fps · 330 ms · blank, slow$/);
  assert.match(lines[4], /^✅ clock/);
  assert.match(t, /left out of the cycle/);
  const ok = tableText("p", { why: "manual", ui: 11 }, cleanRows([ROWS[0]]));
  assert.match(ok, /1\/1 cards OK ✅/);
  assert.doesNotMatch(ok, /left out/);
  assert.equal(cleanRows([{ card: "x\u0000<b>", fps: 1e9, ok: "yes" }])[0].fps, null, "junk from the phone is cleaned");
});

test("/selftest reaches the phone; its rows + contact sheet come back as one photo with the table; errors land in the log", async () => {
  const s = await setup();
  try {
    assert.match(await s.bot("/selftest"), /Self-test started on test phone/);
    s.next();
    const cmd = await until(() => s.got.find((m) => m.type === "selftest"), 5000, "selftest command");
    assert.match(cmd.id, /^t/);
    // the phone answers: rows first, then the picture
    await s.link.post({ t: "selftest", id: cmd.id, why: "manual", ui: 11, rows: ROWS, shots: 3, shotErr: "" });
    const sheet = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 4000 }, (_, i) => i & 255), 0xff, 0xd9]);
    await s.link.upload({ id: cmd.id, kind: "selftest", i: 0, n: 1, mime: "image/jpeg" }, sheet);
    const f = await until(() => s.tg.files.find((x) => x.method === "sendPhoto"), 5000, "sendPhoto");
    assert.deepEqual(f.file.bytes, sheet);
    assert.match(f.fields.caption, /1\/3 cards OK/);
    assert.match(f.fields.caption, /❌ weather/);
    const dev = s.h.store.get().devices[0];
    assert.deepEqual({ pass: dev.selftest.pass, of: dev.selftest.of, failing: dev.selftest.failing }, { pass: 1, of: 3, failing: "agent,weather" });
    assert.equal(fs.readFileSync(path.join(s.cfg.dataDir, "selftest.jsonl"), "utf8").trim().split("\n").length, 1);

    // a re-test with the same result is not told; a changed one is (no picture: the table alone, at once)
    const before = s.tg.sent.length;
    await s.link.post({ t: "selftest", id: "t-re1", why: "retest", ui: 11, rows: ROWS, shots: 0 });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.tg.sent.length, before, "same failures: quiet");
    await s.link.post({ t: "selftest", id: "t-re2", why: "retest", ui: 11, rows: ROWS.map((r) => ({ ...r, ok: true, blank: false, errors: 0, err: "", fps: 59 })), shots: 0 });
    const all = await until(() => s.tg.sent.slice(before).find((m) => /3\/3 cards OK/.test(m.text)), 5000, "re-test table");
    assert.match(all.text, /re-test/);

    // errors: one log line per entry, with card, UI version and WebView; /errors shows them
    await s.link.post({ t: "err", ui: 11, webview: "154.0.8037.107", list: [
      { kind: "js", card: "weather", msg: "TypeError: x is undefined @ src/widgets/weather.js:40", n: 3, first: Date.now() - 5000, last: Date.now() },
      { kind: "asset", card: "photos", msg: "img did not load: blob:", n: 1, first: Date.now(), last: Date.now() },
    ] });
    const log = path.join(s.cfg.dataDir, "phone-errors.log");
    const text = await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8"), 5000, "error log");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], / ui=v11 webview=154\.0\.8037\.107 card=weather kind=js n=3 TypeError: x is undefined @ src\/widgets\/weather\.js:40$/);
    s.tg.push(OWNER, "/errors");
    const reply = await until(() => s.tg.sent.find((m) => /Phone errors \(latest 2 of 2\)/.test(m.text)), 5000, "/errors reply");
    assert.match(reply.text, /card=photos kind=asset/);
  } finally {
    await s.close();
  }
});

test("hello carries the phone's browser facts (stored on the device, logged once); card pictures land as PNGs per UI version", async () => {
  const s = await setup();
  try {
    const client = { ua: "Mozilla/5.0 (Linux; Android 11; SM-A505F) AppleWebKit/537.36 Chrome/154.0.8037.107 Mobile Safari/537.36", webview: "154.0.8037.107", android: "11", w: 360, h: 780, sw: 360, sh: 780, dpr: 3, orient: "portrait" };
    await s.link.post({ t: "hello", v: "x", client });
    const dev = await until(() => { const d = s.h.store.get().devices[0]; return d.client && d; }, 5000, "client on the device");
    assert.equal(dev.client.ua, client.ua);
    assert.deepEqual({ w: dev.client.w, h: dev.client.h, dpr: dev.client.dpr, webview: dev.client.webview }, { w: 360, h: 780, dpr: 3, webview: "154.0.8037.107" });

    const png = (seed) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 3000 }, (_, i) => (i * seed) & 255)]);
    const files = [{ name: "clock", bytes: png(3) }, { name: "weather", bytes: png(5) }];
    await s.link.post({ t: "selftest", id: "tcap", why: "manual", ui: 13, rows: [{ card: "clock", ok: true, fps: 59, paint: 30 }, { card: "weather", ok: true, fps: 58, paint: 40 }], shots: 0 });
    const pack = packFiles(files);
    const half = Math.ceil(pack.length / 2);
    await until(() => s.h.tests.uiOf.get("tcap") === 13, 5000, "rows first");
    await s.link.upload({ id: "tcap", kind: "captures", i: 1, n: 2, orient: "portrait" }, pack.subarray(half));
    await s.link.upload({ id: "tcap", kind: "captures", i: 0, n: 2, orient: "portrait" }, pack.subarray(0, half));
    const out = path.join(s.cfg.captureDir, "v13", "weather-portrait.png");
    await until(() => fs.existsSync(out), 5000, "card picture written");
    assert.deepEqual(new Uint8Array(fs.readFileSync(out)), files[1].bytes);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(s.cfg.captureDir, "v13", "clock-portrait.png"))), files[0].bytes);
  } finally {
    await s.close();
  }
});
