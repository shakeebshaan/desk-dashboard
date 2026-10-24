// Minimal Telegram Bot API client: outbound long-polling only (no webhook, no open port).
// The token is part of the URL path, so URLs are never logged.

export class Telegram {
  constructor({ token, base = "https://api.telegram.org", log = () => {} }) {
    this.token = token;
    this.base = base.replace(/\/$/, "");
    this.log = log;
    this.stopped = false;
    this.ac = new AbortController();
  }

  async call(method, params = {}, timeoutMs = 20000) {
    return this.post(method, { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }, timeoutMs);
  }

  // Multipart upload straight from memory (photos, clips, live frames): nothing is written to disk.
  // file: { field, bytes, name, mime }; object fields are sent as JSON (e.g. editMessageMedia's media).
  upload(method, fields, file, timeoutMs = 120000) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    fd.append(file.field, new Blob([file.bytes], { type: file.mime }), file.name);
    return this.post(method, { body: fd }, timeoutMs);
  }

  // kind: "photo" | "video" | "document". -> the sent message
  sendFile(chatId, kind, bytes, { name, mime, caption, extra = {} } = {}) {
    const method = { photo: "sendPhoto", video: "sendVideo", document: "sendDocument" }[kind];
    return this.upload(method, { chat_id: chatId, caption, ...extra }, { field: kind, bytes, name, mime });
  }

  // Replaces the picture of an earlier photo message (the live view is one message that updates).
  editPhoto(chatId, messageId, bytes, caption) {
    return this.upload("editMessageMedia", { chat_id: chatId, message_id: messageId, media: { type: "photo", media: "attach://frame", caption } },
      { field: "frame", bytes, name: "frame.jpg", mime: "image/jpeg" }, 30000);
  }

  // A file the owner sent to the bot (photo, audio), straight into memory. Bot API downloads: max 20 MB.
  async download(fileId, maxBytes = 20 * 1024 * 1024) {
    const f = await this.call("getFile", { file_id: fileId });
    if (!f.file_path || (f.file_size && f.file_size > maxBytes)) throw new Error("file too large");
    const res = await fetch(`${this.base}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.any([AbortSignal.timeout(60000), this.ac.signal]) });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("file too large");
    return bytes;
  }

  editCaption(chatId, messageId, caption) {
    return this.call("editMessageCaption", { chat_id: chatId, message_id: messageId, caption });
  }

  async post(method, init, timeoutMs) {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      ...init,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.ac.signal]),
    });
    const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!body.ok) {
      const err = new Error(`telegram ${method}: ${body.description || res.status}`);
      err.code = body.error_code || res.status;
      throw err;
    }
    return body.result;
  }

  // Long texts (the full /help) go out as several messages, split between lines; nothing is cut off.
  async send(chatId, text, extra = {}) {
    let last = null;
    for (const part of splitMessage(text)) last = await this.call("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true, ...extra });
    return last;
  }

  // Calls onUpdate for each update; getOffset/setOffset persist the position so a restart does not replay.
  async poll({ getOffset, setOffset, onUpdate, pollTimeout = 50 }) {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const updates = await this.call(
          "getUpdates",
          { offset: getOffset(), timeout: pollTimeout, allowed_updates: ["message"] },
          (pollTimeout + 15) * 1000,
        );
        backoff = 1000;
        for (const u of updates) {
          setOffset(u.update_id + 1);
          try {
            await onUpdate(u);
          } catch (e) {
            this.log(`update ${u.update_id} failed: ${e.message}`);
          }
        }
      } catch (e) {
        if (this.stopped) break;
        this.log(`poll: ${e.message} (retry in ${backoff / 1000}s)`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, e.code === 409 ? 60000 : 30000);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.ac.abort();
  }
}

// Pieces of at most `max` characters (Telegram allows 4096), cut at a blank line, else a line end, else hard.
export function splitMessage(text, max = 4000) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = win.lastIndexOf("\n\n");
    if (cut < max / 2) cut = win.lastIndexOf("\n");
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  out.push(rest);
  return out;
}
