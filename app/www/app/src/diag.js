// Every error on the phone goes to the hub (relay {t:"err"}), which logs it in data/phone-errors.log: script errors,
// unhandled promise rejections, console.error, fetches that fail and pictures/sounds that do not load, each with the
// card on screen. Deduplicated (same kind + card + message = one entry with a count) and rate-limited: the first batch
// 10 s after an error, then at most one message a minute and 40 a day (the relay counts messages per phone).
import { setErrorSink, noteError } from "./motion.js";

const FIRST_MS = 10000;
const GAP_MS = 60000;
const DAY_MAX = 40;
const REPEAT_MS = 10 * 60000; // an entry already sent goes again (with its new count) at most every 10 minutes
const PER_MSG = 10;
const LS_DAY = "dash.errDay";

const clip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
// "message @ file:line" from an Error: the first stack line that points into the app
function describe(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return clip(e, 300);
  const msg = e.message || (e.toString && e.toString()) || String(e);
  const at = (/(?:src\/|app\/)[\w/.-]+:\d+(?::\d+)?/.exec(e.stack || "") || [])[0];
  return clip(at && !msg.includes(at) ? `${msg} @ ${at}` : msg, 300);
}
const shortUrl = (u) => clip(String(u || "").replace(/[?#].*$/, "").replace(/^blob:.*$/, "blob:").replace(/^data:([^;,]*).*$/, "data:$1"), 120);

export class Diag {
  constructor({ send, card = () => "", ui = () => null }) {
    Object.assign(this, { send, card, ui });
    this.entries = new Map(); // key -> { kind, card, msg, n, first, last, sentN, sentAt }
    this.timer = 0;
    this.lastSent = 0;
    this.listeners = new Set(); // the self-test listens for errors while it shows each card
  }

  install() {
    setErrorSink((e, kind) => this.note(kind || "js", describe(e)));
    window.addEventListener("error", (e) => {
      const t = e.target;
      if (t && t !== window && t.tagName) return noteError(`${t.tagName.toLowerCase()} did not load: ${shortUrl(t.currentSrc || t.src || t.href)}`, "asset");
      noteError(e.error || `${e.message} @ ${shortUrl(e.filename)}:${e.lineno}`, "js");
    }, true); // capture: failed pictures and sounds do not bubble
    window.addEventListener("unhandledrejection", (e) => noteError(e.reason, "promise"));
    const ce = console.error.bind(console);
    console.error = (...a) => { ce(...a); this.note("console", clip(a.map((x) => (x instanceof Error ? describe(x) : typeof x === "object" ? safeJson(x) : String(x))).join(" "), 300)); };
    const f = window.fetch && window.fetch.bind(window);
    if (f) {
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input && input.url;
        try {
          const r = await f(input, init);
          // the relay's long-poll and the hub are watched by the link itself; a refused file or page is worth a line
          if (!r.ok && r.status !== 304) this.note("fetch", `${r.status} ${shortUrl(url)}`);
          return r;
        } catch (e) {
          if (!(e && e.name === "AbortError")) this.note("fetch", `${clip(e && e.message, 80)} ${shortUrl(url)}`);
          throw e;
        }
      };
    }
  }

  note(kind, msg) {
    const card = clip(this.card(), 20);
    const key = `${kind}|${card}|${msg}`;
    const now = Date.now();
    const e = this.entries.get(key) || { kind, card, msg, n: 0, first: now, last: now, sentN: 0, sentAt: 0 };
    e.n++;
    e.last = now;
    this.entries.set(key, e);
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value);
    for (const l of this.listeners) { try { l(e); } catch { /* a listener never breaks reporting */ } }
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    const wait = Math.max(FIRST_MS, this.lastSent + GAP_MS - Date.now());
    this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, wait);
  }

  dayCount(add = 0) {
    const today = new Date().toDateString();
    let d = null;
    try { d = JSON.parse(localStorage.getItem(LS_DAY)); } catch { /* fresh */ }
    if (!d || d.day !== today) d = { day: today, n: 0 };
    if (add) { d.n += add; localStorage.setItem(LS_DAY, JSON.stringify(d)); }
    return d.n;
  }

  // -> the entries still to report (new ones, and grown ones not sent for 10 minutes)
  due(now = Date.now()) {
    return [...this.entries.values()].filter((e) => e.n > e.sentN && (!e.sentN || now - e.sentAt > REPEAT_MS));
  }

  async flush() {
    const now = Date.now();
    const due = this.due(now);
    if (!due.length) return;
    if (this.dayCount() >= DAY_MAX) return; // today's share is used up; tomorrow's first error sends the backlog
    const list = due.sort((a, b) => b.last - a.last).slice(0, PER_MSG);
    const sent = await Promise.resolve(this.send({
      t: "err", ui: this.ui(), webview: (/Chrome\/([\d.]+)/.exec(navigator.userAgent) || [])[1] || "",
      list: list.map((e) => ({ kind: e.kind, card: e.card, msg: e.msg, n: e.n, first: e.first, last: e.last })),
    })).catch(() => false);
    if (!sent) { this.lastSent = now; this.schedule(); return; } // offline: try again in a minute
    this.lastSent = now;
    this.dayCount(1);
    for (const e of list) { e.sentN = e.n; e.sentAt = now; }
    if (due.length > list.length) this.schedule();
  }
}

function safeJson(x) {
  try { return JSON.stringify(x); } catch { return String(x); }
}
