// UI pushes: signature checks (the phone's own shell/verify.js), bundle build, push over a fake relay to a test phone
// that runs the app's real updater.js, phone reports -> bot messages, resend on reconnect, local admin endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { pairViaRelay, RelayLink } from "../../app/www/app/src/relaylink.js";
import { buildBundle, signBundle, loadShellVerify, BUILTIN_V } from "../src/ui.js";
import { startHub } from "../src/index.js";
import { fakeNtfy } from "./fakeNtfy.js";
import { testConfig, tmpDir } from "./helpers.js";

L.useNacl(nacl);
const V = loadShellVerify();
const SRC = path.resolve(import.meta.dirname, "..", "..", "app", "www", "app");

const until = async (fn, ms = 5000, what = "condition") => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("the shell accepts only signed, newer, well-formed bundles", () => {
  const kp = nacl.sign.keyPair();
  const pub = L.b64u(kp.publicKey);
  const text = buildBundle(SRC, 5);
  const sig = signBundle(text, 5, kp.secretKey);
  const ok = V.verify(text, sig, pub, { minV: 4 });
  assert.equal(ok.ok, true);
  assert.ok(ok.bundle.files["src/main.js"] && ok.bundle.files["styles.css"] && ok.bundle.files["src/widgets/age.js"]);
  assert.ok(!Object.keys(ok.bundle.files).some((f) => f.startsWith("vendor")), "vendor libraries stay in the APK shell");

  assert.equal(V.verify(text, "", pub).why, "unsigned");
  assert.equal(V.verify(text, sig, L.b64u(nacl.sign.keyPair().publicKey)).why, "bad signature", "other key");
  assert.equal(V.verify(text.replace("Birthdays", "Birthdayz"), sig, pub).why, "bad signature", "one changed byte");
  assert.equal(V.verify(text, sig, "").why, "no pinned UI key");
  assert.match(V.verify(text, sig, pub, { minV: 5 }).why, /older or same/, "same version");
  assert.match(V.verify(text, sig, pub, { minV: 9 }).why, /older or same/, "downgrade");
  assert.equal(V.verify(text, sig, pub, { v: 6 }).why, "version mismatch");
  assert.match(V.verify(text, sig, pub, { minV: 1, bad: [5] }).why, /failed before/);
  // a signature for v5 cannot be replayed onto a bundle that claims v6
  const t6 = text.replace('"v":5', '"v":6');
  assert.equal(V.verify(t6, sig, pub).why, "bad signature");
  // signed but malformed: path escape, missing entry
  const evil = JSON.stringify({ format: 1, v: 7, entry: "src/main.js", files: { "src/main.js": "", "../x.js": "" } });
  assert.match(V.verify(evil, signBundle(evil, 7, kp.secretKey), pub).why, /bad file/);
  const noEntry = JSON.stringify({ format: 1, v: 8, entry: "src/main.js", files: { "a.js": "" } });
  assert.equal(V.verify(noEntry, signBundle(noEntry, 8, kp.secretKey), pub).why, "no entry");
});

// A phone in Node: the app's relay link + its real updater.js, with a shell made of the real verify.js.
function testPhone() {
  const store = new Map();
  const st = { max: BUILTIN_V, bad: [], active: BUILTIN_V, staged: null, reloads: 0 };
  let pub = "";
  globalThis.window = {
    nacl,
    __shell: {
      active: () => st.active,
      state: () => ({ active: st.active, max: st.max, bad: st.bad }),
      pinKey: (p) => { pub = p; },
      stage: (text, sig) => {
        const r = V.verify(text, sig, pub, { minV: st.max, bad: st.bad });
        if (!r.ok) return { ok: false, why: r.why };
        st.max = r.bundle.v;
        st.staged = r.bundle;
        store.set(r.bundle.v, text);
        return { ok: true, v: r.bundle.v };
      },
      takeEvents: () => [],
    },
  };
  globalThis.location = { reload: () => { st.reloads++; } };
  return { st, setPub: (p) => { pub = p; } };
}

async function setup() {
  const relay = await fakeNtfy();
  const dir = tmpDir();
  const cfg = testConfig({
    telegramEnabled: false,
    relay: { enabled: true, url: relay.base, hubKeyFile: path.join(dir, "hub.key") },
    ui: { srcDir: SRC, keyFile: path.join(dir, "ui-sign.key"), adminTokenFile: path.join(dir, "admin.token") },
  });
  const h = await startHub(cfg);
  const notes = [];
  h.ui.notify = (m) => notes.push(m);
  return { relay, h, cfg, notes, dir };
}

async function pairPhone(h, relay) {
  const paired = await pairViaRelay({ base: relay.base, code: h.links.newPairingCode(), timeoutMs: 5000 });
  const link = new RelayLink({ cfg: paired.cfg, secretKey: paired.secretKey, getState: () => null });
  const got = [];
  link.addEventListener("message", (e) => got.push(e.detail));
  link.start();
  return { paired, link, got };
}

test("push: signed bundle goes through the relay encrypted; the phone checks, stages and reports; the bot hears it", async () => {
  const { relay, h, notes } = await setup();
  const { updater } = { updater: await import("../../app/www/app/src/updater.js") };
  try {
    const phone = testPhone();
    const { paired, link, got } = await pairPhone(h, relay);
    assert.equal(paired.cfg.uiPub, h.ui.publicKey, "UI key pinned at pairing (desktop browsers; the APK has it baked in)");
    phone.setPub(paired.cfg.uiPub);

    const r = await h.links.uiPush();
    assert.deepEqual([r.v, r.phones], [BUILTIN_V + 1, 1]);
    const msg = await until(() => got.find((m) => m.type === "ui-bundle"), 5000, "ui frame");
    await updater.onUiBundle(msg, { link, isQuiet: () => true });
    assert.equal(phone.st.max, 2);
    assert.ok(phone.st.staged.files["src/main.js"].includes("__shell"));
    await until(() => phone.st.reloads === 1, 4000, "reload at a quiet moment");

    // the relay never saw the UI in clear
    const file = [...relay.files.values()][0];
    for (const plain of ["src/main.js", "Birthdays", "healthy", "import"]) assert.ok(!file.includes(plain), `attachment shows "${plain}"`);
    for (const m of relay.messages.filter((x) => !x.attachment)) assert.match(m.message, /^(d1|p1)\./);

    // the phone, after its reload, reports the new UI healthy -> the bot tells the owner
    await link.post({ t: "ui", active: 2, max: 2, events: [{ v: 2, ok: true }] });
    await until(() => notes.some((n) => /is on UI v2/.test(n)), 4000, "bot note");
    assert.equal(h.ui.status().phones[0].ui.active, 2);

    // same version again is refused by the phone (no downgrade / no replay)
    assert.equal(globalThis.window.__shell.stage(JSON.stringify(phone.st.staged), "x").why, "unsigned", "junk signature: refused, no exception");
    await updater.onUiBundle(msg, { link, isQuiet: () => true });
    assert.equal(phone.st.reloads, 1, "no second install of v2");

    // a failed v3: the phone's report reaches the bot, and the hub does not resend v3 to it
    await h.links.uiPush();
    await link.post({ t: "ui", active: 2, max: 3, events: [{ v: 3, ok: false, reason: "no healthy report within 20 s" }] });
    await until(() => notes.some((n) => /UI v3 did not work .*no healthy report within 20 s.*runs UI v2/.test(n)), 4000, "failure note");
    const before = relay.messages.length;
    h.store.update((s) => { s.devices[0].uiSentAt = 0; }, { silent: true });
    await h.ui.onHello(paired.cfg.id, { ui: { active: 2, max: 3 } });
    assert.equal(relay.messages.length, before, "v3 is not sent again to a phone where it failed");
    link.stop();
  } finally {
    delete globalThis.window;
    delete globalThis.location;
    await h.stop();
    await relay.close();
  }
});

test("a phone that was away gets the current UI when it says hello; a phone with a broken download reports it", async () => {
  const { relay, h, notes } = await setup();
  const updater = await import("../../app/www/app/src/updater.js");
  try {
    await h.links.uiPush(); // v2, no phone yet
    const phone = testPhone();
    const { paired, link, got } = await pairPhone(h, relay);
    phone.setPub(paired.cfg.uiPub);
    await h.ui.onHello(paired.cfg.id, { ui: { active: 1, max: 1 } });
    const msg = await until(() => got.find((m) => m.type === "ui-bundle"), 5000, "resent ui frame");
    assert.equal(msg.v, 2);

    // tampered download: one flipped byte in the encrypted file -> refused, reported, nothing staged
    const [name, buf] = [...relay.files.entries()][0];
    const bad = Buffer.from(buf);
    bad[100] ^= 1;
    relay.files.set(name, bad);
    await updater.onUiBundle(msg, { link, isQuiet: () => true });
    assert.equal(phone.st.max, 1);
    await until(() => notes.some((n) => /UI v2 did not work .*could not decrypt/.test(n)), 4000, "report");

    // a bundle signed with another key, delivered correctly: the shell refuses it
    const other = nacl.sign.keyPair();
    const text = buildBundle(SRC, 2);
    const r = globalThis.window.__shell.stage(text, signBundle(text, 2, other.secretKey));
    assert.deepEqual(r, { ok: false, why: "bad signature" });
    link.stop();
  } finally {
    delete globalThis.window;
    delete globalThis.location;
    await h.stop();
    await relay.close();
  }
});

test("local admin endpoint: token required, browsers (Origin) refused; push + status", async () => {
  const { relay, h, cfg } = await setup();
  try {
    const url = `http://127.0.0.1:${h.hub.port}/api/ui/`;
    const token = fs.readFileSync(cfg.ui.adminTokenFile, "utf8").trim();
    assert.equal((await fetch(url + "status")).status, 403);
    assert.equal((await fetch(url + "status", { headers: { "x-admin-token": "x".repeat(token.length) } })).status, 403);
    assert.equal((await fetch(url + "status", { headers: { "x-admin-token": token, origin: "http://evil.example" } })).status, 403);
    const s = await (await fetch(url + "status", { headers: { "x-admin-token": token } })).json();
    assert.equal(s.version, BUILTIN_V);
    const p = await (await fetch(url + "push", { method: "POST", headers: { "x-admin-token": token } })).json();
    assert.equal(p.v, BUILTIN_V + 1);
    assert.ok(fs.existsSync(cfg.ui.keyFile) && !cfg.ui.keyFile.includes("desk-dashboard"), "signing key outside the repo");
  } finally {
    await h.stop();
    await relay.close();
  }
});
