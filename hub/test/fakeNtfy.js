// A minimal ntfy-compatible relay for tests: POST /{topic}, WebSocket /{t1,t2}/ws?since=. Keeps every message so
// tests can inspect exactly what a relay operator would see.
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

export async function fakeNtfy() {
  const messages = [];
  const subs = new Set(); // { ws, topics }
  const files = new Map(); // attachments: name -> Buffer (PUT with a Filename header, GET /file/<name>)
  const account = { remaining: null }; // GET /v1/account: messages left today for "this IP" (null = 404)
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, PUT, POST" };
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    const url = new URL(req.url, "http://x");
    const topic = url.pathname.slice(1);
    const fm = /^\/file\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === "GET" && url.pathname === "/v1/account") {
      if (account.remaining === null) return res.writeHead(404, cors).end();
      res.writeHead(200, { "content-type": "application/json", ...cors });
      return res.end(JSON.stringify({ limits: { messages: 250 }, stats: { messages_remaining: account.remaining } }));
    }
    if (req.method === "GET" && fm) {
      const f = files.get(fm[1]);
      if (!f) return res.writeHead(404, { "access-control-allow-origin": "*" }).end();
      res.writeHead(200, { "content-type": "application/octet-stream", "access-control-allow-origin": "*" });
      return res.end(f);
    }
    if (req.method === "PUT" && req.headers.filename && /^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const name = `${crypto.randomBytes(6).toString("hex")}.bin`;
        files.set(name, Buffer.concat(chunks));
        // like ntfy.sh: a Message header becomes the message text, and subscribers get the message with the attachment
        const m = { id: crypto.randomBytes(6).toString("hex"), time: Math.floor(Date.now() / 1000), event: "message", topic,
          message: req.headers.message || "You received a file", attachment: { name: req.headers.filename, url: `http://127.0.0.1:${server.address().port}/file/${name}` }, query: url.search };
        messages.push(m);
        for (const s of subs) if (s.topics.includes(topic) && s.ws.readyState === 1) s.ws.send(JSON.stringify(m));
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(JSON.stringify(m));
      });
      return;
    }
    if (req.method !== "POST" || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return res.writeHead(404).end();
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (body.length > 4096) return res.writeHead(413).end();
      const m = { id: crypto.randomBytes(6).toString("hex"), time: Math.floor(Date.now() / 1000), event: "message", topic, message: body, query: url.search };
      messages.push(m);
      for (const s of subs) if (s.topics.includes(topic) && s.ws.readyState === 1) s.ws.send(JSON.stringify(m));
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(m));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url, "http://x");
    const m = /^\/([-_A-Za-z0-9,]+)\/ws$/.exec(url.pathname);
    if (!m) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      const topics = m[1].split(",");
      const sinceRaw = url.searchParams.get("since") || "";
      const since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : /^(\d+)m$/.test(sinceRaw) ? Math.floor(Date.now() / 1000) - Number(RegExp.$1) * 60 : Infinity;
      const s = { ws, topics };
      subs.add(s);
      ws.on("close", () => subs.delete(s));
      ws.send(JSON.stringify({ event: "open", topic: m[1], time: Math.floor(Date.now() / 1000) }));
      for (const x of messages) if (topics.includes(x.topic) && x.time >= since) ws.send(JSON.stringify(x));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    messages,
    files,
    account,
    subs,
    inject: (topic, message) => {
      const m = { id: crypto.randomBytes(6).toString("hex"), time: Math.floor(Date.now() / 1000), event: "message", topic, message };
      messages.push(m);
      for (const s of subs) if (s.topics.includes(topic) && s.ws.readyState === 1) s.ws.send(JSON.stringify(m));
    },
    close: () => new Promise((r) => { for (const s of subs) s.ws.terminate(); wss.close(); server.closeAllConnections?.(); server.close(r); }),
  };
}
