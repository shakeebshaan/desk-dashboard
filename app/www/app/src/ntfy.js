// The relay: ntfy.sh (or any ntfy server), used as a dumb mailbox. Shared by the app and the hub; both only make
// OUTBOUND connections to it. It only ever carries the sealed frames from securelink.js.
//   publish:   POST {base}/{topic}?firebase=no   body = frame   (firebase=no: ntfy.sh does not forward to Google FCM)
//   subscribe: WebSocket {base}/{t1,t2}/ws?since={unix seconds}   (catches up on what was cached while away, 12 h)

export async function publish(base, topic, body, { fetchImpl = globalThis.fetch } = {}) {
  const r = await fetchImpl(`${base.replace(/\/$/, "")}/${topic}?firebase=no`, { method: "POST", body });
  if (!r.ok) {
    const e = new Error(`relay said ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json().catch(() => ({}));
}

// A file as a ntfy attachment (one message; ntfy.sh keeps it 3 h, max 2 MB anonymous), always already encrypted:
// the hub's UI bundles, the phone's photos/clips/frames. `message` (optional) becomes the message text, so a sealed
// frame rides along with the file in the same relay message. -> its download URL
export async function publishFile(base, topic, bytes, name, { fetchImpl = globalThis.fetch, message = null } = {}) {
  const headers = { Filename: name };
  if (message) headers.Message = message;
  const r = await fetchImpl(`${base.replace(/\/$/, "")}/${topic}?firebase=no`, { method: "PUT", body: bytes, headers });
  if (!r.ok) {
    const e = new Error(`relay said ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  if (!j.attachment || typeof j.attachment.url !== "string") throw new Error("relay kept no attachment");
  return j.attachment.url;
}

// One WebSocket for a set of topics, reconnecting with backoff; onMessage({ id, time, topic, message }).
export class Subscription {
  constructor({ base, topics, since = 0, onMessage, onStatus = () => {}, WS = globalThis.WebSocket }) {
    Object.assign(this, { base: base.replace(/\/$/, ""), topics: [...topics], since, onMessage, onStatus, WS });
    this.backoff = 1000;
    this.stopped = false;
    this.ws = null;
    this.status = "off";
  }

  setStatus(s) {
    if (s !== this.status) { this.status = s; this.onStatus(s); }
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  // quiet: a planned refresh of a working link (the 5-minute watchdog): no "connecting" status, so the logs and the
  // phone's link dot only show real outages
  connect(quiet = false) {
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    if (this.stopped || !this.topics.length) return this.setStatus("off");
    const url = `${this.base.replace(/^http/, "ws")}/${this.topics.join(",")}/ws?since=${this.since ? Math.max(0, this.since - 1) : "10m"}`;
    let ws;
    try { ws = new this.WS(url); } catch { return this.retry(); }
    this.ws = ws;
    if (!quiet) this.setStatus("connecting");
    const alive = () => {
      clearTimeout(this.watchdog);
      // ntfy.sh keeps WebSockets alive with ping frames, which scripts cannot see (checked 2026-10-23: no keepalive
      // event in 95 s). So silence is normal; after 5 min reconnect anyway (quietly), which also catches a silently
      // dead link. Nothing is lost: the reconnect asks for everything since the last message.
      this.watchdog = setTimeout(() => {
        if (this.ws !== ws) return;
        ws.onclose = null;
        try { ws.close(); } catch {}
        this.connect(true);
      }, 5 * 60 * 1000);
    };
    ws.onopen = () => { this.backoff = 1000; this.setStatus("on"); alive(); };
    ws.onmessage = (e) => {
      alive();
      let m;
      try { m = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); } catch { return; }
      if (m.event !== "message" || typeof m.message !== "string" || !this.topics.includes(m.topic)) return;
      if (m.time > this.since) this.since = m.time;
      try { this.onMessage(m); } catch {}
    };
    ws.onclose = () => { if (this.ws === ws) this.retry(); };
    ws.onerror = () => {};
  }

  retry() {
    this.ws = null;
    if (this.stopped) return;
    this.setStatus("off");
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  // Reconnect at once (e.g. the screen came back on).
  kick() {
    if (!this.ws || this.ws.readyState > 1) { this.backoff = 1000; this.connect(); }
  }

  setTopics(topics) {
    const next = [...new Set(topics)].sort();
    if (next.join() === [...this.topics].sort().join()) return;
    this.topics = next;
    const old = this.ws;
    this.ws = null;
    if (old) { old.onclose = null; try { old.close(); } catch {} }
    if (!this.stopped) this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    const old = this.ws;
    this.ws = null;
    if (old) { old.onclose = null; try { old.close(); } catch {} }
    this.setStatus("off");
  }
}
