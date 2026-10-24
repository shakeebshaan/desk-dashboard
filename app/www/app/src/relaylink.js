// The phone's end of the relay link (same events as the old HubLink: "status" and "message").
// The phone never connects to the hub: it subscribes to its "down" topic and publishes to its "up" topic on the
// relay, and every frame is sealed with keys only the phone and the hub have (securelink.js, docs/SECURITY.md).
import * as L from "./securelink.js";
import { publish, publishFile, Subscription } from "./ntfy.js";

const SPEAK_TTL = 30 * 60 * 1000;
const BEAT_MS = 20 * 60 * 1000;
const HELLO_GAP = 60 * 1000;
// Camera and playback commands older than this are dropped: the relay keeps messages 12 h, and a /snap sent while the
// phone was off must not fire hours later.
export const CMD_TTL = 2 * 60 * 1000;
// What the app may send. The hub enforces the same list on its side.
const OUT_TYPES = new Set(["hello", "beat", "ask", "fired", "wake", "perf", "resync", "ui", "blob", "cam", "media", "get", "err", "selftest"]);

// Pairs through the relay with the bot's one-time code. Resolves with the new link config plus the phone's secret key.
export function pairViaRelay({ base, code, name = "phone", timeoutMs = 60000, WS, fetchImpl }) {
  const ch = L.pairChannel(code); // throws on a malformed code
  const kp = L.newKeyPair();
  return new Promise((resolve, reject) => {
    let sent = false;
    const finish = (err, val) => {
      clearTimeout(timer);
      sub.stop();
      err ? reject(err) : resolve(val);
    };
    const sub = new Subscription({
      base, topics: [ch.topic], WS,
      onStatus: (s) => {
        if (s !== "on" || sent) return;
        sent = true;
        publish(base, ch.topic, L.sealPair(ch.key, { t: "pair", pk: L.b64u(kp.publicKey), name }), { fetchImpl })
          .catch((e) => finish(new Error(`relay unreachable (${e.message})`)));
      },
      onMessage: (m) => {
        const w = L.openPair(ch.key, m.message);
        if (!w || w.t !== "welcome" || w.for !== L.b64u(kp.publicKey)) return; // not the answer to this phone
        let hub;
        try { hub = L.unb64u(w.hub); } catch {}
        const topicOk = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(t);
        if (!hub || hub.length !== 32 || !topicOk(w.up) || !topicOk(w.down) || typeof w.id !== "string") return;
        const fp = L.fingerprint(hub, kp.publicKey);
        if (fp !== w.fp) return finish(new Error("fingerprint mismatch"));
        finish(null, {
          cfg: { kind: "relay", relay: base, id: w.id, hub: w.hub, up: w.up, down: w.down, fp, rx: 0, tx: 0, since: 0, v: null,
            uiPub: typeof w.uiPub === "string" && /^[A-Za-z0-9_-]{43}$/.test(w.uiPub) ? w.uiPub : null },
          secretKey: kp.secretKey,
        });
      },
    }).start();
    const timer = setTimeout(() => finish(new Error("no answer from the hub: check the code (10 min, single use) and that the hub is running")), timeoutMs);
  });
}

// The phone's browser facts for the hub's device record (comparing how cards draw here and in a desktop browser).
function client() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent || "";
  return { ua: ua.slice(0, 300), webview: (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || "", android: (/Android ([\d.]+)/.exec(ua) || [])[1] || "",
    w: window.innerWidth, h: window.innerHeight, sw: (window.screen && screen.width) || 0, sh: (window.screen && screen.height) || 0,
    dpr: window.devicePixelRatio || 1, orient: window.innerWidth > window.innerHeight ? "landscape" : "portrait" };
}

export class RelayLink extends EventTarget {
  // cfg: from pairViaRelay; secretKey: Uint8Array; save(cfg): persists counters; getState(): the app's current state.
  // getStatus(): battery / charging / network / app version for the hub's /devices (devstatus.js), or null.
  constructor({ cfg, secretKey, save = () => {}, getState = () => null, getStatus = () => null, WS, fetchImpl }) {
    super();
    Object.assign(this, { cfg: { ...cfg }, save, getState, getStatus, WS, fetchImpl });
    this.keys = L.sessionKeys(secretKey, L.unb64u(cfg.hub));
    this.parts = new L.Reassembler();
    this.status = "connecting";
    this.lastHello = 0;
    this.lastResync = 0;
    this.lastFromHub = 0;
    this.sendChain = Promise.resolve();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(s) {
    if (s !== this.status) { this.status = s; this.emit("status", s); }
  }

  persist(patch) {
    Object.assign(this.cfg, patch);
    this.save(this.cfg);
  }

  start() {
    this.sub = new Subscription({
      base: this.cfg.relay, topics: [this.cfg.down], since: this.cfg.since, WS: this.WS,
      onMessage: (m) => this.onFrame(m),
      onStatus: (s) => {
        this.setStatus(s === "on" ? "on" : s === "off" ? "off" : "connecting");
        // once per app start: after a reconnect, "since" already brings what was missed (no extra messages)
        if (s === "on" && !this.greeted) { this.greeted = true; this.hello(true); }
      },
    }).start();
    this.beat = setInterval(() => this.post({ t: "beat", ...this.dev() }), BEAT_MS);
    if (typeof document !== "undefined") {
      this.onVis = () => { if (!document.hidden && this.sub) this.sub.kick(); };
      document.addEventListener("visibilitychange", this.onVis);
    }
    return this;
  }

  hello(force = false) {
    if (!force && Date.now() - this.lastHello < HELLO_GAP) return;
    this.lastHello = Date.now();
    const sh = typeof window !== "undefined" && window.__shell;
    // cam: the APK has the camera/mic build (0.3.1+, which also brings the OnDeviceSpeech plugin); browsers: yes
    const cap = typeof window !== "undefined" && window.Capacitor;
    const cam = !cap || !cap.isNativePlatform || !cap.isNativePlatform() || !!(cap.isPluginAvailable && cap.isPluginAvailable("OnDeviceSpeech"));
    this.post({ t: "hello", v: this.cfg.v, cam, ...this.dev(), ...(sh ? { ui: { active: sh.active(), max: sh.state().max } } : {}), client: client() });
  }

  dev() {
    const st = this.getStatus && this.getStatus();
    return st ? { dev: st } : {};
  }

  onFrame(m) {
    const r = L.open(this.keys.h2p, m.message, this.cfg.rx);
    if (!r.ok) return; // replay, tamper, wrong key or junk on the topic: dropped
    this.persist({ rx: r.counter, since: Math.max(this.cfg.since || 0, m.time || 0) });
    this.lastFromHub = Date.now();
    let msg = r.msg;
    if (msg.t === "part") {
      msg = this.parts.add(msg);
      if (!msg) return;
    }
    switch (msg.t) {
      case "state":
        if (msg.state && typeof msg.state === "object") {
          this.persist({ v: msg.v });
          this.emit("message", { type: "state", state: msg.state });
        }
        break;
      case "patch": {
        const cur = this.getState();
        if (cur && msg.base === this.cfg.v && msg.set && typeof msg.set === "object") {
          this.persist({ v: msg.v });
          this.emit("message", { type: "state", state: { ...cur, ...msg.set } });
        } else if (Date.now() - this.lastResync > HELLO_GAP) {
          this.lastResync = Date.now();
          this.post({ t: "resync" });
        }
        break;
      }
      case "speak":
        if (typeof msg.text === "string" && Date.now() - (msg.at || 0) < SPEAK_TTL) this.emit("message", { type: "speak", text: msg.text, from: msg.from });
        break;
      case "agent":
        this.emit("message", { type: "agent", state: msg.state === "thinking" ? "thinking" : "idle" });
        break;
      case "ui": // a pushed UI bundle: the shell checks its signature before anything runs (updater.js)
        if (Number.isSafeInteger(msg.v) && ["url", "k", "n", "sig"].every((f) => typeof msg[f] === "string")) {
          this.emit("message", { type: "ui-bundle", v: msg.v, url: msg.url, k: msg.k, n: msg.n, sig: msg.sig });
        }
        break;
      case "cam": // /snap, /clip, /live from the bot (owner only, sealed by the hub); camera.js enforces the limits again
        if (["snap", "clip", "live"].includes(msg.op) && typeof msg.id === "string" && msg.id.length <= 40) {
          if (this.fresh(msg)) this.emit("message", { type: "cam", op: msg.op, id: msg.id, facing: msg.facing === "back" ? "back" : "front",
            secs: Number(msg.secs) || 0, every: Number(msg.every) || 0, audio: msg.audio !== false });
          else if (Date.now() - msg.at < 30 * 60 * 1000) this.post({ t: "cam", id: msg.id, state: "error", err: "the command arrived too late (phone was offline, or its clock is off)" });
        }
        break;
      case "play":
        if (typeof msg.url === "string" && /^https:\/\//.test(msg.url) && msg.url.length <= 2000 && this.fresh(msg)) this.emit("message", { type: "play", url: msg.url });
        break;
      case "file": // a photo-frame picture / adhan part: the encrypted bytes are the attachment of this same message
        if (m.attachment && typeof m.attachment.url === "string" && typeof msg.id === "string" && typeof msg.key === "string" && typeof msg.sha === "string") {
          this.emit("message", { type: "file", id: msg.id, kind: msg.kind, mime: typeof msg.mime === "string" ? msg.mime : "", i: msg.i, n: msg.n, key: msg.key, sha: msg.sha, url: m.attachment.url });
        }
        break;
      case "stop":
        if (this.fresh(msg)) this.emit("message", { type: "stop" });
        break;
      case "selftest": // /selftest from the bot: every card in turn, measured (selftest.js)
        if (typeof msg.id === "string" && msg.id.length <= 40 && this.fresh(msg)) this.emit("message", { type: "selftest", id: msg.id });
        break;
      case "revoked":
        this.stop();
        this.setStatus("unpaired");
        break;
      default:
        break; // anything else from the hub is ignored too
    }
  }

  // Old HubLink API: the app sends {type:"ask", text} / {type:"fired", id} / {type:"wake"}.
  send(obj) {
    if (!obj) return;
    if (obj.type === "ask" && typeof obj.text === "string") this.post({ t: "ask", text: obj.text.slice(0, 2000) });
    else if (obj.type === "fired" && typeof obj.id === "string") this.post({ t: "fired", id: obj.id.slice(0, 40) });
    else if (obj.type === "wake") this.post({ t: "wake" });
  }

  fresh(msg) {
    return typeof msg.at === "number" && Math.abs(Date.now() - msg.at) < CMD_TTL;
  }

  // A photo / clip part / live frame: encrypted with a one-time key, uploaded as a relay attachment, with the sealed
  // {t:"blob"} frame (key, hash, what it is) as the same message's text. -> true when the relay took it.
  upload(meta, bytes) {
    if (this.stopped) return Promise.resolve(false);
    const run = this.sendChain.then(async () => {
      const b = L.sealBlob(bytes);
      const c = (this.cfg.tx || 0) + 1;
      this.persist({ tx: c });
      const frame = L.seal(this.keys.p2h, c, { ...meta, t: "blob", key: b.key, sha: b.sha, size: bytes.length });
      await publishFile(this.cfg.relay, this.cfg.up, b.upload, "b.bin", { fetchImpl: this.fetchImpl, message: frame });
      return true;
    });
    this.sendChain = run.catch(() => false);
    return run;
  }

  // Relay messages this phone's internet address may still send today (ntfy.sh counts per IP), or null if unknown.
  async budget() {
    try {
      const r = await (this.fetchImpl || globalThis.fetch)(`${this.cfg.relay}/v1/account`);
      const j = r.ok ? await r.json() : null;
      const n = j && j.stats && j.stats.messages_remaining;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  post(msg) {
    if (!OUT_TYPES.has(msg.t) || this.stopped) return Promise.resolve(false);
    // serialised so counters reach the relay in order
    this.sendChain = this.sendChain.then(async () => {
      const frames = L.sealChunks((o) => {
        const c = (this.cfg.tx || 0) + 1;
        this.persist({ tx: c });
        return L.seal(this.keys.p2h, c, o);
      }, msg, `m${Date.now().toString(36)}`);
      for (const f of frames) await publish(this.cfg.relay, this.cfg.up, f, { fetchImpl: this.fetchImpl });
      return true;
    }).catch(() => false);
    return this.sendChain;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.beat);
    if (this.sub) this.sub.stop();
    if (this.onVis) document.removeEventListener("visibilitychange", this.onVis);
  }
}
