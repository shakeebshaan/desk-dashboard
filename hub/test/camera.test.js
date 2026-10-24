// Camera + /play over the relay, end to end without a phone: real hub + bot, a local ntfy-compatible relay, a fake
// Telegram, and the app's real RelayLink standing in for the phone (its camera part runs in scripts/e2e-camera.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { pairViaRelay, RelayLink } from "../../app/www/app/src/relaylink.js";
import { startHub } from "../src/index.js";
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
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255);
const has = (hay, needle) => Buffer.from(hay).includes(Buffer.from(needle));

async function setup() {
  const relay = await fakeNtfy();
  const tg = fakeTelegram();
  const cfg = testConfig({ telegramApi: await tg.start(), relay: { enabled: true, url: relay.base, hubKeyFile: path.join(tmpDir(), "hub.key") } });
  const h = await startHub(cfg);
  let n = 0;
  const bot = async (text) => { tg.push(OWNER, text); return tg.waitSent(++n, 8000); };
  const botSaid = async (re) => { const t = await tg.waitSent(n + 1, 8000); n++; assert.match(t, re); return t; };
  const code = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})/.exec(await bot("/pair"))[1];
  const paired = await pairViaRelay({ base: relay.base, code, name: "test phone", timeoutMs: 5000 });
  await tg.waitSent(++n, 4000); // the "Paired ... fingerprint" message
  const got = [];
  const link = new RelayLink({ cfg: paired.cfg, secretKey: paired.secretKey });
  link.addEventListener("message", (e) => got.push(e.detail));
  link.start();
  await until(() => got.some((m) => m.type === "state"), 5000, "first snapshot");
  const close = async () => { link.stop(); await h.stop(); await relay.close(); await tg.close(); };
  return { relay, tg, h, bot, botSaid, link, got, paired, close };
}

test("/snap: command reaches the phone, the encrypted photo reaches Telegram, the relay sees only ciphertext", async () => {
  const s = await setup();
  try {
    assert.match(await s.bot("/snap back"), /Taking a photo with the back camera/);
    const cmd = await until(() => s.got.find((m) => m.type === "cam"), 5000, "cam command");
    assert.deepEqual({ op: cmd.op, facing: cmd.facing }, { op: "snap", facing: "back" });
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...bytes(50000), 0xff, 0xd9]);
    await s.link.upload({ id: cmd.id, kind: "photo", mime: "image/jpeg", i: 0, n: 1, facing: "back" }, photo);
    const f = await until(() => s.tg.files.find((x) => x.method === "sendPhoto"), 5000, "sendPhoto");
    assert.deepEqual(f.file.bytes, photo, "Telegram got exactly the phone's photo");
    assert.equal(f.fields.chat_id, OWNER);
    assert.match(f.fields.caption, /back camera/);
    // the relay: the upload is ciphertext, the message riding with it is a sealed frame (key, hash: sealed)
    const up = s.relay.messages.find((m) => m.attachment && m.topic === s.paired.cfg.up);
    assert.match(up.message, /^d1\.[A-Za-z0-9_-]+$/);
    const stored = [...s.relay.files.values()];
    assert.ok(stored.length >= 1 && stored.every((b) => !has(b, photo.subarray(0, 64)) && !has(b, [0xff, 0xd8, 0xff, 0xe0])), "relay stored only ciphertext");
    assert.equal(s.h.desk.jobs.size, 0, "nothing kept on the hub after delivery");
  } finally {
    await s.close();
  }
});

test("/clip: a clip in several 2 MB parts is put back together and sent as a video; mute and length reach the phone", async () => {
  const s = await setup();
  try {
    assert.match(await s.bot("/clip 20 back mute"), /Recording 20 s with the back camera, no sound/);
    const cmd = await until(() => s.got.find((m) => m.type === "cam"), 5000, "cam command");
    assert.deepEqual({ op: cmd.op, secs: cmd.secs, audio: cmd.audio, facing: cmd.facing }, { op: "clip", secs: 20, audio: false, facing: "back" });
    const clip = bytes(L.MAX_BLOB_PART * 2 + 12345, 3);
    const n = 3;
    for (let i = 0; i < n; i++) {
      await s.link.upload({ id: cmd.id, kind: "clip", mime: "video/mp4", i, n, secs: 20, audio: false }, clip.subarray(i * L.MAX_BLOB_PART, (i + 1) * L.MAX_BLOB_PART));
    }
    const f = await until(() => s.tg.files.find((x) => x.method === "sendVideo"), 8000, "sendVideo");
    assert.equal(f.file.bytes.length, clip.length);
    assert.deepEqual(f.file.bytes, clip);
    assert.match(f.fields.caption, /20 s · back camera · no sound/);
    assert.ok(s.relay.files.size >= 3 && [...s.relay.files.values()].every((b) => b.length <= 2 * 1024 * 1024), "every relay file under ntfy.sh's 2 MB");
  } finally {
    await s.close();
  }
});

test("/live: frames update one Telegram photo, /stop reaches the phone and closes the view", async () => {
  const s = await setup();
  try {
    assert.match(await s.bot("/live 1"), /Live view for 1:00 with the front camera/);
    const cmd = await until(() => s.got.find((m) => m.type === "cam"), 5000, "cam command");
    assert.deepEqual({ op: cmd.op, secs: cmd.secs, every: cmd.every, audio: cmd.audio }, { op: "live", secs: 60, every: 4, audio: false });
    for (let k = 1; k <= 3; k++) {
      await s.link.upload({ id: cmd.id, kind: "frame", mime: "image/jpeg", i: 0, n: 1, seq: k, every: 4, left: 60 - 4 * k }, bytes(3000, k));
      await until(() => s.tg.files.filter((x) => /sendPhoto|editMessageMedia/.test(x.method)).length >= k, 5000, `frame ${k}`);
    }
    const shown = s.tg.files.filter((x) => /sendPhoto|editMessageMedia/.test(x.method));
    assert.deepEqual(shown.map((x) => x.method), ["sendPhoto", "editMessageMedia", "editMessageMedia"]);
    assert.equal(JSON.parse(shown[2].fields.media).type, "photo");
    assert.equal(shown[2].fields.message_id, "1001", "edits the first live message");
    assert.deepEqual(shown[2].file.bytes, bytes(3000, 3));
    assert.match(await s.bot("/stop"), /Stopped/);
    await until(() => s.got.some((m) => m.type === "stop"), 5000, "stop on the phone");
    const end = await until(() => s.tg.files.find((x) => x.method === "editMessageCaption"), 5000, "end caption");
    assert.match(end.fields.caption, /Live view ended \(stopped\) · 3 pictures/);
    // a frame that comes after the end is dropped
    await s.link.upload({ id: cmd.id, kind: "frame", mime: "image/jpeg", i: 0, n: 1, seq: 4, every: 4, left: 40 }, bytes(3000, 4));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.tg.files.filter((x) => /sendPhoto|editMessageMedia/.test(x.method)).length, 3);
  } finally {
    await s.close();
  }
});

test("tampered, misdirected and unasked-for uploads are dropped; the phone's errors reach the owner", async () => {
  const s = await setup();
  try {
    // an upload nobody asked for (no running /snap)
    await s.link.upload({ id: "cnope", kind: "photo", mime: "image/jpeg", i: 0, n: 1 }, bytes(1000));
    // a /snap whose file is swapped on the relay before the hub downloads it
    await s.bot("/snap");
    const cmd = await until(() => s.got.find((m) => m.type === "cam"), 5000, "cam command");
    const realGet = s.relay.files.get.bind(s.relay.files);
    s.relay.files.get = (k) => { const b = realGet(k); if (b) b[40] ^= 1; return b; };
    await s.link.upload({ id: cmd.id, kind: "photo", mime: "image/jpeg", i: 0, n: 1 }, bytes(2000));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(s.tg.files.length, 0, "nothing reached Telegram");
    s.relay.files.get = realGet;
    // a wrong kind for the job (a frame for a /snap) is dropped too
    await s.link.upload({ id: cmd.id, kind: "frame", mime: "image/jpeg", i: 0, n: 1 }, bytes(2000));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.tg.files.length, 0);
    // the camera fails on the phone: the owner is told why, the job ends
    await s.link.post({ t: "cam", id: cmd.id, state: "error", err: "camera permission is off on the phone" });
    await s.botSaid(/\/snap failed on the phone: camera permission is off/);
    assert.equal(s.h.desk.jobs.size, 0);
    // busy: one camera job at a time
    await s.bot("/live 2");
    assert.match(await s.bot("/snap"), /busy with \/live/);
  } finally {
    await s.close();
  }
});

test("a camera command that arrives late (phone was offline) does not fire; /play reaches the phone; no phone = clear answer", async () => {
  const s = await setup();
  try {
    const devId = s.paired.cfg.id;
    await s.h.relay.send(devId, { t: "cam", op: "snap", id: "cold", facing: "front", at: Date.now() - 10 * 60 * 1000 }, "hi");
    assert.match(await s.bot("/play https://youtu.be/aqz-KE-bpKQ"), /Playing on the dashboard/);
    const play = await until(() => s.got.find((m) => m.type === "play"), 5000, "play");
    assert.equal(play.url, "https://youtu.be/aqz-KE-bpKQ");
    assert.ok(!s.got.some((m) => m.type === "cam"), "the late /snap was dropped by the phone");
    await s.link.post({ t: "media", state: "error", err: "the phone could not play it (media error 4)" });
    await s.botSaid(/\/play: the phone could not play it/);
    // an app without the camera build answers at once instead of timing out
    assert.equal(s.h.store.get().devices[0].cam, true, "the phone's hello said it has the camera build");
    s.h.store.update((st) => { st.devices[0].cam = false; }, { silent: true });
    assert.match(await s.bot("/snap"), /older than 0\.3\.1/);
    s.h.store.update((st) => { delete st.devices[0].cam; delete st.devices[0].ui; }, { silent: true }); // 0.2.x: says nothing
    assert.match(await s.bot("/play https://youtu.be/aqz-KE-bpKQ"), /older than 0\.3\.1/);
    s.h.store.update((st) => { st.devices[0].cam = true; }, { silent: true });
    // no phone online
    s.h.store.update((st) => { for (const d of st.devices) d.lastSeen = 0; }, { silent: true });
    assert.match(await s.bot("/snap"), /^No phone online/);
  } finally {
    await s.close();
  }
});
