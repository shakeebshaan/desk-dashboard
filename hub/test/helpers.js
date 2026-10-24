// Test helpers: a fake Telegram Bot API (so no real bot, token or message is involved) and a tiny phone client.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

export const OWNER = "111111";
export const STRANGER = "999999";

export function fakeTelegram() {
  const updates = [];
  const sent = [];
  const files = []; // multipart uploads: { method, fields, file: { field, name, type, bytes } }
  const blobs = new Map(); // files the owner "sent" to the bot: file_id -> { bytes, path } (getFile + /file/bot<token>/<path>)
  let nextId = 1;
  let waiter = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const method = req.url.split("/").pop();
      if (req.method === "GET" && req.url.includes("/file/bot")) {
        const f = [...blobs.values()].find((b) => req.url.endsWith("/" + b.path));
        if (!f) return res.writeHead(404).end();
        return res.end(Buffer.from(f.bytes));
      }
      if (method === "getFile") {
        const f = blobs.get(JSON.parse(Buffer.concat(chunks).toString("utf8")).file_id);
        return res.end(JSON.stringify(f ? { ok: true, result: { file_path: f.path, file_size: f.bytes.length } } : { ok: false, description: "Bad Request: file not found" }));
      }
      if (/^multipart\/form-data/.test(req.headers["content-type"] || "")) {
        const fd = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: Buffer.concat(chunks) }).formData();
        const fields = {};
        let file = null;
        for (const [k, v] of fd) {
          if (typeof v === "string") fields[k] = v;
          else file = { field: k, name: v.name, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) };
        }
        files.push({ method, fields, file });
        return res.end(JSON.stringify({ ok: true, result: { message_id: 1000 + files.length } }));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const params = body ? JSON.parse(body) : {};
      const reply = (result) => res.end(JSON.stringify({ ok: true, result }));
      if (method === "getUpdates") {
        // Telegram semantics: an update stays until a later poll confirms it with offset > update_id,
        // so a poll that dies with a stopping hub loses nothing. Hold the poll up to 200 ms when empty.
        const offset = params.offset || 0;
        for (let i = updates.length - 1; i >= 0; i--) if (updates[i].update_id < offset) updates.splice(i, 1);
        if (process.env.FAKE_TG_DEBUG) console.log("poll", offset, updates.map((u) => u.update_id));
        const take = () => {
          if (waiter !== me) return;
          clearTimeout(t);
          waiter = null;
          reply(updates.filter((u) => u.update_id >= offset));
        };
        const me = take;
        waiter = me;
        const t = setTimeout(() => { if (waiter === me) { waiter = null; reply([]); } }, 200);
        if (updates.length) take();
        return;
      }
      if (method === "sendMessage") { sent.push(params); return reply({ message_id: sent.length }); }
      if (method === "editMessageCaption") { files.push({ method, fields: params, file: null }); return reply(true); }
      reply(true);
    });
  });
  return {
    sent,
    files,
    blobs,
    async start() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    // a message with anything in it (photo, audio, caption): pushRaw(OWNER, { photo: [...] })
    pushRaw(fromId, fields) {
      updates.push({ update_id: nextId++, message: { message_id: nextId, from: { id: +fromId, is_bot: false, first_name: "x" },
        chat: { id: +fromId, type: "private" }, date: Math.floor(Date.now() / 1000), ...fields } });
      if (waiter) waiter();
    },
    push(fromId, text, { chatId = fromId, chatType = "private" } = {}) {
      updates.push({ update_id: nextId++, message: { message_id: nextId, from: { id: +fromId, is_bot: false, first_name: "x" },
        chat: { id: +chatId, type: chatType }, date: Math.floor(Date.now() / 1000), text } });
      if (waiter) waiter();
    },
    // Wait until n messages were sent in total; returns the last one's text.
    async waitSent(n, ms = 4000) {
      const t0 = Date.now();
      while (sent.length < n) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for sendMessage #${n} (have ${sent.length})`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return sent[n - 1].text;
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dash-test-"));
}

export function testConfig(extra = {}) {
  return {
    botToken: "TEST", ownerId: OWNER, telegramApi: "", telegramEnabled: true, host: "127.0.0.1", port: 0,
    serveApp: false, dataDir: tmpDir(), captureDir: tmpDir(), weatherEnabled: false,
    agent: { enabled: true, keyFile: path.join(tmpDir(), "missing.key"), model: "claude-haiku-5-5", capUsd: 10, warnUsd: 8 }, ...extra,
  };
}

// Minimal phone: connects, says hello, collects messages.
export function phone(url, token, { origin = "http://localhost" } = {}) {
  const msgs = [];
  const ws = new WebSocket(url, { origin });
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  const opened = new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  return {
    ws, msgs, closed,
    async hello() { await opened; ws.send(JSON.stringify({ type: "hello", token })); },
    async waitFor(pred, ms = 4000) {
      const t0 = Date.now();
      for (;;) {
        const m = msgs.find(pred);
        if (m) return m;
        if (Date.now() - t0 > ms) throw new Error("timeout waiting for phone message");
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close() { ws.close(); },
  };
}

export async function pairDevice(base, code, origin = "http://localhost") {
  const r = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code, name: "test-phone" }) });
  return { status: r.status, body: await r.json() };
}
