// The hub's end of the relay link. Zero open ports: the hub only makes outbound HTTPS/WSS calls to the relay
// (ntfy.sh by default). Every frame is sealed end to end (app/www/app/src/securelink.js); the relay sees random topics,
// ciphertext, sizes and timing. Design and threat model: docs/SECURITY.md.
//
// Per paired phone: its X25519 public key, an "up" topic (phone -> hub) and a "down" topic (hub -> phone), both
// 256-bit random, and one counter per direction. The hub's X25519 key lives in the secrets folder, never in the repo.
// From the phone the hub accepts only a fixed list of message types (PHONE_TYPES); everything else is dropped.
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { publish as ntfyPublish, publishFile, Subscription } from "../../app/www/app/src/ntfy.js";
import { newId } from "./store.js";

L.useNacl(nacl);

const PAIR_TTL = 10 * 60 * 1000;
const PAIR_MAX_FAILS = 5;
const SPEAK_TTL = 30 * 60 * 1000;
export const ONLINE_MS = 45 * 60 * 1000; // the phone sends a heartbeat every 20 min
// ntfy.sh anonymous limit, checked 2026-10-23 with GET https://ntfy.sh/v1/account: 250 messages/day per IP.
export const DAY_SOFT = 170; // above this, routine updates (weather, layout patches) wait for the next day
export const DAY_HARD = 235; // above this, only the revoke message goes out
const PATCH_DEBOUNCE = 3000;
const WEATHER_GAP = 60 * 60 * 1000;
const SNAPSHOT_GAP = 60 * 1000; // a hello with an old version gets at most one snapshot a minute
const RESYNC_GAP = 10 * 1000; // a phone that missed a patch asks again
// blob = an encrypted photo / clip part / live frame riding on a relay attachment; cam / media = camera and playback
// status (errors, "done"). Camera traffic is only ever an answer to a command from the owner's bot (camera.js).
// get = the phone asks for photo-frame / adhan files it does not have in memory (ids from the state).
export const PHONE_TYPES = new Set(["hello", "beat", "ask", "fired", "wake", "perf", "resync", "ui", "blob", "cam", "media", "get", "err", "selftest"]);
const FILE_RESEND_GAP = 10 * 60 * 1000;

const snapHash = (snap) => L.b64u(nacl.hash(L.utf8(JSON.stringify(snap))).subarray(0, 12));
const dayKey = () => new Date().toISOString().slice(0, 10);

export class Relay {
  constructor({ store, base, keyFile, log = () => {}, onAsk = null, onFired = null, onWake = null, onPerf = null, onErr = null, onSelfTest = null, onPaired = () => {}, onUi = null, onHello = null,
    onBlob = null, onCam = null, onGet = null, uiPublic = () => null, publishImpl = ntfyPublish, WS }) {
    Object.assign(this, { store, base, keyFile, log, onAsk, onFired, onWake, onPerf, onErr, onSelfTest, onPaired, onUi, onHello, onBlob, onCam, onGet, uiPublic, publishImpl, WS });
    this.chains = new Map(); // device id -> promise: one send at a time per phone, so counters reach it in order
    this.fileSent = new Map(); // "device:file id" -> time, against repeated requests
    this.keys = this.loadHubKey();
    this.pairing = null; // { code, topic, key, expires, fails }
    this.pairLockedUntil = 0;
    this.sessions = new Map(); // device id -> { h2p, p2h }
    this.parts = new Map(); // device id -> Reassembler
    this.drops = 0;
    // The state version survives a restart while the state is unchanged, so phones need no resync after one.
    this.lastSnap = this.snapshot();
    const saved = (store.get().relay || {}).ver;
    if (saved && saved.hash === snapHash(this.lastSnap)) {
      [this.epoch, this.seq] = [saved.v.split(".")[0], Number(saved.v.split(".")[1]) || 0];
    } else {
      [this.epoch, this.seq] = [L.b64u(nacl.randomBytes(4)), 0];
    }
    this.version = `${this.epoch}.${this.seq}`;
    this.lastWeatherAt = 0;
    this.flushTimer = null;
    this.rs(); // make sure the relay bookkeeping exists
    this.saveVersion();
    store.on("change", () => this.scheduleFlush(PATCH_DEBOUNCE));
  }

  // ---------- keys ----------
  loadHubKey() {
    try {
      const sk = L.unb64u(fs.readFileSync(this.keyFile, "utf8").trim());
      if (sk.length === 32) return L.keyPairFromSecret(sk);
    } catch {}
    return this.writeNewHubKey();
  }

  writeNewHubKey() {
    const kp = L.newKeyPair();
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, L.b64u(kp.secretKey) + "\n", { mode: 0o600 });
    this.log("relay: new hub key written to the secrets folder");
    return kp;
  }

  get hubPublic() {
    return L.b64u(this.keys.publicKey);
  }

  rs() {
    const s = this.store.get();
    if (!s.relay) this.store.update((x) => { x.relay = { since: 0, day: "", sent: 0 }; }, { silent: true });
    const r = this.store.get().relay;
    if (r.day !== dayKey()) this.store.update((x) => Object.assign(x.relay, { day: dayKey(), sent: 0 }), { silent: true });
    return this.store.get().relay;
  }

  devices() {
    return this.store.get().devices.filter((d) => d.kind === "relay");
  }

  session(dev) {
    let k = this.sessions.get(dev.id);
    if (!k) {
      k = L.sessionKeys(this.keys.secretKey, L.unb64u(dev.pk));
      this.sessions.set(dev.id, k);
    }
    return k;
  }

  // ---------- subscription ----------
  start() {
    this.sub = new Subscription({
      base: this.base,
      topics: this.topics(),
      since: this.rs().since,
      WS: this.WS,
      onMessage: (m) => this.onRelayMessage(m),
      onStatus: (s) => this.log(`relay: ${s}`),
    }).start();
    return this;
  }

  topics() {
    const t = this.devices().map((d) => d.up);
    if (this.pairing && Date.now() < this.pairing.expires) t.push(this.pairing.topic);
    return t;
  }

  resubscribe() {
    if (this.sub) this.sub.setTopics(this.topics());
  }

  stop() {
    clearTimeout(this.flushTimer);
    clearTimeout(this.pairTimer);
    if (this.sub) this.sub.stop();
  }

  onRelayMessage(m) {
    if (m.time > (this.rs().since || 0)) this.store.update((s) => { s.relay.since = m.time; }, { silent: true });
    if (this.pairing && m.topic === this.pairing.topic) return this.onPairFrame(m.message);
    const dev = this.devices().find((d) => d.up === m.topic);
    if (!dev) return;
    const r = L.open(this.session(dev).p2h, m.message, dev.rx || 0);
    if (!r.ok) {
      if (++this.drops % 20 === 1) this.log(`relay: dropped a frame for ${dev.id} (${r.why}), ${this.drops} so far`);
      return;
    }
    this.store.update((s) => {
      const d = s.devices.find((x) => x.id === dev.id);
      if (d) { d.rx = r.counter; d.lastSeen = Date.now(); }
    }, { silent: true });
    let msg = r.msg;
    if (msg.t === "part") {
      if (!this.parts.has(dev.id)) this.parts.set(dev.id, new L.Reassembler());
      msg = this.parts.get(dev.id).add(msg);
      if (!msg) return;
    }
    this.dispatch(dev.id, msg, m.attachment).catch((e) => this.log(`relay: ${msg.t} failed: ${e.message}`));
  }

  // ---------- pairing ----------
  newPairingCode() {
    const now = Date.now();
    if (now < this.pairLockedUntil) return null;
    const code = L.newPairCode();
    const ch = L.pairChannel(code);
    this.pairing = { topic: ch.topic, key: ch.key, expires: now + PAIR_TTL, fails: 0 };
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => { this.pairing = null; this.resubscribe(); }, PAIR_TTL);
    this.resubscribe();
    return code;
  }

  pairFailed(why) {
    const p = this.pairing;
    if (!p) return;
    this.log(`relay: pairing frame rejected (${why})`);
    if (++p.fails >= PAIR_MAX_FAILS) {
      this.pairing = null;
      this.pairLockedUntil = Date.now() + PAIR_TTL;
      this.resubscribe();
      this.log("relay: pairing locked for 10 min after repeated failures");
    }
  }

  async onPairFrame(frame) {
    const p = this.pairing;
    if (!p || Date.now() > p.expires) return;
    const msg = L.openPair(p.key, frame);
    if (!msg) return this.pairFailed("wrong key or tampered");
    if (msg.t === "welcome") return; // our own reply, echoed by the relay
    let pk;
    try { pk = L.unb64u(msg.pk); } catch {}
    if (msg.t !== "pair" || !pk || pk.length !== 32) return this.pairFailed("malformed");
    this.pairing = null; // one-time
    clearTimeout(this.pairTimer);
    const dev = {
      id: newId("d"), kind: "relay", name: String(msg.name || "phone").replace(/[^\w .-]/g, "").slice(0, 40) || "phone",
      pk: msg.pk, up: L.randomTopic(), down: L.randomTopic(), rx: 0, tx: 0, pairedAt: Date.now(), lastSeen: Date.now(), lastSnapAt: 0,
    };
    dev.fp = L.fingerprint(this.keys.publicKey, pk);
    this.store.update((s) => s.devices.push(dev), { silent: true });
    this.resubscribe();
    await this.pub(p.topic, L.sealPair(p.key, { t: "welcome", for: msg.pk, id: dev.id, hub: this.hubPublic, up: dev.up, down: dev.down, fp: dev.fp, uiPub: this.uiPublic() }), "hi", 1);
    this.log(`relay: paired ${dev.id} (${dev.name})`);
    this.onPaired(dev);
  }

  // ---------- phone -> hub ----------
  async dispatch(devId, msg, attachment = null) {
    if (!PHONE_TYPES.has(msg.t)) return this.log(`relay: ignored a "${String(msg.t).slice(0, 20)}" message from ${devId}`);
    const dev = this.devices().find((d) => d.id === devId);
    if (!dev) return;
    if ((msg.t === "hello" || msg.t === "beat") && msg.dev && typeof msg.dev === "object") this.saveStatus(devId, msg.dev);
    if (msg.t === "get" && Array.isArray(msg.ids) && this.onGet) {
      return this.onGet(devId, msg.ids.filter((x) => typeof x === "string" && /^[a-z0-9]{3,20}$/.test(x)).slice(0, 6));
    }
    if (msg.t === "hello" && typeof msg.cam === "boolean" && dev.cam !== msg.cam) {
      this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.cam = msg.cam; }, { silent: true });
    }
    if (msg.t === "hello" && msg.client && typeof msg.client === "object") this.saveClient(devId, msg.client);
    if (msg.t === "hello" && this.onHello) this.onHello(devId, msg);
    if (msg.t === "ui" && this.onUi) return this.onUi(devId, msg);
    if (msg.t === "blob") return this.onBlob && this.onBlob(devId, msg, attachment);
    if (msg.t === "cam" || msg.t === "media") return this.onCam && this.onCam(devId, msg);
    if (msg.t === "hello" || msg.t === "resync") {
      if (msg.t === "hello" && msg.v === this.version) return;
      if (Date.now() - (dev.lastSnapAt || 0) < (msg.t === "resync" ? RESYNC_GAP : SNAPSHOT_GAP)) return;
      this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.lastSnapAt = Date.now(); }, { silent: true });
      return this.send(devId, { t: "state", v: this.version, state: this.lastSnap }, "hi");
    }
    if (msg.t === "fired" && typeof msg.id === "string" && msg.id.length <= 40 && this.onFired) return this.onFired(msg.id);
    if (msg.t === "wake" && this.onWake) return this.onWake(); // night mode ended by a tap on the screen
    if (msg.t === "perf") return this.savePerf(devId, msg);
    if (msg.t === "err") return this.onErr && this.onErr(devId, msg);
    if (msg.t === "selftest") return this.onSelfTest && this.onSelfTest(devId, msg);
    if (msg.t === "ask" && typeof msg.text === "string" && msg.text.trim() && this.onAsk) {
      await this.send(devId, { t: "agent", state: "thinking" }, "hi");
      const r = await this.onAsk(msg.text.slice(0, 2000));
      return this.send(devId, { t: "speak", id: newId("s"), text: String(r.text).slice(0, 1000), from: "agent", at: Date.now() }, "hi");
    }
  }

  // ---------- hub -> phone ----------
  // prio: "crit" (revoke) > "hi" (speech, answers, snapshots) > "mid" (state patches) > "lo" (weather-only patches)
  allowed(prio, n) {
    const sent = this.rs().sent;
    if (prio === "crit") return true;
    if (sent + n > DAY_HARD) return false;
    if (prio === "hi") return true;
    return sent + n <= (prio === "mid" ? DAY_HARD - 20 : DAY_SOFT);
  }

  async pub(topic, frame, prio, n) {
    await this.publishImpl(this.base, topic, frame);
    this.store.update((s) => { s.relay.sent += 1; }, { silent: true });
  }

  // Serialises everything sent to one phone: a counter is taken and published before the next one starts.
  chain(devId, fn) {
    const run = (this.chains.get(devId) || Promise.resolve()).then(fn, fn);
    this.chains.set(devId, run.catch(() => {}));
    return run;
  }

  send(devId, obj, prio = "hi") {
    return this.chain(devId, () => this.sendNow(devId, obj, prio));
  }

  // Battery, charging, network and app version, from the phone's hello / heartbeat (shown by /devices).
  // The phone's performance report (app perf.js): numbers and short strings only, kept on the device and logged.
  savePerf(devId, m) {
    const num = (x, lo, hi) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x * 100) / 100 : null);
    const str = (x, n) => (typeof x === "string" ? x.replace(/[^\w .,:;()\/+#@=<>'"\[\]{}-]/g, "").slice(0, n) : "");
    const p = {
      fps: num(m.fps, 0, 240), long: num(m.long, 0, 10000), worst: num(m.worst, 0, 600000), low: m.low === true, switched: m.switched === true,
      mem: num(m.mem, 0, 100000), nodes: num(m.nodes, 0, 1e6), anims: num(m.anims, 0, 1e5), card: str(m.card, 20),
      webview: str(m.webview, 24), android: str(m.android, 10), gpu: str(m.gpu, 80), devMem: num(m.devMem, 0, 64), cores: num(m.cores, 0, 64),
      dpr: num(m.dpr, 0, 8), w: num(m.w, 0, 10000), h: num(m.h, 0, 10000),
      errors: Array.isArray(m.errors) ? m.errors.slice(0, 4).map((e) => str(e, 240)) : [], at: Date.now(),
    };
    this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.perf = p; }, { silent: true });
    this.log(`perf ${devId}: ${p.fps} fps, ${p.long} long frames (worst ${p.worst} ms)${p.low ? ", LOW POWER" : ""}${p.switched ? " (switched now)" : ""}; card ${p.card}; ${p.w}x${p.h}@${p.dpr}; WebView ${p.webview}, Android ${p.android}, GPU ${p.gpu}; heap ${p.mem} MB, ${p.nodes} nodes, ${p.anims} animations${p.errors.length ? `; errors: ${p.errors.join(" | ")}` : ""}`);
    if (this.onPerf) this.onPerf(devId, p);
  }

  // The phone's browser: full user agent, WebView and Android versions, viewport, screen and pixel ratio. Kept on the
  // device record; logged when it changes (a new WebView, the phone turned, a new phone).
  saveClient(devId, c) {
    const num = (x, lo, hi) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x * 100) / 100 : null);
    const str = (x, n) => (typeof x === "string" ? x.replace(/[^\x20-\x7E]/g, "").slice(0, n) : "");
    const client = { ua: str(c.ua, 300), webview: str(c.webview, 24), android: str(c.android, 10), w: num(c.w, 0, 1e4), h: num(c.h, 0, 1e4),
      sw: num(c.sw, 0, 1e4), sh: num(c.sh, 0, 1e4), dpr: num(c.dpr, 0, 8), orient: c.orient === "landscape" ? "landscape" : "portrait" };
    const prev = (this.devices().find((d) => d.id === devId) || {}).client;
    const same = prev && JSON.stringify(prev) === JSON.stringify({ ...client, at: prev.at });
    this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.client = { ...client, at: Date.now() }; }, { silent: true });
    if (!same) this.log(`client ${devId}: WebView ${client.webview}, Android ${client.android}, viewport ${client.w}x${client.h} (${client.orient}), screen ${client.sw}x${client.sh} @${client.dpr}x; UA ${client.ua}`);
  }

  saveStatus(devId, st) {
    const num = (x, lo, hi) => (typeof x === "number" && x >= lo && x <= hi ? x : null);
    const status = {
      bat: num(st.bat, 0, 100), chg: typeof st.chg === "boolean" ? st.chg : null,
      net: ["wifi", "cellular", "none", "unknown", "ethernet"].includes(st.net) ? st.net : null,
      app: typeof st.app === "string" && /^[\w.-]{1,20}$/.test(st.app) ? st.app : null, at: Date.now(),
    };
    this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.status = status; }, { silent: true });
  }

  // A file for the phone (photo-frame picture, adhan recording): encrypted with a one-time key, put on the relay as
  // attachments of up to 1.9 MB, each carrying its sealed {t:"file"} frame as the message. -> true when sent
  sendFile(devId, meta, bytes, prio = "mid") {
    const k = `${devId}:${meta.id}`;
    if (Date.now() - (this.fileSent.get(k) || 0) < FILE_RESEND_GAP) return Promise.resolve(false);
    return this.chain(devId, async () => {
      const dev = this.devices().find((d) => d.id === devId);
      if (!dev) return false;
      const n = Math.max(1, Math.ceil(bytes.length / L.MAX_BLOB_PART));
      this.rs();
      if (n > 8 || !this.allowed(prio, n)) {
        this.log(`relay: held back a file for ${devId} (${n} parts, ${this.rs().sent} sent today)`);
        return false;
      }
      this.fileSent.set(k, Date.now());
      const key = this.session(dev).h2p;
      for (let i = 0; i < n; i++) {
        const b = L.sealBlob(bytes.subarray(i * L.MAX_BLOB_PART, (i + 1) * L.MAX_BLOB_PART));
        let c = 0;
        this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); c = d.tx = (d.tx || 0) + 1; }, { silent: true });
        const frame = L.seal(key, c, { ...meta, t: "file", i, n, key: b.key, sha: b.sha });
        await publishFile(this.base, dev.down, b.upload, "f.bin", { message: frame });
        this.store.update((s) => { s.relay.sent += 1; }, { silent: true });
      }
      return true;
    });
  }

  async sendNow(devId, obj, prio = "hi") {
    const dev = this.devices().find((d) => d.id === devId);
    if (!dev) return false;
    const key = this.session(dev).h2p;
    const sealOne = (o) => {
      let c = 0;
      this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); c = d.tx = (d.tx || 0) + 1; }, { silent: true });
      return L.seal(key, c, o);
    };
    // count frames before sealing (no counter spent on a refused message)
    const probe = L.sealChunks((o) => L.seal(key, 1, o), obj, "probe");
    this.rs();
    if (!this.allowed(prio, probe.length)) {
      this.log(`relay: daily budget, held back a ${obj.t} (${this.rs().sent} sent today)`);
      return false;
    }
    const frames = L.sealChunks(sealOne, obj, newId("m"));
    for (const f of frames) await this.pub(dev.down, f, prio, frames.length);
    return true;
  }

  saveVersion() {
    this.store.update((s) => { s.relay.ver = { v: this.version, hash: snapHash(this.lastSnap) }; }, { silent: true });
  }

  snapshot() {
    const { serverTime, ...rest } = this.store.publicState();
    return JSON.parse(JSON.stringify(rest));
  }

  scheduleFlush(ms) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((e) => this.log(`relay: flush failed: ${e.message}`));
    }, ms);
  }

  // Sends what changed since the last snapshot as one patch to every phone. Weather-only changes go at most hourly.
  async flush() {
    const snap = this.snapshot();
    const changed = Object.keys(snap).filter((k) => JSON.stringify(snap[k]) !== JSON.stringify(this.lastSnap[k]));
    if (!changed.length) return;
    const weatherOnly = changed.every((k) => k === "weather");
    if (weatherOnly && Date.now() - this.lastWeatherAt < WEATHER_GAP) return this.scheduleFlush(this.lastWeatherAt + WEATHER_GAP - Date.now());
    const v = `${this.epoch}.${++this.seq}`;
    const patch = { t: "patch", base: this.version, v, set: Object.fromEntries(changed.map((k) => [k, snap[k]])) };
    const devs = this.devices();
    let held = false;
    for (const d of devs) {
      try {
        if (!(await this.send(d.id, patch, weatherOnly ? "lo" : "mid"))) held = true;
      } catch (e) {
        this.log(`relay: patch to ${d.id} failed: ${e.message}`);
      }
    }
    if (held) return this.scheduleFlush(30 * 60 * 1000); // budget: try again later, the phone stays on the old version
    this.version = v;
    this.lastSnap = snap;
    this.saveVersion();
    if (changed.includes("weather")) this.lastWeatherAt = Date.now();
  }

  // The phone a camera / playback command goes to: the one heard from most recently, if it is online.
  pickPhone() {
    const on = new Set(this.online());
    return this.devices().filter((d) => on.has(d.id)).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0] || null;
  }

  // A command for the phone. `at` lets the phone drop it if it arrives late (the relay keeps messages 12 h).
  command(devId, obj) {
    return this.send(devId, { ...obj, at: Date.now() }, "hi");
  }

  online() {
    return this.devices().filter((d) => Date.now() - (d.lastSeen || 0) < ONLINE_MS).map((d) => d.id);
  }

  // Speech goes to every phone seen in the last day (the relay keeps it 12 h; the phone drops it after 30 min).
  // to: one device id, or null for every phone (the bot's /use target).
  async speak(text, { from = "bot", to = null } = {}) {
    const msg = { t: "speak", id: newId("s"), text: String(text).slice(0, 1000), from, at: Date.now() };
    const recent = this.devices().filter((d) => (!to || d.id === to) && Date.now() - (d.lastSeen || 0) < 24 * 3600 * 1000);
    for (const d of recent) await this.send(d.id, msg, "hi").catch((e) => this.log(`relay: speak to ${d.id} failed: ${e.message}`));
    return this.online().filter((id) => !to || id === to).length;
  }

  // Revokes at once: the phone is told (sealed), its key and topics are deleted, the hub stops listening to it.
  async unpair(id) {
    const dev = this.devices().find((d) => d.id === id);
    if (!dev) return false;
    await this.send(id, { t: "revoked" }, "crit").catch(() => {});
    this.store.update((s) => { s.devices = s.devices.filter((d) => d.id !== id); }, { silent: true });
    this.sessions.delete(id);
    this.parts.delete(id);
    this.resubscribe();
    this.log(`relay: unpaired ${id}`);
    return true;
  }

  // Revokes every phone and replaces the hub key.
  async rotate() {
    for (const d of this.devices()) await this.unpair(d.id);
    this.keys = this.writeNewHubKey();
    this.sessions.clear();
  }
}

export { SPEAK_TTL };
