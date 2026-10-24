// UI pushes: the app's whole web UI (app/www/app/) as one signed bundle, sent to every paired phone over the relay.
//   bundle   = JSON { format: 1, v, entry, builtAt, files } (text files only; vendor libraries stay in the APK shell)
//   signed   = Ed25519 with the UI-signing key in the secrets folder (separate from the link key; never in the repo)
//   delivery = encrypted with a one-time key (XSalsa20-Poly1305) and put on the relay as a file; the URL and the key
//              go to each phone inside a sealed {t:"ui"} frame, so the relay sees only ciphertext
// The phone's shell checks the signature, refuses older versions, runs the new UI on trial and rolls back if it
// does not report healthy (app/www/shell/boot.js). The phone's report comes back as {t:"ui"} -> a bot message.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { publishFile } from "../../app/www/app/src/ntfy.js";

// The very same check the phone's shell runs (a plain browser script, so it is loaded the way the browser does).
export function loadShellVerify() {
  const file = fileURLToPath(new URL("../../app/www/shell/verify.js", import.meta.url));
  const self = { nacl };
  // Uint8Array from this realm, so TweetNaCl's type checks accept the arrays the script makes
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { self, TextEncoder, atob, Uint8Array }, { filename: file });
  return self.ShellVerify;
}
const ShellVerify = loadShellVerify();

L.useNacl(nacl);

export const UI_ENTRY = "src/main.js";
export const BUILTIN_V = 1; // the UI built into APK 0.3.0; pushes start at 2
const TEXT_FILE = /\.(js|css|html|json|svg|txt)$/;
const RESEND_GAP = 10 * 60 * 1000;
const FILE_TTL = 2.5 * 3600 * 1000; // ntfy.sh keeps attachments 3 h
const MAX_BYTES = 1.5 * 1024 * 1024;

export function loadSigningKey(file, log = () => {}) {
  try {
    const sk = L.unb64u(fs.readFileSync(file, "utf8").trim());
    if (sk.length === 64) return nacl.sign.keyPair.fromSecretKey(sk);
  } catch {}
  const kp = nacl.sign.keyPair();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, L.b64u(kp.secretKey) + "\n", { mode: 0o600 });
  log("ui: new UI-signing key written to the secrets folder");
  return kp;
}

export function buildBundle(srcDir, v) {
  const files = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), p);
      else if (TEXT_FILE.test(e.name)) files[p] = fs.readFileSync(path.join(dir, e.name), "utf8").replace(/\r\n/g, "\n");
    }
  };
  walk(srcDir, "");
  if (!files[UI_ENTRY]) throw new Error(`no ${UI_ENTRY} in ${srcDir}`);
  const text = JSON.stringify({ format: 1, v, entry: UI_ENTRY, builtAt: new Date().toISOString(), files });
  if (L.utf8(text).length > MAX_BYTES) throw new Error("UI bundle too large");
  return text;
}

export const signBundle = (text, v, secretKey) =>
  L.b64u(nacl.sign.detached(ShellVerify.signedMessage(v, L.utf8(text)), secretKey));

export class UiPublisher {
  constructor({ store, relay, srcDir, keyFile, dataDir, log = () => {}, notify = () => {} }) {
    Object.assign(this, { store, relay, srcDir, dataDir, log, notify });
    this.keys = loadSigningKey(keyFile, log);
    this.dir = path.join(dataDir, "ui");
    fs.mkdirSync(this.dir, { recursive: true });
    if (!store.get().ui) store.update((s) => { s.ui = { version: BUILTIN_V }; }, { silent: true });
  }

  get publicKey() {
    return L.b64u(this.keys.publicKey);
  }

  get version() {
    return this.store.get().ui.version;
  }

  status() {
    const u = this.store.get().ui;
    return {
      version: u.version, builtAt: u.builtAt || null, size: u.size || 0,
      phones: this.relay.devices().map((d) => ({ id: d.id, name: d.name, ui: d.ui || null })),
    };
  }

  // Builds, signs and sends a new UI version to every paired phone. -> { v, size, phones }
  async push({ srcDir = this.srcDir } = {}) {
    const v = Math.max(this.version, BUILTIN_V) + 1;
    const text = buildBundle(srcDir, v);
    const sig = signBundle(text, v, this.keys.secretKey);
    const check = ShellVerify.verify(text, sig, this.publicKey, { minV: v - 1 });
    if (!check.ok) throw new Error(`self-check failed: ${check.why}`);
    fs.writeFileSync(path.join(this.dir, `v${v}.json`), JSON.stringify({ v, sig, text }));
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^v(\d+)\.json$/.exec(f);
      if (m && +m[1] < v - 4) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    this.store.update((s) => { s.ui = { version: v, sig, builtAt: JSON.parse(text).builtAt, size: L.utf8(text).length }; }, { silent: true });
    await this.upload();
    let phones = 0;
    for (const d of this.relay.devices()) {
      if (await this.sendTo(d.id)) phones++;
    }
    this.log(`ui: pushed v${v} (${this.store.get().ui.size} bytes) to ${phones} phone(s)`);
    return { v, size: this.store.get().ui.size, phones };
  }

  // Encrypts the current bundle with a fresh one-time key and puts it on the relay as a file.
  async upload() {
    const u = this.store.get().ui;
    const { text } = JSON.parse(fs.readFileSync(path.join(this.dir, `v${u.version}.json`), "utf8"));
    if (!this.relay.allowed("hi", 1)) throw new Error("relay budget for today is used up");
    const k = nacl.randomBytes(32);
    const n = nacl.randomBytes(24);
    const url = await publishFile(this.relay.base, L.randomTopic(), nacl.secretbox(L.utf8(text), n, k), `ui-v${u.version}.bin`);
    this.store.update((s) => {
      Object.assign(s.ui, { url, uploadedAt: Date.now(), k: L.b64u(k), n: L.b64u(n) });
      s.relay.sent += 1;
    }, { silent: true });
  }

  async sendTo(devId) {
    const u = this.store.get().ui;
    if (!u.url) return false;
    if (Date.now() - u.uploadedAt > FILE_TTL) await this.upload();
    const x = this.store.get().ui;
    const ok = await this.relay.send(devId, { t: "ui", v: x.version, url: x.url, k: x.k, n: x.n, sig: x.sig, size: x.size }, "hi");
    if (ok) this.setDev(devId, (d) => { d.uiSentAt = Date.now(); d.uiSentV = x.version; });
    return ok;
  }

  setDev(devId, fn) {
    this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) fn(d); }, { silent: true });
  }

  dev(devId) {
    return this.store.get().devices.find((d) => d.id === devId);
  }

  // A phone that (re)connects behind the current version gets it again (at most every 10 min, never one it refused).
  async onHello(devId, msg) {
    const ui = msg.ui;
    if (!ui || !Number.isSafeInteger(ui.active) || !Number.isSafeInteger(ui.max)) return;
    this.setDev(devId, (d) => { d.ui = { active: ui.active, max: ui.max, at: Date.now() }; });
    const d = this.dev(devId);
    const v = this.version;
    if (v > ui.max && v > BUILTIN_V && !(d.uiBad || []).includes(v) && Date.now() - (d.uiSentAt || 0) > RESEND_GAP) {
      await this.sendTo(devId).catch((e) => this.log(`ui: resend failed: ${e.message}`));
    }
  }

  // The phone's report after a UI start or a failed install.
  onUi(devId, msg) {
    const d = this.dev(devId);
    if (!d || !Number.isSafeInteger(msg.active)) return;
    this.setDev(devId, (x) => { x.ui = { active: msg.active, max: Number.isSafeInteger(msg.max) ? msg.max : msg.active, at: Date.now() }; });
    for (const e of (Array.isArray(msg.events) ? msg.events : []).slice(0, 10)) {
      if (!e || !Number.isSafeInteger(e.v)) continue;
      const reason = String(e.reason || "").replace(/[^\x20-\x7E]/g, "").slice(0, 160);
      if (e.ok) this.notify(`📱 ${d.name} is on UI v${e.v}.`);
      else {
        this.setDev(devId, (x) => { x.uiBad = [...new Set([...(x.uiBad || []), e.v])].slice(-20); });
        this.notify(`⚠️ UI v${e.v} did not work on ${d.name}: ${reason || "no reason given"}. The phone runs UI v${msg.active}.`);
      }
    }
  }
}
