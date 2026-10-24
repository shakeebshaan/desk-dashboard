// The hub's camera desk. Turns the owner's /snap, /clip, /live, /stop and /play (the bot serves only his Telegram id)
// into sealed commands for the phone, and the phone's encrypted uploads back into messages in his Telegram chat.
// Uploads arrive as relay attachments (ciphertext; the one-time key and hash come in the sealed {t:"blob"} frame).
// Everything stays in memory: nothing is written to disk, and each buffer is dropped once Telegram has the file.
// The phone enforces the same limits again (app/www/app/src/camera.js). Rules: docs/SECURITY.md.
import * as L from "../../app/www/app/src/securelink.js";
import { newId } from "./store.js";

export const LIMITS = { clipMaxSecs: 60, clipDefaultSecs: 15, liveMaxMin: 10, liveDefaultMin: 2, liveEvery: 4 };
const MAX_PARTS = 8;
const MAX_UPLOAD = 2.2 * 1024 * 1024;
const SNAP_WAIT = 75 * 1000;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export class CameraDesk {
  // tg: { send, sendFile, editPhoto, editCaption } (telegram.js). base: the relay URL; uploads must come from it.
  constructor({ relay, tg, ownerId, base, store, log = () => {}, fetchImpl = globalThis.fetch }) {
    Object.assign(this, { relay, tg, ownerId: String(ownerId), base: String(base || "").replace(/\/$/, ""), store, log, fetchImpl });
    this.jobs = new Map(); // id -> job
  }

  say(text) {
    return Promise.resolve(this.tg && this.tg.send(this.ownerId, text)).catch((e) => this.log(`camera: tell failed: ${e.message}`));
  }

  clock() {
    try {
      return new Date().toLocaleTimeString("en-GB", { timeZone: this.store.get().settings.tz });
    } catch {
      return new Date().toISOString().slice(11, 19);
    }
  }

  // The phone a camera command goes to: the /use target, else the one heard from most recently.
  phone() {
    if (!this.relay) return { err: "The camera and /play need the relay link." };
    const t = this.store && this.store.get().target;
    const fixed = t && t !== "all" ? this.relay.devices().find((d) => d.id === t) : null;
    if (fixed && !this.relay.online().includes(fixed.id)) return { err: `${fixed.name} (${fixed.id}) is offline. /use all lets any phone answer.` };
    const dev = fixed || this.relay.pickPhone();
    if (!dev) return { err: "No phone online. The dashboard phone must be on and connected (see /devices)." };
    const old = this.tooOld(dev);
    return old ? { err: old } : { dev };
  }

  // The phone says in its hello whether its app has the camera build; apps before 0.3.0 say nothing at all.
  tooOld(dev) {
    return dev.cam === false || (!dev.ui && dev.cam === undefined)
      ? "The phone's app is older than 0.3.1, which has no camera or video player. Install the latest APK (0.3.2) on the phone first."
      : null;
  }

  // /play and /stop: the /use target, or every online phone with the camera build.
  phones() {
    if (!this.relay) return { err: "The camera and /play need the relay link." };
    const t = this.store && this.store.get().target;
    if (t && t !== "all") { const r = this.phone(); return r.err ? r : { devs: [r.dev] }; }
    const on = new Set(this.relay.online());
    const all = this.relay.devices().filter((d) => on.has(d.id));
    if (!all.length) return { err: "No phone online. The dashboard phone must be on and connected (see /devices)." };
    const devs = all.filter((d) => !this.tooOld(d));
    return devs.length ? { devs } : { err: this.tooOld(all[0]) };
  }

  active(op) {
    return [...this.jobs.values()].find((j) => !op || j.op === op) || null;
  }

  // op: "snap" | "clip" | "live". -> the bot's reply
  async start(op, { facing = "front", secs = 0, audio = true } = {}) {
    const { dev, err } = this.phone();
    if (err) return err;
    const busy = this.active();
    if (busy) return `The camera is busy with /${busy.op}. Send /stop first.`;
    const id = newId("c");
    const job = { id, op, devId: dev.id, facing, secs, audio, parts: [], n: 0, at: Date.now() };
    if (op === "live") Object.assign(job, { msgId: null, frames: 0, latest: null, pumping: false });
    this.jobs.set(id, job);
    const sent = await this.relay.command(dev.id, { t: "cam", op, id, facing, secs, audio, ...(op === "live" ? { every: LIMITS.liveEvery } : {}) })
      .catch((e) => { this.log(`camera: command failed: ${e.message}`); return false; });
    if (!sent) {
      this.jobs.delete(id);
      return "Could not reach the phone: the relay refused the command or today's relay message budget is used up.";
    }
    const wait = op === "snap" ? SNAP_WAIT : op === "clip" ? (secs + 150) * 1000 : (secs + 90) * 1000;
    job.timer = setTimeout(() => this.timeout(job), wait);
    if (op === "snap") return `📷 Taking a photo with the ${facing} camera. It comes here in a few seconds.`;
    if (op === "clip") return `🎬 Recording ${secs} s with the ${facing} camera${audio ? " and the mic" : ", no sound"}. The clip comes here when it is done.`;
    return `🔴 Live view for ${mmss(secs)} with the ${facing} camera: one picture here that refreshes every ${LIMITS.liveEvery} s or more. /stop ends it.`;
  }

  async stop() {
    const { devs, err } = this.phones();
    const had = [...this.jobs.values()].map((j) => j.op);
    for (const j of this.jobs.values()) if (j.op === "live") this.endLive(j, "stopped");
    if (err) return had.length ? `Stopped here; ${err}` : err;
    let ok = false;
    for (const d of devs) ok = (await this.relay.command(d.id, { t: "stop" }).catch(() => false)) || ok;
    if (!ok) return "Could not reach the phone to stop it.";
    return had.includes("clip") ? "⏹ Stopping. The clip recorded so far comes here." : "⏹ Stopped: camera off and the dashboard is back on its widgets.";
  }

  async play(url) {
    const { devs, err } = this.phones();
    if (err) return err;
    let n = 0;
    for (const d of devs) if (await this.relay.command(d.id, { t: "play", url }).catch(() => false)) n++;
    return n ? `📺 Playing on ${n > 1 ? `${n} phones` : "the dashboard"}. /stop brings the widgets back.` : "Could not reach the phone.";
  }

  // Hub shutdown: forget every job (and its buffers).
  close() {
    for (const j of this.jobs.values()) clearTimeout(j.timer);
    this.jobs.clear();
  }

  timeout(job) {
    if (this.jobs.get(job.id) !== job) return;
    if (job.op === "live") return this.endLive(job, "time");
    this.jobs.delete(job.id);
    const what = job.op === "snap" ? "photo" : "clip";
    this.say(`📷 No ${what} from the phone in time. It may be offline or its screen off, or Android's camera permission question is waiting on the phone (tap Allow, then try again).`);
  }

  // Phone status: {t:"cam", id, state: "error"|"done", err} or {t:"media", state: "error", err}.
  onCam(devId, msg) {
    if (msg.t === "media") {
      if (msg.state === "error") this.say(`📺 /play: ${String(msg.err || "the phone could not play it").slice(0, 300)}`);
      return;
    }
    const job = this.jobs.get(msg.id);
    if (!job || job.devId !== devId) return;
    if (msg.state === "error") {
      clearTimeout(job.timer);
      this.jobs.delete(job.id);
      if (job.op === "live" && job.msgId) this.endLive(job, "error");
      this.say(`📷 /${job.op} failed on the phone: ${String(msg.err || "unknown error").slice(0, 300)}`);
    } else if (msg.state === "done" && job.op === "live") {
      this.endLive(job, "done");
    } else if (msg.state === "done" && msg.stopped) {
      clearTimeout(job.timer);
      this.jobs.delete(job.id);
    }
  }

  // An encrypted upload from the phone. meta: the sealed {t:"blob", id, kind, i, n, mime, key, sha, ...}.
  async onBlob(devId, meta, att) {
    const job = this.jobs.get(meta.id);
    const kindOk = job && { snap: "photo", clip: "clip", live: "frame" }[job.op] === meta.kind;
    if (!job || job.devId !== devId || !kindOk) return this.log(`camera: dropped an upload for no running job (${String(meta.kind).slice(0, 10)})`);
    if (!Number.isInteger(meta.n) || meta.n < 1 || meta.n > MAX_PARTS || !Number.isInteger(meta.i) || meta.i < 0 || meta.i >= meta.n) return;
    if (!att || typeof att.url !== "string" || !att.url.startsWith(`${this.base}/file/`)) return this.log("camera: upload without a relay attachment, dropped");
    const res = await this.fetchImpl(att.url);
    if (!res.ok) return this.log(`camera: download failed (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_UPLOAD) return this.log("camera: upload too large, dropped");
    const plain = L.openBlob(buf, meta.key, meta.sha);
    if (!plain) return this.log("camera: upload failed its hash or tag check, dropped");
    if (job.op === "live") return this.onFrame(job, plain, meta);
    if (job.n && job.n !== meta.n) return;
    job.n = meta.n;
    job.parts[meta.i] = plain;
    if (job.parts.filter(Boolean).length < job.n) return;
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    const bytes = concat(job.parts);
    job.parts = [];
    try {
      if (job.op === "snap") {
        await this.tg.sendFile(this.ownerId, "photo", bytes, { name: "snap.jpg", mime: "image/jpeg", caption: `📷 ${job.facing} camera · ${this.clock()}` });
      } else {
        const mp4 = /mp4/.test(String(meta.mime));
        const caption = `🎬 ${meta.secs || job.secs} s · ${job.facing} camera${meta.audio === false ? " · no sound" : ""} · ${this.clock()}`;
        await this.tg.sendFile(this.ownerId, mp4 ? "video" : "document", bytes,
          { name: mp4 ? "clip.mp4" : "clip.webm", mime: mp4 ? "video/mp4" : "video/webm", caption, extra: mp4 ? { supports_streaming: true } : {} });
      }
    } catch (e) {
      this.say(`📷 The ${job.op === "snap" ? "photo" : "clip"} reached the hub but Telegram refused it: ${e.message}`);
    }
  }

  // Live view: one Telegram photo that is replaced by each new frame; frames that arrive while an edit is still
  // going are skipped (only the newest is shown).
  onFrame(job, bytes, meta) {
    job.frames++;
    job.latest = { bytes, left: Number(meta.left) || 0, every: Number(meta.every) || LIMITS.liveEvery };
    this.pump(job);
  }

  async pump(job) {
    if (job.pumping) return;
    job.pumping = true;
    try {
      while (job.latest) {
        const f = job.latest;
        job.latest = null;
        const caption = `🔴 LIVE · ${job.facing} camera · ${this.clock()} · ${mmss(f.left)} left · new picture every ${f.every} s · /stop ends it`;
        try {
          if (!job.msgId) job.msgId = (await this.tg.sendFile(this.ownerId, "photo", f.bytes, { name: "live.jpg", mime: "image/jpeg", caption })).message_id;
          else await this.tg.editPhoto(this.ownerId, job.msgId, f.bytes, caption);
        } catch (e) {
          this.log(`camera: live frame not shown: ${e.message}`);
        }
      }
    } finally {
      job.pumping = false;
    }
  }

  endLive(job, why) {
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    const text = `⏹ Live view ended (${why === "stopped" ? "stopped" : why === "error" ? "camera error" : "time is up"}) · ${job.frames} picture${job.frames === 1 ? "" : "s"} · ${this.clock()}`;
    const finish = async () => {
      while (job.pumping) await new Promise((r) => setTimeout(r, 100));
      if (job.msgId) await this.tg.editCaption(this.ownerId, job.msgId, text).catch((e) => this.log(`camera: ${e.message}`));
      else if (why !== "error") await this.say(`${text}. No picture arrived: the phone may be offline or its screen off.`);
    };
    finish();
  }
}
