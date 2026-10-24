// The one network link of the app: a WebSocket to the hub, with hello/token auth and reconnect with backoff.

export class HubLink extends EventTarget {
  constructor({ url, token }) {
    super();
    this.url = url.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.token = token;
    this.backoff = 1000;
    this.ws = null;
    this.stopped = false;
    this.status = "connecting";
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(s) {
    if (s !== this.status) {
      this.status = s;
      this.emit("status", s);
    }
  }

  start() {
    this.stopped = false;
    this.connect();
    // Android may freeze timers in the background; reconnect at once when the screen comes back.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: this.token }));
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "state") {
        this.backoff = 1000;
        this.setStatus("on");
      }
      this.emit("message", m);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      if (e.code === 4001) {
        this.stopped = true;
        this.setStatus("unpaired");
        return;
      }
      this.retry();
    };
    ws.onerror = () => {};
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 20000);
  }

  retry() {
    this.setStatus("off");
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }
}

export async function pairWithHub(baseUrl, code, name) {
  const r = await fetch(baseUrl.replace(/\/$/, "") + "/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `hub said ${r.status}`);
  return j;
}
