// Camera, only on a command from the owner's bot (/snap, /clip, /live; the hub serves only his Telegram id) and only while
// the red REC indicator is on screen. Nothing is written to the phone: frames and clips live in memory until they are
// encrypted and handed to the relay, then dropped. Hard limits are enforced here too, whatever the hub asks for.
// No motion trigger, no face detection, no cloud vision. Rules: docs/SECURITY.md.
import { MAX_BLOB_PART } from "./securelink.js";

export const LIMITS = {
  clipMaxSecs: 60, clipDefaultSecs: 15,
  liveMaxSecs: 10 * 60, liveDefaultSecs: 2 * 60,
  liveMinEvery: 3, liveDefaultEvery: 4, // seconds between live frames (one relay message each)
  budgetReserve: 60, // relay messages left untouched for heartbeats and answers
  clipMaxBytes: 12 * 1024 * 1024, // ntfy.sh keeps 20 MB per IP at a time
};
const VIDEO_BPS = 1_000_000; // 60 s -> about 8 MB
const AUDIO_BPS = 64_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function cameraError(e) {
  const n = e && e.name;
  if (n === "NotAllowedError" || n === "SecurityError") return "camera permission is off on the phone (allow Camera, and Microphone for clips, for Dashboard in Android settings), or the app is older than 0.3.1";
  if (n === "NotFoundError" || n === "OverconstrainedError") return "no camera found on the phone";
  if (n === "NotReadableError" || n === "AbortError") return "the camera is busy (another app is using it)";
  return String((e && e.message) || e).slice(0, 200);
}

// The REC indicator: a red dot, what is on (camera / mic), a timer and a small live preview of exactly what the camera
// sees. It is shown before the camera is asked for and hidden only after every track has stopped.
export class RecIndicator {
  constructor(root = document) {
    this.el = root.getElementById("rec");
    this.label = root.getElementById("rec-label");
    this.time = root.getElementById("rec-time");
    this.preview = root.getElementById("rec-preview");
    this.timer = null;
  }

  on(label, { secs = 0 } = {}) {
    const t0 = Date.now();
    this.label.textContent = label;
    this.el.classList.remove("hidden");
    document.body.classList.add("cam-on");
    const draw = () => {
      const el = (Date.now() - t0) / 1000;
      this.time.textContent = secs ? `${mmss(Math.max(0, secs - el))} left` : mmss(el);
    };
    draw();
    clearInterval(this.timer);
    this.timer = setInterval(draw, 500);
  }

  attach(stream) {
    this.preview.srcObject = stream;
    return this.preview.play().catch(() => {});
  }

  off() {
    clearInterval(this.timer);
    this.preview.srcObject = null;
    this.el.classList.add("hidden");
    document.body.classList.remove("cam-on");
  }

  get visible() { return !this.el.classList.contains("hidden"); }
}

export class Camera {
  // link: RelayLink (upload, post, budget). media: navigator.mediaDevices (tests may pass another).
  constructor({ link, rec, media = navigator.mediaDevices, log = () => {} }) {
    Object.assign(this, { link, rec, media, log });
    this.job = null; // { id, op, stop() }
  }

  get busy() { return !!this.job; }

  async run(cmd) {
    if (this.job) return this.report(cmd.id, "error", `the camera is busy with ${this.job.op}; send /stop first`);
    if (!this.media || !this.media.getUserMedia) return this.report(cmd.id, "error", "this app has no camera access (needs app 0.3.1)");
    const job = { id: cmd.id, op: cmd.op, stopped: false, stream: null, onStop: null };
    job.stop = () => { job.stopped = true; if (job.onStop) job.onStop(); };
    this.job = job;
    try {
      if (cmd.op === "snap") await this.snap(job, cmd);
      else if (cmd.op === "clip") await this.clip(job, cmd);
      else if (cmd.op === "live") await this.live(job, cmd);
    } catch (e) {
      this.log(`camera ${cmd.op}: ${e && e.message}`);
      if (e && e.name === "Stopped") await this.report(cmd.id, "done", "", { stopped: true });
      else await this.report(cmd.id, "error", cameraError(e));
    } finally {
      this.release(job);
      if (this.job === job) this.job = null;
    }
  }

  stop() {
    if (this.job) this.job.stop();
  }

  release(job) {
    if (job.stream) for (const t of job.stream.getTracks()) t.stop();
    job.stream = null;
    this.rec.off();
  }

  report(id, state, err = "", extra = {}) {
    return this.link.post({ t: "cam", id, state, ...(err ? { err: String(err).slice(0, 300) } : {}), ...extra });
  }

  async open(job, cmd, { width, height, audio }) {
    const video = { facingMode: { ideal: cmd.facing === "back" ? "environment" : "user" }, width: { ideal: width }, height: { ideal: height } };
    job.stream = await this.media.getUserMedia({ video, audio: !!audio });
    if (job.stopped) throw Object.assign(new Error("stopped"), { name: "Stopped" });
    await this.rec.attach(job.stream);
    return job.stream;
  }

  // Sends bytes as one or more encrypted relay attachments (2 MB per file on ntfy.sh).
  async send(id, kind, mime, bytes, extra = {}) {
    const n = Math.max(1, Math.ceil(bytes.length / MAX_BLOB_PART));
    for (let i = 0; i < n; i++) {
      await this.link.upload({ id, kind, mime, i, n, ...extra }, bytes.subarray(i * MAX_BLOB_PART, (i + 1) * MAX_BLOB_PART));
    }
  }

  // One JPEG from the live video, at most maxEdge pixels on the long side.
  async grab(maxEdge, quality, src = this.rec.preview) {
    const w0 = src.videoWidth || src.width, h0 = src.videoHeight || src.height;
    if (!w0 || !h0) throw new Error("the camera gave no picture");
    const k = Math.min(1, maxEdge / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * k);
    c.height = Math.round(h0 * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    if (!blob) throw new Error("could not encode the picture");
    return new Uint8Array(await blob.arrayBuffer());
  }

  async snap(job, cmd) {
    this.rec.on("REC · CAMERA");
    const stream = await this.open(job, cmd, { width: 1920, height: 1080 });
    await sleep(900); // auto exposure and focus settle
    let bytes = null;
    // Full-quality still where the WebView has ImageCapture, else a frame of the video.
    try {
      if (typeof ImageCapture === "function") {
        const bmp = await createImageBitmap(await new ImageCapture(stream.getVideoTracks()[0]).takePhoto());
        bytes = await this.grab(1920, 0.85, bmp);
        bmp.close();
      }
    } catch {}
    if (!bytes) bytes = await this.grab(1920, 0.85);
    this.release(job); // camera off before the upload
    await this.send(job.id, "photo", "image/jpeg", bytes, { facing: cmd.facing });
  }

  async clip(job, cmd) {
    const secs = Math.min(LIMITS.clipMaxSecs, Math.max(1, Math.round(cmd.secs || LIMITS.clipDefaultSecs)));
    const audio = cmd.audio !== false;
    this.rec.on(audio ? "REC · CAMERA + MIC" : "REC · CAMERA", { secs });
    const stream = await this.open(job, cmd, { width: 1280, height: 720, audio });
    const types = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS });
    const chunks = [];
    let size = 0;
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      chunks.push(e.data);
      size += e.data.size;
      if (size > LIMITS.clipMaxBytes && rec.state === "recording") rec.stop(); // size cap: send what fits
    };
    const done = new Promise((r) => { rec.onstop = r; });
    const t0 = Date.now();
    rec.start(1000);
    const timer = setTimeout(() => rec.state === "recording" && rec.stop(), secs * 1000);
    job.onStop = () => rec.state === "recording" && rec.stop(); // /stop: keep what was recorded
    await done;
    clearTimeout(timer);
    const took = Math.round((Date.now() - t0) / 1000);
    this.release(job);
    const blob = new Blob(chunks, { type: (rec.mimeType || mimeType || "video/webm").split(";")[0] });
    chunks.length = 0;
    if (!blob.size) throw new Error("the recording is empty");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await this.send(job.id, "clip", blob.type, bytes.subarray(0, LIMITS.clipMaxBytes), { facing: cmd.facing, secs: took, audio });
  }

  async live(job, cmd) {
    const secs = Math.min(LIMITS.liveMaxSecs, Math.max(10, Math.round(cmd.secs || LIMITS.liveDefaultSecs)));
    let every = Math.max(LIMITS.liveMinEvery, Math.round(cmd.every || LIMITS.liveDefaultEvery));
    // ntfy.sh allows 250 messages a day per internet address and each frame is one: stretch the gap to fit what is
    // left today, keeping a reserve for heartbeats and answers.
    const left = await this.link.budget();
    if (left !== null) {
      const usable = left - LIMITS.budgetReserve;
      if (usable < 5) throw new Error(`the relay's daily message allowance for the phone is almost used up (${left} left); try tomorrow`);
      every = Math.max(every, Math.ceil(secs / usable));
    }
    this.rec.on("LIVE · CAMERA", { secs });
    await this.open(job, cmd, { width: 640, height: 480 });
    await sleep(700);
    const end = Date.now() + secs * 1000;
    let seq = 0;
    let wake = null;
    job.onStop = () => wake && wake();
    while (!job.stopped && Date.now() < end) {
      const t = Date.now();
      const bytes = await this.grab(640, 0.6);
      await this.send(job.id, "frame", "image/jpeg", bytes, { seq: ++seq, every, left: Math.max(0, Math.round((end - Date.now()) / 1000)), facing: cmd.facing });
      const wait = Math.min(end - Date.now(), every * 1000 - (Date.now() - t));
      if (wait > 0 && !job.stopped) await new Promise((r) => { wake = r; setTimeout(r, wait); });
    }
    this.release(job);
    await this.report(job.id, "done", "", { frames: seq });
  }
}
