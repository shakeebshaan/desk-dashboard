// The phone's own checks, on the hub side.
//  - Errors: the phone sends every error it catches ({t:"err"}, app diag.js); each entry becomes one line in
//    data/phone-errors.log with the card, UI version and WebView. /errors shows the latest.
//  - Self-test: /selftest sends {t:"selftest"} to the phone; it shows every card for 3 s and answers with one row per
//    card ({t:"selftest", rows}) plus a contact sheet of what it drew (an encrypted upload, kind "selftest"). The bot
//    sends the owner one short table, with the sheet when it comes. The phone also runs it by itself after a new UI
//    version (always reported) and every 3 hours while cards are left out (reported only when the result changes).
//    Every result is kept in data/selftest.jsonl.
import fs from "node:fs";
import path from "node:path";
import * as L from "../../app/www/app/src/securelink.js";
import { newId } from "./store.js";

export const CAPTURE_DIR = "C:/tmp/desk-dashboard/phone-captures";
const SHEET_WAIT = 90 * 1000; // the table goes out alone if the picture has not come by then
const MAX_SHEET = 2.2 * 1024 * 1024;
const str = (x, n) => (typeof x === "string" ? x.replace(/[^\x20-\x7E]/g, "").slice(0, n) : "");
const num = (x, lo, hi) => (typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x) : null);

export function cleanRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 40).map((r) => ({
    card: str(r && r.card, 20), ok: !!(r && r.ok === true), empty: !!(r && r.empty === true), blank: !!(r && r.blank), errors: num(r && r.errors, 0, 1e4) || 0,
    err: str(r && r.err, 120), paint: num(r && r.paint, 0, 600000), fps: num(r && r.fps, 0, 240), long: num(r && r.long, 0, 1e4), worst: num(r && r.worst, 0, 600000),
  })).filter((r) => r.card);
}

// One short table: a line per card, failures first with what went wrong.
export function tableText(name, m, rows) {
  const pass = rows.filter((r) => r.ok).length;
  const why = { manual: "", "after-push": " (after the UI update)", retest: " (re-test of the cards left out)" }[m.why] || "";
  const head = `🧪 Self-test on ${name}${why}, UI v${m.ui ?? "?"}: ${pass}/${rows.length} cards OK${pass === rows.length ? " ✅" : ""}`;
  const line = (r) => {
    const bad = [r.blank ? "blank" : "", r.errors ? `${r.errors} error${r.errors > 1 ? "s" : ""}` : "", r.fps != null && r.fps < 40 ? "slow" : ""].filter(Boolean).join(", ");
    return `${r.ok ? "✅" : "❌"} ${r.card.padEnd(9)} ${String(r.fps ?? "-").padStart(2)} fps · ${r.paint ?? "-"} ms${bad ? ` · ${bad}` : ""}${r.empty ? " · empty, not shown" : ""}${r.err ? `\n    ${r.err}` : ""}`;
  };
  const sorted = [...rows.filter((r) => !r.ok), ...rows.filter((r) => r.ok)];
  const tail = pass < rows.length ? "Cards marked ❌ are left out of the cycle until a test passes them." : "";
  const extra = [m.low ? "The phone is in low-power mode." : "", m.shotErr ? `No pictures: ${m.shotErr}` : ""].filter(Boolean).join(" ");
  return [head, ...sorted.map(line), tail, extra].filter(Boolean).join("\n");
}

export class SelfTestDesk {
  // relay: Relay; tg: { send, sendFile } or null; dataDir: where the logs go
  constructor({ relay, tg, ownerId, base, store, dataDir, captureDir = CAPTURE_DIR, log = () => {}, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { relay, tg, ownerId: String(ownerId || ""), base: String(base || "").replace(/\/$/, ""), store, dataDir, captureDir, log, fetchImpl });
    this.uiOf = new Map(); // test id -> UI version (from its rows), for the capture folder
    this.packs = new Map(); // test id -> { n, parts, at }
    this.pending = new Map(); // test id -> { devId, rows?, msg?, sheet?, timer }
  }

  say(text) {
    return this.tg ? Promise.resolve(this.tg.send(this.ownerId, text)).catch((e) => this.log(`selftest: tell failed: ${e.message}`)) : Promise.resolve();
  }

  devName(devId) {
    const d = this.store.get().devices.find((x) => x.id === devId);
    return d ? `${d.name} (${d.id})` : devId;
  }

  // /selftest -> the bot's reply
  async start() {
    const on = new Set(this.relay.online());
    const t = this.store.get().target;
    const devs = this.relay.devices().filter((d) => on.has(d.id) && (!t || t === "all" || d.id === t));
    if (!devs.length) return "No phone online for the self-test (see /devices).";
    let sent = 0;
    for (const d of devs) {
      const ok = await this.relay.command(d.id, { t: "selftest", id: newId("t") }).catch((e) => { this.log(`selftest: ${e.message}`); return false; });
      if (ok) sent++;
    }
    if (!sent) return "Could not reach the phone: the relay refused the command or today's relay budget is used up.";
    return `🧪 Self-test started on ${devs.map((d) => d.name).join(", ")}: every card for 3 s, about a minute. The table and a picture of each card come here.`;
  }

  // {t:"err"} from the phone: one log line per entry
  onErr(devId, m) {
    const ui = num(m.ui, 0, 1e9), wv = str(m.webview, 24);
    const lines = (Array.isArray(m.list) ? m.list : []).slice(0, 10).map((e) => {
      const at = new Date(num(e && e.last, 0, 1e14) || Date.now()).toISOString();
      return `${at} ${devId} ui=v${ui ?? "?"} webview=${wv || "?"} card=${str(e && e.card, 20) || "-"} kind=${str(e && e.kind, 10) || "?"} n=${num(e && e.n, 0, 1e7) ?? 1} ${str(e && e.msg, 300)}`;
    });
    if (!lines.length) return;
    this.log(`phone errors ${devId}: ${lines.length} new`);
    return fs.promises.appendFile(path.join(this.dataDir, "phone-errors.log"), lines.join("\n") + "\n").catch(() => {});
  }

  // /errors: the latest lines of the log
  latest(n = 12) {
    let text = "";
    try { text = fs.readFileSync(path.join(this.dataDir, "phone-errors.log"), "utf8"); } catch { /* none yet */ }
    const lines = text.trim().split("\n").filter(Boolean);
    if (!lines.length) return "No errors from the phones so far.";
    return [`Phone errors (latest ${Math.min(n, lines.length)} of ${lines.length}):`,
      ...lines.slice(-n).map((l) => l.replace(/^(\S{16})\S*/, "$1").replace(/ webview=\S+/, ""))].join("\n");
  }

  entry(id, devId) {
    let p = this.pending.get(id);
    if (!p) {
      p = { devId };
      p.timer = setTimeout(() => this.finish(id), SHEET_WAIT);
      this.pending.set(id, p);
    }
    return p;
  }

  // {t:"selftest", id, why, rows, ...} or {t:"selftest", id, busy}
  onSelfTest(devId, m) {
    const id = str(m.id, 40);
    if (!id) return;
    if (m.busy) return this.say(`🧪 Self-test on ${this.devName(devId)}: ${str(m.busy, 200)}.`);
    const rows = cleanRows(m.rows);
    const why = ["manual", "after-push", "retest"].includes(m.why) ? m.why : "manual";
    const meta = { why, ui: num(m.ui, 0, 1e9), low: m.low === true, shots: num(m.shots, 0, 100) || 0, shotErr: str(m.shotErr, 120), webview: str(m.webview, 24), gpu: str(m.gpu, 80), w: num(m.w, 0, 1e4), h: num(m.h, 0, 1e4) };
    const rec = { dev: devId, id, at: Date.now(), ...meta, rows };
    this.uiOf.set(id, meta.ui);
    if (this.uiOf.size > 20) this.uiOf.delete(this.uiOf.keys().next().value);
    fs.promises.appendFile(path.join(this.dataDir, "selftest.jsonl"), JSON.stringify(rec) + "\n").catch(() => {});
    const failing = rows.filter((r) => !r.ok).map((r) => r.card).sort().join(",");
    const prev = (this.store.get().devices.find((d) => d.id === devId) || {}).selftest;
    this.store.update((s) => { const d = s.devices.find((x) => x.id === devId); if (d) d.selftest = { at: rec.at, ui: meta.ui, pass: rows.length - (failing ? failing.split(",").length : 0), of: rows.length, failing }; }, { silent: true });
    this.log(`selftest ${devId} (${why}, UI v${meta.ui}): ${rows.filter((r) => r.ok).length}/${rows.length} OK${failing ? `; failing ${failing}` : ""}`);
    const p = this.entry(id, devId);
    // a re-test is told only when the result changed
    p.quiet = why === "retest" && prev && prev.failing === failing;
    p.text = tableText(this.devName(devId), meta, rows);
    p.expectSheet = meta.shots > 0;
    if (!p.expectSheet || p.sheet) return this.finish(id);
  }

  // the contact sheet: an encrypted upload like a camera photo
  async onBlob(devId, meta, att) {
    const id = str(meta.id, 40);
    if (!id || !["selftest", "captures"].includes(meta.kind)) return;
    if (!att || typeof att.url !== "string" || !att.url.startsWith(`${this.base}/file/`)) return this.log("selftest: picture without a relay attachment, dropped");
    const res = await this.fetchImpl(att.url);
    if (!res.ok) return this.log(`selftest: picture download failed (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_SHEET) return this.log("selftest: picture too large, dropped");
    const plain = L.openBlob(buf, meta.key, meta.sha);
    if (!plain) return this.log("selftest: picture failed its hash or tag check, dropped");
    if (meta.kind === "captures") return this.onCaptures(devId, id, meta, plain);
    const p = this.entry(id, devId);
    if (p.devId !== devId) return;
    p.sheet = plain;
    try { fs.writeFileSync(path.join(this.dataDir, "selftest-last.jpg"), plain); } catch { /* the log copy is optional */ }
    if (p.text) return this.finish(id);
  }

  // Every card's PNG, packed (app selftest.js packFiles) and sent in parts: written as
  // <captureDir>/v<ui>/<card>-<portrait|landscape>.png for side-by-side checks against the browser.
  onCaptures(devId, id, meta, plain) {
    if (!Number.isInteger(meta.n) || meta.n < 1 || meta.n > 6 || !Number.isInteger(meta.i) || meta.i < 0 || meta.i >= meta.n) return;
    const k = `${devId}:${id}`;
    const pk = this.packs.get(k) || { n: meta.n, parts: [], at: Date.now() };
    if (pk.n !== meta.n) return;
    pk.parts[meta.i] = plain;
    this.packs.set(k, pk);
    for (const [kk, v] of this.packs) if (Date.now() - v.at > 10 * 60000) this.packs.delete(kk);
    if (pk.parts.filter(Boolean).length < pk.n) return;
    this.packs.delete(k);
    const files = unpack(Buffer.concat(pk.parts.map((x) => Buffer.from(x))));
    if (!files) return this.log("selftest: card pictures did not unpack, dropped");
    const ui = this.uiOf.get(id);
    const orient = meta.orient === "landscape" ? "landscape" : "portrait";
    const dir = path.join(this.captureDir, `v${ui ?? "unknown"}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, `${f.name}-${orient}.png`), f.bytes);
      this.log(`selftest ${devId}: ${files.length} card pictures (${orient}) in ${dir}`);
    } catch (e) {
      this.log(`selftest: card pictures not written: ${e.message}`);
    }
    return files.length;
  }

  async finish(id) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (!p.text) return this.log(`selftest: a picture came for ${id} but no table`);
    if (p.quiet || !this.tg) return;
    const short = p.text.length <= 1000;
    try {
      if (p.sheet) {
        await this.tg.sendFile(this.ownerId, "photo", p.sheet, { name: "selftest.jpg", mime: "image/jpeg", caption: short ? p.text : p.text.split("\n")[0] });
        if (!short) await this.say(p.text);
      } else {
        await this.say(p.expectSheet ? `${p.text}\n(The picture did not arrive.)` : p.text);
      }
    } catch (e) {
      this.log(`selftest: send failed: ${e.message}`);
      await this.say(p.text);
    }
  }

  close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}

// -> [{ name, bytes }] from packFiles' format, or null; names are card types (letters and digits only), files PNG
export function unpack(buf) {
  try {
    const hl = buf.readUInt32BE(0);
    if (hl > 8192 || 4 + hl > buf.length) return null;
    const head = JSON.parse(buf.subarray(4, 4 + hl).toString("utf8"));
    const out = [];
    let o = 4 + hl;
    for (const f of (head.files || []).slice(0, 40)) {
      if (!/^[a-z0-9]{1,20}$/.test(f.name) || !Number.isInteger(f.len) || f.len < 8 || o + f.len > buf.length) return null;
      const bytes = buf.subarray(o, o + f.len);
      o += f.len;
      if (bytes.readUInt32BE(0) !== 0x89504e47) return null; // PNG only
      out.push({ name: f.name, bytes });
    }
    return out;
  } catch {
    return null;
  }
}
