// End-to-end crypto for the phone <-> hub link, shared by the app and the hub (same file, no copy).
// Only TweetNaCl primitives (audited, Cure53 2017): X25519 (nacl.box.before), XSalsa20-Poly1305 (nacl.secretbox),
// SHA-512 (nacl.hash), CSPRNG (nacl.randomBytes). Nothing here invents a primitive; this file only frames messages.
//
// Frame on the relay:  "d1." + base64url( nonce[24] || secretbox )
//   nonce = 16 random bytes || 8-byte big-endian counter. Each direction has its own key and its own counter;
//   the receiver keeps the highest counter it accepted and rejects anything not above it (replay + reordering).
//   The counter sits in the nonce, so changing it breaks the Poly1305 tag.

let nacl = globalThis.nacl;
export const useNacl = (n) => { nacl = n; };

const te = new TextEncoder();
const td = new TextDecoder();
export const utf8 = (s) => te.encode(s);

export function b64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("bad base64url");
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const hash32 = (label, ...parts) => nacl.hash(concat(utf8(label), ...parts)).subarray(0, 32);

export const newKeyPair = () => nacl.box.keyPair();
export const keyPairFromSecret = (sk) => nacl.box.keyPair.fromSecretKey(sk);
export const randomTopic = () => "d" + b64u(nacl.randomBytes(32)); // 44 chars, ntfy allows [-_A-Za-z0-9]{1,64}

// One shared secret per (hub, phone) pair, split into one key per direction.
export function sessionKeys(mySecret, theirPublic) {
  const shared = nacl.box.before(theirPublic, mySecret);
  return { h2p: hash32("desk-dashboard/h2p/v1", shared), p2h: hash32("desk-dashboard/p2h/v1", shared) };
}

// Same on both sides; shown on the phone and sent by the bot so the owner can compare. 80 bits as 5 groups of 4 hex.
export function fingerprint(hubPublic, phonePublic) {
  const h = nacl.hash(concat(utf8("desk-dashboard/fp/v1"), hubPublic, phonePublic));
  return [...h.subarray(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{4}/g).join(" ");
}

const MAX_COUNTER = 2 ** 53 - 1;

export function seal(key, counter, obj) {
  if (!Number.isSafeInteger(counter) || counter < 1 || counter > MAX_COUNTER) throw new Error("bad counter");
  const nonce = new Uint8Array(24);
  nonce.set(nacl.randomBytes(16), 0);
  new DataView(nonce.buffer).setBigUint64(16, BigInt(counter));
  return "d1." + b64u(concat(nonce, nacl.secretbox(utf8(JSON.stringify(obj)), nonce, key)));
}

// -> { ok: true, counter, msg } or { ok: false, why: "format" | "replay" | "auth" }
export function open(key, frame, lastCounter) {
  if (typeof frame !== "string" || !frame.startsWith("d1.") || frame.length > 8000) return { ok: false, why: "format" };
  let raw;
  try { raw = unb64u(frame.slice(3)); } catch { return { ok: false, why: "format" }; }
  if (raw.length < 24 + nacl.secretbox.overheadLength) return { ok: false, why: "format" };
  const nonce = raw.subarray(0, 24);
  const counter = Number(new DataView(raw.buffer, raw.byteOffset + 16, 8).getBigUint64(0));
  if (!(counter > (lastCounter || 0))) return { ok: false, why: "replay" };
  const pt = nacl.secretbox.open(raw.subarray(24), nonce, key);
  if (!pt) return { ok: false, why: "auth" };
  let msg;
  try { msg = JSON.parse(td.decode(pt)); } catch { return { ok: false, why: "format" }; }
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return { ok: false, why: "format" };
  return { ok: true, counter, msg };
}

// ---------- pairing ----------
// The bot's /pair code: 16 Crockford base32 characters = 80 bits, typed once on the phone. The relay sees only the
// derived topic and ciphertext; with 80 bits an offline guess of the code from that is out of reach, the code is
// one-time with a 10-minute TTL, and both sides show the same fingerprint afterwards.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newPairCode() {
  const r = nacl.randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += B32[r[i] & 31];
  return s.match(/.{4}/g).join("-");
}

export function normPairCode(input) {
  const s = String(input || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(s) ? s : null;
}

export function pairChannel(code) {
  const c = normPairCode(code);
  if (!c) throw new Error("bad pairing code");
  const h = nacl.hash(utf8("desk-dashboard/pair/v1|" + c));
  return { topic: "p" + b64u(h.subarray(0, 24)), key: h.slice(32, 64) };
}

// Pairing frames use random nonces (the pair key protects at most a handful of messages, once).
export function sealPair(key, obj) {
  const nonce = nacl.randomBytes(24);
  return "p1." + b64u(concat(nonce, nacl.secretbox(utf8(JSON.stringify(obj)), nonce, key)));
}

export function openPair(key, frame) {
  if (typeof frame !== "string" || !frame.startsWith("p1.") || frame.length > 4000) return null;
  try {
    const raw = unb64u(frame.slice(3));
    const pt = raw.length > 24 && nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), key);
    return pt ? JSON.parse(td.decode(pt)) : null;
  } catch {
    return null;
  }
}

// ---------- chunking (ntfy.sh keeps message bodies under 4096 bytes) ----------
export const MAX_FRAME = 3800;

// Splits one logical message into frames; `sealOne(obj)` seals with the next counter.
// Frame length for a plaintext of n bytes: "d1." + base64url(24 + 16 + n).
const frameLen = (obj) => 3 + Math.ceil(((40 + utf8(JSON.stringify(obj)).length) * 4) / 3);

export function sealChunks(sealOne, obj, mid) {
  // sizes are worked out before sealing, so no counter is spent on a frame that is thrown away
  if (frameLen(obj) <= MAX_FRAME) return [sealOne(obj)];
  const s = JSON.stringify(obj);
  for (let size = 1400; size >= 100; size = Math.floor(size / 2)) {
    const parts = [];
    for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
    if (parts.length > 64) throw new Error("message too large for the relay");
    if (parts.every((d, i) => frameLen({ t: "part", m: mid, i, n: parts.length, d }) <= MAX_FRAME)) {
      return parts.map((d, i) => sealOne({ t: "part", m: mid, i, n: parts.length, d }));
    }
  }
  throw new Error("message too large for the relay");
}

// Reassembles parts; returns the full message when the last part arrives.
export class Reassembler {
  constructor() { this.buf = new Map(); }
  add(p) {
    if (typeof p.m !== "string" || !Number.isInteger(p.n) || p.n < 1 || p.n > 64 || !Number.isInteger(p.i) || p.i < 0 || p.i >= p.n || typeof p.d !== "string") return null;
    const now = Date.now();
    for (const [k, v] of this.buf) if (now - v.at > 10 * 60 * 1000) this.buf.delete(k);
    if (!this.buf.has(p.m) && this.buf.size >= 8) return null;
    const e = this.buf.get(p.m) || { at: now, n: p.n, parts: new Array(p.n) };
    if (e.n !== p.n) return null;
    e.parts[p.i] = p.d;
    this.buf.set(p.m, e);
    if (e.parts.filter((x) => x !== undefined).length < e.n) return null;
    this.buf.delete(p.m);
    try {
      const m = JSON.parse(e.parts.join(""));
      return m && typeof m.t === "string" && m.t !== "part" ? m : null;
    } catch {
      return null;
    }
  }
}

// ---------- blobs (photos, clips, live frames): too big for a frame, so they travel as relay attachments ----------
// Each blob gets a fresh random key; the upload is nonce[24] || secretbox. The key and a SHA-512/256 of the upload go
// to the hub inside the sealed {t:"blob"} frame that rides along as the attachment's message (one relay message per
// blob), so the relay sees only ciphertext and the hub can tell a swapped file.
export const MAX_BLOB_PART = 1900 * 1024; // ntfy.sh anonymous attachments: 2 MB per file (checked 2026-10-24)

export const blobHash = (bytes) => b64u(nacl.hash(bytes).subarray(0, 32));

export function sealBlob(bytes) {
  const key = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(24);
  const upload = concat(nonce, nacl.secretbox(bytes, nonce, key));
  return { upload, key: b64u(key), sha: blobHash(upload) };
}

// -> the plain bytes, or null if the hash or the tag does not match
export function openBlob(upload, key, sha) {
  try {
    if (!(upload instanceof Uint8Array) || upload.length < 24 + nacl.secretbox.overheadLength || blobHash(upload) !== sha) return null;
    const k = unb64u(key);
    if (k.length !== 32) return null;
    return nacl.secretbox.open(upload.subarray(24), upload.subarray(0, 24), k) || null;
  } catch {
    return null;
  }
}
