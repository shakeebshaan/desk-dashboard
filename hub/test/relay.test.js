import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { pairViaRelay, RelayLink } from "../../app/www/app/src/relaylink.js";
import { startHub } from "../src/index.js";
import { DAY_SOFT, DAY_HARD } from "../src/relay.js";
import { fakeNtfy } from "./fakeNtfy.js";
import { testConfig, tmpDir } from "./helpers.js";

L.useNacl(nacl);

const until = async (fn, ms = 4000, what = "condition") => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const pairKeys = () => {
  const hub = L.newKeyPair();
  const phone = L.newKeyPair();
  return { hub, phone, h: L.sessionKeys(hub.secretKey, phone.publicKey), p: L.sessionKeys(phone.secretKey, hub.publicKey) };
};

// ---------- crypto ----------
test("both sides derive the same direction keys; frames round-trip", () => {
  const { h, p } = pairKeys();
  assert.deepEqual(h, p);
  assert.notDeepEqual(h.h2p, h.p2h);
  const r = L.open(p.h2p, L.seal(h.h2p, 1, { t: "speak", text: "hello" }), 0);
  assert.equal(r.ok, true);
  assert.deepEqual(r.msg, { t: "speak", text: "hello" });
  assert.equal(r.counter, 1);
});

test("replayed and reordered frames are rejected", () => {
  const { h } = pairKeys();
  const f1 = L.seal(h.h2p, 1, { t: "a" });
  const f2 = L.seal(h.h2p, 2, { t: "b" });
  const r2 = L.open(h.h2p, f2, 0);
  assert.equal(r2.ok, true);
  assert.equal(L.open(h.h2p, f2, r2.counter).why, "replay", "same frame twice");
  assert.equal(L.open(h.h2p, f1, r2.counter).why, "replay", "older frame after a newer one");
});

test("tampered frames and a forged counter are rejected", () => {
  const { h } = pairKeys();
  const f = L.seal(h.h2p, 5, { t: "ask", text: "x" });
  const raw = L.unb64u(f.slice(3));
  for (const at of [30, raw.length - 1]) {
    const t = raw.slice();
    t[at] ^= 1;
    assert.equal(L.open(h.h2p, "d1." + L.b64u(t), 0).why, "auth", `bit flip at ${at}`);
  }
  const t = raw.slice();
  t[23] = 99; // counter lives in the nonce: raising it to dodge the replay check breaks the tag
  assert.equal(L.open(h.h2p, "d1." + L.b64u(t), 5).why, "auth");
  assert.equal(L.open(h.h2p, "garbage", 0).why, "format");
  assert.equal(L.open(h.h2p, "d1.!!", 0).why, "format");
});

test("wrong keys are rejected: other phone, other direction", () => {
  const a = pairKeys();
  const b = pairKeys();
  const f = L.seal(a.h.h2p, 1, { t: "x" });
  assert.equal(L.open(b.p.h2p, f, 0).why, "auth", "another pairing's key");
  assert.equal(L.open(a.p.p2h, f, 0).why, "auth", "the other direction's key");
});

test("pairing code: 80 bits, typo-tolerant, one topic+key per code, fingerprint symmetric", () => {
  const code = L.newPairCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.equal(L.normPairCode(code.toLowerCase().replace(/-/g, " ")), code.replace(/-/g, ""));
  assert.equal(L.normPairCode("OOOO-IIII-LLLL-0000"), "0000111111110000");
  assert.equal(L.normPairCode("123456"), null, "a 6-digit code is not accepted");
  const a = L.pairChannel(code);
  const b = L.pairChannel(L.newPairCode());
  assert.notEqual(a.topic, b.topic);
  assert.ok(a.topic.length <= 64 && /^[A-Za-z0-9_-]+$/.test(a.topic));
  assert.equal(L.openPair(b.key, L.sealPair(a.key, { t: "pair" })), null);
  const { hub, phone } = pairKeys();
  assert.match(L.fingerprint(hub.publicKey, phone.publicKey), /^([0-9A-F]{4} ){4}[0-9A-F]{4}$/);
});

test("big messages are split under the relay's 4096-byte limit and reassembled", () => {
  const { h } = pairKeys();
  const big = { t: "state", state: { customWidgets: { cw1: { html: "<b>\"x\"</b>\n".repeat(2500) } } } };
  let c = 0;
  const frames = L.sealChunks((o) => L.seal(h.h2p, ++c, o), big, "m1");
  assert.ok(frames.length > 1);
  assert.ok(frames.every((f) => f.length <= L.MAX_FRAME), "every frame fits");
  const re = new L.Reassembler();
  let out = null;
  let last = 0;
  for (const f of frames.reverse()) { // order of arrival does not matter for reassembly
    const r = L.open(h.h2p, f, 0);
    last = Math.max(last, r.counter);
    out = re.add(r.msg) || out;
  }
  assert.deepEqual(out, big);
});

// ---------- hub <-> relay <-> phone ----------
async function setup(extra = {}) {
  const relay = await fakeNtfy();
  const keyFile = path.join(tmpDir(), "secrets", "dashboard-hub.key");
  const cfg = testConfig({ telegramEnabled: false, relay: { enabled: true, url: relay.base, hubKeyFile: keyFile }, ...extra });
  const h = await startHub(cfg);
  return { relay, h, cfg, keyFile };
}

async function pairPhone(h, relay) {
  const code = h.links.newPairingCode();
  const paired = await pairViaRelay({ base: relay.base, code, name: "test phone", timeoutMs: 5000 });
  const got = [];
  const statuses = [];
  let state = null;
  const link = new RelayLink({ cfg: paired.cfg, secretKey: paired.secretKey, getState: () => state });
  link.addEventListener("message", (e) => { got.push(e.detail); if (e.detail.type === "state") state = e.detail.state; });
  link.addEventListener("status", (e) => statuses.push(e.detail));
  link.start();
  return { code, paired, link, got, statuses, state: () => state };
}

test("pairing over the relay, state + patches + speech + agent question, relay sees only ciphertext", async () => {
  const { relay, h, keyFile } = await setup();
  try {
    assert.ok(fs.existsSync(keyFile), "hub key written to the secrets folder");
    const { paired, link, got, state } = await pairPhone(h, relay);
    const dev = h.store.get().devices.find((d) => d.id === paired.cfg.id);
    assert.equal(dev.kind, "relay");
    assert.equal(dev.fp, paired.cfg.fp, "phone and hub show the same fingerprint");
    assert.ok(!("secretKey" in dev) && !JSON.stringify(h.store.get()).includes(L.b64u(paired.secretKey)), "phone secret never leaves the phone");

    await until(() => state(), 4000, "first snapshot");
    assert.equal(state().layouts[0].widgets.length, 14); // 5 first + 6 + verse, moon, sun (2026-10-24)

    h.store.update((s) => { s.settings.theme = "ember"; });
    await until(() => state().settings.theme === "ember", 6000, "patch");

    h.links.speak("Dinner is ready");
    await until(() => got.some((m) => m.type === "speak" && m.text === "Dinner is ready"), 4000, "speech");

    link.send({ type: "ask", text: "what time is it" });
    await until(() => got.some((m) => m.type === "speak" && m.text === "Agent offline."), 4000, "agent answer");

    // what the relay operator saw
    for (const m of relay.messages) {
      assert.match(m.message, /^(d1|p1)\.[A-Za-z0-9_-]+$/, "only sealed frames");
      for (const plain of ["Dinner", "ember", "Agent offline", "what time", "test phone", paired.cfg.hub, paired.cfg.up, paired.cfg.down]) {
        assert.ok(!m.message.includes(plain), `relay saw "${plain.slice(0, 12)}"`);
      }
      assert.equal(m.query, "?firebase=no");
    }
    link.stop();
  } finally {
    await h.stop();
    await relay.close();
  }
});

test("replayed, tampered and non-whitelisted phone frames do nothing", async () => {
  const { relay, h } = await setup();
  try {
    const { paired, link, got } = await pairPhone(h, relay);
    await until(() => got.some((m) => m.type === "state"), 4000, "snapshot");
    link.send({ type: "ask", text: "first" });
    await until(() => got.filter((m) => m.type === "speak").length === 1, 4000, "answer");
    const down = () => relay.messages.filter((m) => m.topic === paired.cfg.down).length;
    const before = down();

    const askFrame = relay.messages.filter((m) => m.topic === paired.cfg.up).at(-1).message;
    relay.inject(paired.cfg.up, askFrame); // replay
    const t = L.unb64u(askFrame.slice(3));
    t[40] ^= 1;
    relay.inject(paired.cfg.up, "d1." + L.b64u(t)); // tamper
    const keys = L.sessionKeys(paired.secretKey, L.unb64u(paired.cfg.hub));
    relay.inject(paired.cfg.up, L.seal(keys.p2h, 10_000, { t: "exec", cmd: "calc.exe" })); // valid seal, not on the whitelist
    relay.inject(paired.cfg.up, L.seal(keys.h2p, 10_001, { t: "ask", text: "wrong direction key" }));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(down(), before, "the hub sent nothing in reply");
    assert.equal(h.relay.drops, 3, "replay + tamper + wrong key dropped");
    link.stop();
  } finally {
    await h.stop();
    await relay.close();
  }
});

test("/unpair revokes at once: the phone is told, its key and topics are gone, later frames are ignored", async () => {
  const { relay, h } = await setup();
  try {
    const { paired, link, got, statuses } = await pairPhone(h, relay);
    await until(() => got.some((m) => m.type === "state"), 4000, "snapshot");
    assert.equal(await h.links.unpair(paired.cfg.id), true);
    await until(() => statuses.includes("unpaired"), 4000, "revoked on the phone");
    assert.equal(h.store.get().devices.length, 0);
    await until(() => [...relay.subs].every((s) => !s.topics.includes(paired.cfg.up)), 4000, "hub unsubscribed");
    const keys = L.sessionKeys(paired.secretKey, L.unb64u(paired.cfg.hub));
    const n = relay.messages.length;
    relay.inject(paired.cfg.up, L.seal(keys.p2h, 99, { t: "ask", text: "still there?" }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(relay.messages.length, n + 1, "no answer after unpair");

    // /unpair all: every phone and a new hub key
    const pub1 = h.relay.hubPublic;
    await pairPhone(h, relay).then((p) => p.link.stop());
    await h.links.rotate();
    assert.notEqual(h.relay.hubPublic, pub1);
    assert.equal(h.store.get().devices.length, 0);
  } finally {
    await h.stop();
    await relay.close();
  }
});

test("pairing: wrong code gets no answer; 5 bad frames lock pairing for 10 minutes; code is single use", async () => {
  const { relay, h } = await setup();
  try {
    h.links.newPairingCode();
    await assert.rejects(pairViaRelay({ base: relay.base, code: L.newPairCode(), timeoutMs: 800 }), /no answer/);
    const code = h.links.newPairingCode();
    const ch = L.pairChannel(code);
    await until(() => [...relay.subs].some((s) => s.topics.includes(ch.topic)), 3000, "hub on pair topic");
    for (let i = 0; i < 5; i++) relay.inject(ch.topic, L.sealPair(nacl.randomBytes(32), { t: "pair", pk: L.b64u(nacl.randomBytes(32)) }));
    await until(() => h.relay.pairing === null, 3000, "pairing voided");
    assert.equal(h.links.newPairingCode(), null, "locked");
    await assert.rejects(pairViaRelay({ base: relay.base, code, timeoutMs: 800 }), /no answer/);
    assert.equal(h.store.get().devices.length, 0);

    h.relay.pairLockedUntil = 0;
    const c2 = h.links.newPairingCode();
    await pairViaRelay({ base: relay.base, code: c2, timeoutMs: 4000 });
    await assert.rejects(pairViaRelay({ base: relay.base, code: c2, timeoutMs: 800 }), /no answer/, "second use");
    assert.equal(h.store.get().devices.length, 1);
  } finally {
    await h.stop();
    await relay.close();
  }
});

test("daily relay budget: weather waits above the soft cap, speech waits above the hard cap, revoke always goes", async () => {
  const { relay, h } = await setup();
  try {
    const { paired, link, got } = await pairPhone(h, relay);
    await until(() => got.some((m) => m.type === "state"), 4000, "snapshot");
    const down = () => relay.messages.filter((m) => m.topic === paired.cfg.down).length;
    h.store.update((s) => { s.relay.sent = DAY_SOFT; }, { silent: true });
    let n = down();
    await h.relay.send(paired.cfg.id, { t: "patch", base: "x", v: "y", set: { weather: {} } }, "lo");
    assert.equal(down(), n, "weather held");
    await h.relay.send(paired.cfg.id, { t: "speak", text: "hi", at: Date.now() }, "hi");
    assert.equal(down(), n + 1, "speech sent");
    h.store.update((s) => { s.relay.sent = DAY_HARD; }, { silent: true });
    n = down();
    await h.relay.send(paired.cfg.id, { t: "speak", text: "hi", at: Date.now() }, "hi");
    assert.equal(down(), n, "speech held at the hard cap");
    await h.links.unpair(paired.cfg.id);
    assert.equal(down(), n + 1, "revoke still sent");
    link.stop();
  } finally {
    await h.stop();
    await relay.close();
  }
});

test("hub key is reused across restarts and kept outside the repo", async () => {
  const { relay, h, cfg, keyFile } = await setup();
  const pub = h.relay.hubPublic;
  const ver = h.relay.version;
  await h.stop();
  const h2 = await startHub(cfg);
  try {
    assert.equal(h2.relay.hubPublic, pub);
    assert.equal(h2.relay.version, ver, "unchanged state keeps its version: no resync after a restart");
    assert.ok(!path.resolve(keyFile).startsWith(path.resolve(import.meta.dirname, "..", "..")));
  } finally {
    await h2.stop();
    await relay.close();
  }
});
