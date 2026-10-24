// HTTP + WebSocket API for the phone. Binds to localhost / the loopback only (HUB_HOST), never 0.0.0.0 by default.
//   POST /api/pair  {code, name} -> {token}     one-time code from the bot's /pair
//   GET  /api/health                            {ok}
//   POST /api/ui/push, GET /api/ui/status, POST /api/ui/unpair?id=   local admin only: no Origin header + the token from the secrets folder
//                                               (scripts/ui-push.mjs); this server listens on 127.0.0.1 only
//   WS   /ws        first message {type:"hello", token}, then state snapshots + speak events
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { newId } from "./store.js";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const PAIR_TTL = 10 * 60 * 1000;
const PAIR_MAX_FAILS = 5;
const SPEAK_TTL = 30 * 60 * 1000;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

export class Hub {
  constructor({ store, host, port, serveDir = null, log = () => {}, onAsk = null, onFired = null, onWake = null, admin = null }) {
    Object.assign(this, { store, host, port, serveDir, log, onAsk, onFired, onWake, admin });
    this.pairing = null; // { hash, expires }
    this.pairFails = 0;
    this.pairLockedUntil = 0;
    this.sockets = new Map(); // ws -> device id
    this.speakQueue = []; // { id, text, at }
    store.on("change", () => this.broadcast({ type: "state", state: store.publicState() }));
  }

  allowedOrigin(origin) {
    if (!origin) return true; // native clients / curl on the tailnet still need a token
    return ["http://localhost", "https://localhost", "capacitor://localhost", `http://${this.host}:${this.port}`,
      `http://localhost:${this.port}`, `http://127.0.0.1:${this.port}`].includes(origin);
  }

  newPairingCode() {
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    this.pairing = { hash: sha256(code), expires: Date.now() + PAIR_TTL };
    this.pairFails = 0;
    this.pairLockedUntil = 0;
    return code;
  }

  pair(code, name) {
    const now = Date.now();
    if (now < this.pairLockedUntil) return { status: 429, body: { error: "locked, try again later" } };
    const p = this.pairing;
    const ok = p && now < p.expires && typeof code === "string" &&
      crypto.timingSafeEqual(Buffer.from(sha256(code.trim())), Buffer.from(p.hash));
    if (!ok) {
      if (++this.pairFails >= PAIR_MAX_FAILS) {
        this.pairing = null;
        this.pairLockedUntil = now + PAIR_TTL;
      }
      return { status: 403, body: { error: "wrong or expired code" } };
    }
    this.pairing = null;
    const token = crypto.randomBytes(32).toString("base64url");
    const id = newId("d");
    const dev = { id, name: String(name || "phone").slice(0, 40), tokenHash: sha256(token), pairedAt: now, lastSeen: 0 };
    this.store.update((s) => s.devices.push(dev), { silent: true });
    this.log(`paired device ${id} (${dev.name})`);
    return { status: 200, body: { token, deviceId: id } };
  }

  unpair(id) {
    const dev = this.store.get().devices.find((d) => d.id === id);
    if (!dev) return false;
    this.store.update((s) => { s.devices = s.devices.filter((d) => d.id !== id); }, { silent: true });
    for (const [ws, devId] of this.sockets) if (devId === id) ws.close(4001, "unpaired");
    return true;
  }

  onlineDevices() {
    return [...new Set(this.sockets.values())];
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) if (ws.readyState === 1) ws.send(data);
  }

  // Returns how many phones got it now; if none is online it waits (30 min) for the next reconnect.
  speak(text, { from = "bot" } = {}) {
    const msg = { type: "speak", id: newId("s"), text: String(text).slice(0, 1000), from, at: Date.now() };
    const n = this.onlineDevices().length;
    if (n) this.broadcast(msg);
    else this.speakQueue = [...this.speakQueue.filter((m) => Date.now() - m.at < SPEAK_TTL), msg].slice(-20);
    return n;
  }

  json(res, status, body, origin) {
    const h = { "content-type": "application/json", "cache-control": "no-store" };
    if (origin && this.allowedOrigin(origin)) Object.assign(h, { "access-control-allow-origin": origin, vary: "origin" });
    res.writeHead(status, h);
    res.end(JSON.stringify(body));
  }

  handleHttp(req, res) {
    const origin = req.headers.origin;
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") {
      if (!this.allowedOrigin(origin)) return res.writeHead(403).end();
      res.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, GET",
        "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      return res.end();
    }
    if (url.pathname === "/api/health") return this.json(res, 200, { ok: true }, origin);
    if (url.pathname.startsWith("/api/ui/")) return this.handleAdmin(req, res, url);
    if (url.pathname === "/api/pair" && req.method === "POST") {
      if (!this.allowedOrigin(origin)) return this.json(res, 403, { error: "origin" });
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on("end", () => {
        let j = {};
        try { j = JSON.parse(body); } catch {}
        const r = this.pair(j.code, j.name);
        this.json(res, r.status, r.body, origin);
      });
      return;
    }
    if (this.serveDir && req.method === "GET") return this.serveStatic(url.pathname, res);
    res.writeHead(404).end();
  }

  async handleAdmin(req, res, url) {
    const a = this.admin;
    const tok = String(req.headers["x-admin-token"] || "");
    const ok = a && a.token && !req.headers.origin && tok.length === a.token.length &&
      crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(a.token));
    if (!ok) return this.json(res, 403, { error: "forbidden" });
    try {
      if (url.pathname === "/api/ui/push" && req.method === "POST") return this.json(res, 200, await a.push());
      if (url.pathname === "/api/ui/status" && req.method === "GET") return this.json(res, 200, a.status());
      if (url.pathname === "/api/ui/unpair" && req.method === "POST" && a.unpair) {
        const id = String(url.searchParams.get("id") || "");
        return this.json(res, 200, { id, unpaired: /^[a-z0-9]{3,20}$/.test(id) ? !!(await a.unpair(id)) : false });
      }
      return this.json(res, 404, { error: "not found" });
    } catch (e) {
      return this.json(res, 500, { error: e.message });
    }
  }

  serveStatic(p, res) {
    const rel = decodeURIComponent(p === "/" ? "/index.html" : p);
    const file = path.normalize(path.join(this.serveDir, rel));
    if (!file.startsWith(path.normalize(this.serveDir))) return res.writeHead(403).end();
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(buf);
    });
  }

  handleSocket(ws, req) {
    if (!this.allowedOrigin(req.headers.origin)) return ws.close(4003, "origin");
    let devId = null;
    const helloTimer = setTimeout(() => !devId && ws.close(4002, "hello timeout"), 5000);
    ws.on("message", async (raw) => {
      let m;
      try { m = JSON.parse(String(raw).slice(0, 10000)); } catch { return; }
      if (!devId) {
        const h = m.type === "hello" && typeof m.token === "string" ? sha256(m.token) : "";
        const dev = h && this.store.get().devices.find((d) => d.tokenHash === h);
        if (!dev) return ws.close(4001, "unpaired");
        devId = dev.id;
        clearTimeout(helloTimer);
        this.sockets.set(ws, devId);
        this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.lastSeen = Date.now(); }, { silent: true });
        ws.send(JSON.stringify({ type: "state", state: this.store.publicState() }));
        const pending = this.speakQueue.filter((x) => Date.now() - x.at < SPEAK_TTL);
        this.speakQueue = [];
        for (const x of pending) ws.send(JSON.stringify(x));
        this.log(`device ${devId} connected${pending.length ? `, delivered ${pending.length} queued` : ""}`);
        return;
      }
      if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      if (m.type === "fired" && typeof m.id === "string" && this.onFired) return this.onFired(m.id);
      if (m.type === "wake" && this.onWake) return this.onWake(); // night mode ended by a tap on the screen
      if (m.type === "ask" && typeof m.text === "string" && this.onAsk) {
        ws.send(JSON.stringify({ type: "agent", state: "thinking" }));
        const r = await this.onAsk(m.text.slice(0, 2000));
        ws.send(JSON.stringify({ type: "speak", id: newId("s"), text: r.text, from: "agent", at: Date.now() }));
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.sockets.delete(ws);
    });
    ws.on("error", () => {});
  }

  listen() {
    this.http = http.createServer((q, s) => this.handleHttp(q, s));
    this.wss = new WebSocketServer({ server: this.http, path: "/ws", maxPayload: 16 * 1024 });
    this.wss.on("connection", (ws, req) => this.handleSocket(ws, req));
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets.keys()) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }, 25000);
    this.wss.on("connection", (ws) => { ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; }); });
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.port, this.host, () => {
        this.port = this.http.address().port;
        resolve(this.http.address());
      });
    });
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const ws of this.sockets.keys()) ws.terminate();
    await new Promise((r) => this.wss.close(() => r()));
    await new Promise((r) => this.http.close(() => r()));
  }
}
