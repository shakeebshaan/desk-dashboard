// Photo-frame pictures and the adhan recording live on the hub only. The phone asks for the ones it does not have
// ({t:"get"}), gets each one encrypted as relay attachments ({t:"file"} frames, relaylink.js), and keeps it in MEMORY
// only (a blob: URL): nothing is written to the phone's storage, so after a restart it asks again.
import { openBlob } from "./securelink.js";

const ASK_GAP = 10 * 60 * 1000; // the hub also refuses to resend a file within 10 min
const MAX_KEEP = 30;

export class FileCache {
  constructor({ post, fetchImpl = (...a) => fetch(...a), onReady = () => {} }) {
    Object.assign(this, { post, fetchImpl, onReady });
    this.urls = new Map(); // id -> blob: URL
    this.parts = new Map(); // id -> { n, got: [] }
    this.asked = new Map(); // id -> time
  }

  url(id) { return this.urls.get(id) || null; }

  // ids the state refers to; asks the hub for the missing ones (a few at a time) and frees the ones no longer used.
  want(ids) {
    const keep = new Set(ids);
    for (const [id, u] of this.urls) if (!keep.has(id)) { URL.revokeObjectURL(u); this.urls.delete(id); }
    const now = Date.now();
    const missing = ids.filter((id) => !this.urls.has(id) && now - (this.asked.get(id) || 0) > ASK_GAP).slice(0, 6);
    if (!missing.length || !this.post) return;
    missing.forEach((id) => this.asked.set(id, now));
    this.post({ t: "get", ids: missing });
  }

  // A {t:"file"} part from the hub, with its relay attachment URL.
  async add(m) {
    if (!m.url || !Number.isInteger(m.n) || m.n < 1 || m.n > 8 || !Number.isInteger(m.i) || m.i < 0 || m.i >= m.n) return;
    const r = await this.fetchImpl(m.url);
    if (!r.ok) return;
    const plain = openBlob(new Uint8Array(await r.arrayBuffer()), m.key, m.sha);
    if (!plain) return; // swapped or damaged on the relay
    const e = this.parts.get(m.id) || { n: m.n, got: [] };
    e.got[m.i] = plain;
    this.parts.set(m.id, e);
    if (e.got.filter(Boolean).length < e.n) return;
    this.parts.delete(m.id);
    if (this.urls.size >= MAX_KEEP) return;
    this.urls.set(m.id, URL.createObjectURL(new Blob(e.got, { type: m.mime || "application/octet-stream" })));
    this.onReady(m.id, m.kind);
  }
}
