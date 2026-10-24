// Telegram bot command handling. Only the owner's private chat is served; everything else is dropped silently.
import { newId, WIDGET_TYPES, THEMES, CLOCK_STYLES, MOTION_LEVELS, MAX_PHOTOS, MAX_NOTES, MAX_TODOS, upsertBirthday, removeBirthday, MAX_BIRTHDAYS, PREVIEW_MS } from "./store.js";
import { parseEvent, nextOccurrence, countdownText, repeatText, wallFromParts, MAX_EVENTS } from "../../app/www/app/src/events.js";
import { METHODS, METHOD_ALIASES, PRAYERS, DEFAULT_PRAYER } from "./islamic.js";
import { goodnight, wake, parseWake, setGoodnightMode, setQuiet, dimNow, quietOf, goodnightModeOn } from "./nightmode.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "Tue 28 Oct 11:00" for a wall-clock time (events.js)
const wallText = (ms, allDay) => {
  const d = new Date(ms);
  const s = `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
  return allDay ? s : `${s} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
import { parseHhmm, nextAt, parseDuration, fmtWhen, isValidTz } from "./time.js";
import { geocode } from "./weather.js";
import { ageBetween, formatAge, parseYmd, nextBirthday, UPCOMING_DAYS, celebration, normTag, BIRTHDAY_TAGS } from "../../app/www/app/src/age.js";

const SCREEN_NAMES = { newborn: "newborn", toddler: "toddler", female: "elegant", head: "head of the family", default: "party" };
import { wallParts } from "./time.js";
import { LIMITS as CAM } from "./camera.js";
import { moonNow, sunTimes, fmtDur } from "../../app/www/app/src/astro.js";

// The help is data: every command line carries a real example, and test/help.test.js runs every example
// through the bot, so the help cannot drift from the parsers. `ex` equal to the command itself is not printed.
export const HELP_SECTIONS = [
  { title: "🗣 Speak", keys: ["say", "speak"], lines: [
    ["Plain text or /say <text> - the phone speaks it", "Dinner is ready", "/say Time to leave for school"],
  ] },
  { title: "🎂 Birthdays", keys: ["birthday", "birthdays"], lines: [
    ["/birthday <name> <YYYY-MM-DD> [tag] - add or update", "/birthday Ravi 2019-03-15", "/birthday Maya 1995-01-01 female", "/birthday Omar 1990-01-01 head"],
    ["/birthday <name> <tag> - change the screen only. Tags: head, female, male, newborn, toddler, kid, auto (by age)", "/birthday Ravi auto"],
    ["/birthday preview <name> - their birthday screen on the phone for 30 s", "/birthday preview Ravi"],
    ["/birthdays - list them with ages", "/birthdays"],
    ["/birthday remove <name>", "/birthday remove Ravi"],
  ] },
  { title: "⏰ Alarms and reminders", keys: ["alarm", "alarms", "remind", "reminder", "reminders", "delalarm"], lines: [
    ["/alarm HH:MM [daily] <label>", "/alarm 06:30 daily Wake up", "/alarm 21:00 Lights out"],
    ["/remind <20m|2h|HH:MM> <text>", "/remind 20m Check the oven", "/remind 18:00 Call mom"],
    ["/alarms - list them with their ids", "/alarms"],
    ["/delalarm <id> - the id from /alarms", "/delalarm akx3m05"],
  ] },
  { title: "📅 Countdowns", keys: ["event", "events", "countdown", "eid", "islamic"], lines: [
    ["/event <weekday> [HH:MM] <name> - weekly", "/event Tuesday 11:00 Work"],
    ["/event <YYYY-MM-DD> [HH:MM] <name> - once", "/event 2026-12-25 Trip"],
    ["/event yearly <MM-DD> <name> (or daily HH:MM)", "/event yearly 03-15 Anniversary"],
    ["/events - yours + Eid and other Islamic dates", "/events"],
    ["/event remove <n>", "/event remove 3"],
  ] },
  { title: "🕌 Prayer times", keys: ["prayer", "prayers", "namaz", "salah", "adhan", "azan"], lines: [
    ["/prayer - today's five for the city", "/prayer"],
    ["/prayer method <karachi|isna|mwl|makkah|0-23>", "/prayer method karachi"],
    ["/prayer asr <hanafi|shafi>", "/prayer asr hanafi"],
    ["/prayer alarm <fajr..isha|all> <off|chime|adhan>", "/prayer alarm fajr chime"],
    ["/adhan - send an audio file captioned adhan to set it", "/adhan"],
  ] },
  { title: "🌙 Verse, moon and sun", keys: ["verse", "quran", "ayah", "moon", "sun", "sunrise", "sunset"], lines: [
    ["/verse - today's Quran verse (Arabic + translation)", "/verse"],
    ["/verse <english|urdu> - translation on the card", "/verse urdu", "/verse english"],
    ["/moon - phase, % lit, next full and new moon", "/moon"],
    ["/sun - sunrise, sunset and day length for the city", "/sun"],
  ] },
  { title: "📋 Family board", keys: ["note", "notes", "todo", "todos", "board"], lines: [
    ["/note <text> - stays until /note clear", "/note Milk and bread"],
    ["/todo add <text>", "/todo add Pay the electricity bill"],
    ["/todo done <n> (or undo)", "/todo done 1"],
    ["/board - notes and to-dos", "/board"],
    ["/note clear, /todo clear", "/todo clear"],
  ] },
  { title: "🧩 Layout and widgets", keys: ["layout", "layouts", "newlayout", "widgets", "widget", "add", "remove", "move", "cycle", "title"], lines: [
    ["/layouts - list, ▶ = on screen", "/layouts"],
    ["/layout <name> - switch", "/layout Home"],
    ["/newlayout <name> - copy the current one", "/newlayout Night"],
    ["/widgets - numbered list of this layout", "/widgets"],
    ["/add <age|clock|weather|alarms|agent>", "/add weather"],
    ["/remove <n> - n from /widgets", "/remove 3"],
    ["/move <n> <pos>", "/move 2 1"],
    ["/cycle <seconds 3-3600> - time per widget", "/cycle 30"],
    ["/title <n> <text> - card title (empty = default)", "/title 1 Family"],
  ] },
  { title: "🎨 Look and place", keys: ["city", "theme", "tz", "look", "weather", "clockstyle", "clock", "holder", "motion", "animation", "photos", "photo"], lines: [
    ["/city <name> - weather location", "/city Mumbai"],
    ["/theme <aurora|ember|mono>", "/theme ember"],
    ["/tz <Area/City> - time zone", "/tz Asia/Kolkata"],
    ["/clockstyle <rings|analogue|flip|minimal>", "/clockstyle flip"],
    ["/holder <0-45> - % of the screen bottom the wall holder hides (default 28)", "/holder 28", "/holder 0"],
    ["/motion <full|calm|off> - animations (calm: no particles)", "/motion calm", "/motion full"],
    ["/photos - photo frame (send a photo to add one)", "/photos"],
    ["/photo remove <n>, /photos clear", "/photo remove 1"],
  ] },
  { title: "🌙 Night and dimming (two switches, either dims; alarms, reminders, birthdays still light it up)", keys: ["goodnight", "night", "wake", "goodnightmode", "quiethours", "quiet", "dim"], lines: [
    ["goodnight or /goodnight - dim until 07:00", "goodnight", "/goodnight"],
    ["/goodnight HH:MM - dim until that time, and keep it as the wake time", "/goodnight 06:30"],
    ["/goodnightmode on|off - off: the word goodnight does nothing", "/goodnightmode off", "/goodnightmode on"],
    ["/quiethours on|off - dim every night 01:00-07:00, goodnight or not", "/quiethours off", "/quiethours on"],
    ["/quiethours HH:MM HH:MM - change the quiet hours", "/quiethours 23:30 06:30", "/quiethours 01:00 07:00"],
    ["/wake (or a tap on the screen) - ends a goodnight; in quiet hours bright for 2 min", "/wake"],
  ] },
  { title: "📷 Camera and screen", keys: ["snap", "clip", "live", "stop", "play", "camera", "video", "screen"], lines: [
    ["/snap [front|back] - a photo from the phone", "/snap", "/snap back"],
    ["/clip [1-60 s] [front|back] [mute] - a video clip", "/clip 15", "/clip 30 back mute"],
    ["/live [1-10 min] [front|back] - live view here", "/live 2", "/live 5 back"],
    ["/play <YouTube or https video link> - full screen", "/play https://www.youtube.com/watch?v=aqz-KE-bpKQ"],
    ["/stop - camera off, widgets back", "/stop"],
  ] },
  { title: "📱 Phones", keys: ["pair", "devices", "unpair", "ui", "phones", "phone", "use", "name", "selftest", "errors", "test"], lines: [
    ["/use <id|name|all> - which phone commands go to", "/use dkx3m07"],
    ["/name <id> <name>", "/name dkx3m07 Kitchen"],
    ["/pair - pairing code for the app", "/pair"],
    ["/devices - paired phones with their ids", "/devices"],
    ["/unpair <id> - the id from /devices", "/unpair dkx3m07"],
    ["/unpair all - every phone, new hub key", "/unpair all"],
    ["/ui - UI version on each phone", "/ui"],
    ["/ui push - send the current UI (no new APK)", "/ui push"],
    ["/selftest - every card for 3 s on the phone, a table + pictures here", "/selftest"],
    ["/errors - the latest errors the phones reported", "/errors"],
  ] },
  { title: "🤖 Agent", keys: ["ask", "agent", "newwidget", "approve"], lines: [
    ["/ask <question>", "/ask what is on today"],
    ["/agent - on/off and this month's spend", "/agent"],
    ["/newwidget <description> - drafts a widget", "/newwidget a countdown to Eid"],
    ["/approve <id> - the id /newwidget sent", "/approve cwkx3m09"],
  ] },
  { title: "📊 Status", keys: ["status", "help", "start"], lines: [
    ["/status - hub, phones, layout, alarms", "/status"],
    ["/help <command> - one section", "/help alarm"],
  ] },
];

const exampleShown = (usage, ex) => !(usage === ex || usage.startsWith(`${ex} `));
const renderSection = (sec) => [sec.title.toUpperCase(),
  ...sec.lines.flatMap(([u, ...ex]) => [u, ...ex.filter((e) => exampleShown(u, e)).map((e) => `   e.g. ${e}`)])].join("\n");

export const HELP = `Dashboard bot - commands (every "e.g." line works pasted as is)\n\n${HELP_SECTIONS.map(renderSection).join("\n\n")}`;

export function helpFor(word) {
  const w = word.toLowerCase().replace(/^\//, "");
  const sec = HELP_SECTIONS.find((s) => s.keys.includes(w) || s.title.toLowerCase().includes(w));
  return sec ? `${renderSection(sec)}\n\n/help - all commands` : `No help for "${word.slice(0, 30)}". Sections: ${HELP_SECTIONS.map((s) => s.title.replace(/^\S+ /, "")).join(", ")}. Send /help for all.`;
}

export function isOwnerMessage(update, ownerId) {
  const m = update && update.message;
  if (!m || !m.from || !m.chat || !ownerId) return false;
  return String(m.from.id) === String(ownerId) && String(m.chat.id) === String(ownerId) && m.chat.type === "private";
}

export class Bot {
  // media: Media (photo frame, adhan). download(fileId) -> bytes from Telegram. refreshIslamic(): prayer times and
  // Islamic dates again (after /city or a /prayer setting changed).
  constructor({ store, hub, agent, ownerId, send, refreshWeather = async () => {}, refreshIslamic = async () => {}, media = null, verse = null,
    download = null, log = () => {}, geocode: geo = geocode }) {
    Object.assign(this, { store, hub, agent, ownerId: String(ownerId), send, refreshWeather, refreshIslamic, media, verse, download, log, geocode: geo });
  }

  // A photo sent to the bot goes to the photo frame; an audio file captioned "adhan" becomes the adhan recording.
  // -> the reply, or null when the message is not media
  async onMedia(m) {
    const audio = m.audio || m.voice || (m.document && /^audio\//.test(m.document.mime_type || "") ? m.document : null);
    if (audio && /^\s*\/?adhan\b/i.test(m.caption || "")) {
      if (!this.media || !this.download) return "The adhan recording needs the hub's media store.";
      try {
        const bytes = await this.download(audio.file_id, 8 * 1024 * 1024);
        this.media.setAdhan(bytes, audio.mime_type || "audio/mpeg");
        return `🕌 Adhan recording saved (${Math.round(bytes.length / 1024)} KB). Prayers set to adhan play it: /prayer alarm all adhan`;
      } catch (e) {
        return `Could not save the recording: ${e.message} (max 7.5 MB).`;
      }
    }
    if (!(m.photo && m.photo.length)) return null;
    if (!this.media || !this.download) return "The photo frame needs the hub's media store.";
    // Telegram sends several sizes; the largest up to 1280 px is plenty for a phone and fits one relay file.
    const size = [...m.photo].sort((a, b) => b.width * b.height - a.width * a.height).find((p) => Math.max(p.width, p.height) <= 1280) || m.photo[0];
    try {
      const n = this.media.addPhoto(await this.download(size.file_id, 1.9 * 1024 * 1024), { w: size.width, h: size.height });
      return `🖼 Added to the photo frame (${n} photo${n === 1 ? "" : "s"}). Kept only on the hub. /photos lists them.`;
    } catch (e) {
      return `Could not add the photo: ${e.message}.`;
    }
  }

  tz() {
    return this.store.get().settings.tz;
  }

  wallNow() {
    return wallFromParts(wallParts(Date.now(), this.tz()));
  }

  // The phone a command goes to (/use), or null for all of them.
  target() {
    const t = this.store.get().target;
    return t && t !== "all" && this.store.get().devices.some((d) => d.id === t) ? t : null;
  }

  reply(text) {
    return this.send(this.ownerId, text);
  }

  async onUpdate(update) {
    if (!isOwnerMessage(update, this.ownerId)) return false; // strangers: no reply, no content logged
    const m = update.message;
    const media = await this.onMedia(m);
    if (media) { await this.reply(media); return true; }
    const text = (m.text || "").trim();
    if (!text) return true;
    const [, cmdRaw, rest = ""] = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text) || [null, null, text];
    // "goodnight" / "Good night!" as plain text is night mode, not something to read aloud
    const cmd = cmdRaw ? cmdRaw.toLowerCase() : /^good\s*night[\s.!]*$/i.test(text) ? "goodnight" : "say";
    const fn = this[`cmd_${cmd}`];
    const arg = cmdRaw || cmd === "say" ? rest.trim() : ""; // plain "good night" carries no wake time
    const out = fn ? await fn.call(this, arg) : `Unknown command /${cmd}. Send /help.`;
    if (out) await this.reply(out);
    return true;
  }

  cmd_start() { return `Hi. ${HELP}`; }
  cmd_help(t) { return t ? helpFor(t) : HELP; }

  cmd_say(t) {
    if (!t) return "Usage: /say <text>";
    const n = this.hub.speak(t, { to: this.target() });
    return n ? `🔊 Speaking on ${n} phone${n > 1 ? "s" : ""}.` : "📥 No phone online - queued, it plays when the phone reconnects (30 min).";
  }

  // ---------- family board ----------
  boardText() {
    const { notes, todos } = this.store.get().board;
    const n = notes.length ? notes.map((x) => `📝 ${x.text}`).join("\n") : "No notes.";
    const t = todos.length ? todos.map((x, i) => `${i + 1}. ${x.done ? "✅" : "⬜"} ${x.text}`).join("\n") : "No to-dos.";
    return `Family board\n${n}\n\nTo-do\n${t}`;
  }

  cmd_board() { return this.boardText(); }
  cmd_notes() { return this.boardText(); }

  cmd_note(t) {
    if (!t) return this.boardText();
    if (/^clear$/i.test(t)) {
      this.store.update((s) => { s.board.notes = []; });
      return "Notes cleared.";
    }
    if (this.store.get().board.notes.length >= MAX_NOTES) return `The board holds ${MAX_NOTES} notes. /note clear first.`;
    this.store.update((s) => { s.board.notes.push({ text: t.replace(/\s+/g, " ").slice(0, 200), at: Date.now() }); });
    return `📝 On the board until /note clear. ${this.store.get().board.notes.length} note(s).`;
  }

  cmd_todo(t) {
    const todos = () => this.store.get().board.todos;
    let m;
    if (!t) return this.boardText();
    if ((m = /^add\s+([\s\S]+)$/i.exec(t))) {
      if (todos().length >= MAX_TODOS) return `The list holds ${MAX_TODOS} items. /todo clear first.`;
      this.store.update((s) => { s.board.todos.push({ text: m[1].replace(/\s+/g, " ").slice(0, 120), done: false }); });
      return `⬜ ${todos().length}. ${todos()[todos().length - 1].text}`;
    }
    if ((m = /^(done|undo)\s+(\d+)$/i.exec(t))) {
      const i = +m[2] - 1;
      if (!todos()[i]) return `No item ${m[2]}. /todo lists them.`;
      this.store.update((s) => { s.board.todos[i].done = m[1].toLowerCase() === "done"; });
      return `${todos()[i].done ? "✅" : "⬜"} ${i + 1}. ${todos()[i].text}`;
    }
    if (/^clear$/i.test(t)) {
      this.store.update((s) => { s.board.todos = []; });
      return "To-do list cleared.";
    }
    return "Usage: /todo add <text>, /todo done <n>, /todo undo <n>, /todo clear";
  }

  // ---------- countdowns ----------
  cmd_event(t) {
    const rm = /^(?:remove|delete|del)\s+(\d+)$/i.exec(t);
    if (rm) {
      const ev = this.store.get().events[+rm[1] - 1];
      if (!ev) return `No event ${rm[1]}. /events lists them.`;
      this.store.update((s) => { s.events.splice(+rm[1] - 1, 1); });
      return `Removed ${ev.name}.`;
    }
    const r = parseEvent(t);
    if (!r.ok) return "Usage: /event <weekday|YYYY-MM-DD|yearly MM-DD|daily> [HH:MM] <name>, /event remove <n>, /events";
    if (this.store.get().events.length >= MAX_EVENTS) return `The list holds ${MAX_EVENTS} events. /event remove <n> first.`;
    this.store.update((s) => { s.events.push({ id: newId("e"), ...r.ev }); });
    const o = nextOccurrence(r.ev, this.wallNow());
    if (!o) return `Saved ${r.ev.name}, but that date has passed. /event remove ${this.store.get().events.length}`;
    return `📅 ${r.ev.name}${repeatText(r.ev) ? ` (${repeatText(r.ev)})` : ""}: next ${wallText(o.at, o.allDay)}, ${countdownText(o.at, this.wallNow(), o.allDay)}.`;
  }

  cmd_events() {
    const s = this.store.get();
    const now = this.wallNow();
    const own = s.events.length
      ? s.events.map((ev, i) => {
        const o = nextOccurrence(ev, now);
        return `${i + 1}. ${ev.name}${repeatText(ev) ? ` (${repeatText(ev)})` : ""} - ${o ? `${wallText(o.at, o.allDay)}, ${countdownText(o.at, now, o.allDay)}` : "passed"}`;
      }).join("\n")
      : "No events yet. Add one: /event Tuesday 11:00 Work";
    const isl = (s.islamic && s.islamic.items) || [];
    const list = isl.slice(0, 5).map((x) => {
      const o = nextOccurrence({ kind: "once", date: x.date }, now);
      return `🌙 ${x.name} - ${x.date} (${x.hijri}), ${o ? countdownText(o.at, now, true) : ""}`;
    });
    return `Your events\n${own}${list.length ? `\n\nIslamic dates (calculated; may move a day with the moon sighting)\n${list.join("\n")}` : ""}`;
  }

  // ---------- prayer times ----------
  prayerSettings() {
    return { ...DEFAULT_PRAYER, ...(this.store.get().settings.prayer || {}), alarms: { ...((this.store.get().settings.prayer || {}).alarms || {}) } };
  }

  async cmd_prayer(t) {
    const p = this.prayerSettings();
    const save = (next) => this.store.update((s) => { s.settings.prayer = next; });
    let m;
    if ((m = /^method\s+(\S+)$/i.exec(t))) {
      const k = m[1].toLowerCase();
      const id = /^\d+$/.test(k) ? +k : METHOD_ALIASES[k];
      if (!(id in METHODS)) return `Methods: ${Object.entries(METHOD_ALIASES).map(([n, i]) => `${n} (${i})`).join(", ")}, or a number 0-23 from aladhan.com.`;
      save({ ...p, method: id });
      await this.refreshIslamic().catch(() => {});
      return `🕌 Prayer times now use ${METHODS[id]}.`;
    }
    if ((m = /^asr\s+(hanafi|shafi'?i?|standard)$/i.exec(t))) {
      const school = /^hanafi$/i.test(m[1]) ? 1 : 0;
      save({ ...p, school });
      await this.refreshIslamic().catch(() => {});
      return `🕌 Asr time: ${school ? "Hanafi" : "Shafi'i (standard)"}.`;
    }
    if ((m = /^alarm\s+(fajr|dhuhr|zuhr|asr|maghrib|isha|all)\s+(off|chime|adhan)$/i.exec(t))) {
      const which = m[1].toLowerCase() === "zuhr" ? "dhuhr" : m[1].toLowerCase();
      const mode = m[2].toLowerCase();
      for (const k of which === "all" ? PRAYERS : [which]) p.alarms[k] = mode;
      save(p);
      const extra = mode === "adhan" && !this.store.get().adhan ? " No adhan recording yet: until you send one (an audio file captioned adhan), it plays the chime and says the prayer name." : "";
      return `🔔 ${which === "all" ? "Every prayer" : which[0].toUpperCase() + which.slice(1)}: ${mode}.${extra}`;
    }
    if (t) return "Usage: /prayer, /prayer method <karachi|isna|mwl|makkah|...>, /prayer asr <hanafi|shafi>, /prayer alarm <fajr|dhuhr|asr|maghrib|isha|all> <off|chime|adhan>";
    const pr = this.store.get().prayer;
    if (!pr || !pr.today) return this.store.get().settings.city ? "Fetching prayer times... try again in a minute." : "Set the city first: /city <name>";
    const al = (k) => (p.alarms[k] && p.alarms[k] !== "off" ? ` 🔔${p.alarms[k]}` : "");
    return [`🕌 ${pr.city} · ${pr.today.date} · ${pr.today.hijri}`, ...PRAYERS.map((k) => `${k[0].toUpperCase() + k.slice(1)} ${pr.today.times[k]}${al(k)}`),
      `Method: ${pr.methodName} · Asr: ${pr.asr}`].join("\n");
  }

  cmd_adhan(t) {
    if (/^(clear|remove|delete)$/i.test(t)) return this.media && this.media.clearAdhan() ? "Adhan recording removed: adhan alarms play the chime." : "No adhan recording saved.";
    const a = this.store.get().adhan;
    return a ? `Adhan recording: ${Math.round(a.size / 1024)} KB. /adhan clear removes it.` : "Adhan: no recording yet, so adhan alarms play the chime and say the prayer name. To set one, send an audio file to this chat with the caption adhan.";
  }

  // ---------- photo frame ----------
  cmd_photos(t) {
    if (/^clear$/i.test(t)) return this.media ? `Removed ${this.media.clearPhotos()} photo(s) from the hub.` : "No media store.";
    const p = this.store.get().photos;
    if (!p.length) return "The photo frame is empty. Send a photo to this chat to add it (kept only on the hub).";
    return `Photo frame: ${p.length} of ${MAX_PHOTOS}\n${p.map((x, i) => `${i + 1}. ${new Date(x.at).toISOString().slice(0, 10)} ${x.w}x${x.h}`).join("\n")}\n/photo remove <n>, /photos clear`;
  }

  cmd_photo(t) {
    const m = /^(?:remove|delete|del)\s+(\d+)$/i.exec(t);
    if (!m) return "Usage: /photo remove <n> (numbers from /photos)";
    return this.media && this.media.removePhoto(+m[1]) ? `Removed photo ${m[1]}.` : `No photo ${m[1]}. /photos lists them.`;
  }

  // ---------- look ----------
  cmd_clockstyle(t) {
    const st = t.toLowerCase().replace(/^analog$/, "analogue");
    if (!CLOCK_STYLES.includes(st)) return `Usage: /clockstyle <${CLOCK_STYLES.join("|")}>`;
    this.store.update((s) => { s.settings.clockStyle = st; });
    return `🕰 Clock style: ${st}.`;
  }

  // The wall holder hides the bottom of the screen: nothing that matters is drawn there (app styles.css --band).
  cmd_holder(t) {
    const cur = this.store.get().settings.holder;
    if (!t) return `The holder hides the bottom ${cur ?? 28}% of the screen. /holder <0-45> changes it.`;
    const n = /^\d{1,2}$/.test(t.trim()) ? parseInt(t, 10) : NaN;
    if (!(n >= 0 && n <= 45)) return "Usage: /holder <0-45> (percent of the screen height hidden at the bottom; 0 = none)";
    this.store.update((s) => { s.settings.holder = n; });
    return n ? `📱 Cards now stay above the bottom ${n}% of the screen.` : "📱 No holder band: cards use the whole screen.";
  }

  cmd_motion(t) {
    const lv = t.toLowerCase().trim();
    if (!lv) return `Motion: ${this.store.get().settings.motion || "full"}. Change it with /motion <${MOTION_LEVELS.join("|")}>.`;
    if (!MOTION_LEVELS.includes(lv)) return `Usage: /motion <${MOTION_LEVELS.join("|")}>`;
    this.store.update((s) => { s.settings.motion = lv; });
    return { full: "✨ Motion: full - every animation on.", calm: "🍃 Motion: calm - gentle movement, no particles or shake.", off: "⏸ Motion: off - a still dashboard." }[lv];
  }

  // ---------- verse of the day, moon, sun ----------
  // The verse is the source's text as fetched (quran.js); nothing here rewrites it.
  async cmd_verse(t) {
    const lang = { english: "en", en: "en", urdu: "ur", ur: "ur" }[t.toLowerCase()];
    if (t && !lang) return "Usage: /verse, /verse english, /verse urdu";
    if (lang) {
      this.store.update((s) => { s.settings.verseLang = lang; });
      return `📖 The verse card now shows the ${lang === "ur" ? "Urdu" : "English"} translation.`;
    }
    let v = this.store.get().verse;
    if (!v && this.verse) { await this.verse.refresh({ force: true }); v = this.store.get().verse; }
    if (!v) return "Today's verse is not fetched yet (api.alquran.cloud). It comes up on the card when it is.";
    const l = this.store.get().settings.verseLang === "ur" ? "ur" : "en";
    const tr = v.tr[l];
    return [`📖 ${v.surah.englishName} (${v.surah.meaning}) ${v.surah.number}:${v.ayah}`, v.arabic, `${tr.text}\n- ${tr.name}`,
      `Text: ${v.source}, ${v.date}. Card language: ${l === "ur" ? "Urdu (/verse english)" : "English (/verse urdu)"}`].join("\n\n");
  }

  // dates and times in the dashboard's time zone
  fmtIn(ms, opts) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: this.tz(), ...opts }).format(new Date(ms));
  }

  cmd_moon() {
    const m = moonNow();
    const when = (ms) => `${this.fmtIn(ms, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} (in ${((ms - Date.now()) / 86400000).toFixed(1)} days)`;
    return [`🌙 ${m.name}, ${Math.round(m.illum * 100)}% lit, ${m.ageDays.toFixed(1)} days since the new moon`,
      `Next full moon: ${when(m.nextFull)}`, `Next new moon: ${when(m.nextNew)}`].join("\n");
  }

  cmd_sun() {
    const c = this.store.get().settings.city;
    if (!c) return "Set the city first: /city <name>";
    const t = this.today();
    const s = sunTimes(t.y, t.m, t.d, c.lat, c.lon);
    if (!s.rise || !s.set) return `☀️ ${c.name}: no sunrise or sunset today (polar day or night).`;
    const hm = (ms) => this.fmtIn(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return [`☀️ ${c.name} today`, `Sunrise ${hm(s.rise)} · solar noon ${hm(s.noon)} · sunset ${hm(s.set)}`, `Day length ${fmtDur(s.dayMs)}`].join("\n");
  }

  // ---------- night mode ----------
  cmd_goodnight(t) {
    const w = t ? parseWake(t) : null;
    if (t && !w) return "Usage: /goodnight [HH:MM] - e.g. /goodnight 06:30 dims until 06:30 and keeps 06:30 as the wake time";
    const r = goodnight(this.store, this.tz(), w);
    if (!r) return "Goodnight mode is off, so goodnight does nothing. /goodnightmode on turns it back on.";
    return `🌙 Good night. The dashboard shows a dim clock until ${fmtWhen(r.until, this.tz())}${w ? ` (wake time is now ${w})` : ""}. Alarms, reminders and birthdays still light it up. /wake or a tap on the screen ends it.`;
  }

  cmd_wake() {
    const r = wake(this.store, this.tz());
    const hm = (ms) => this.fmtIn(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (r.brightUntil) return `☀️ Bright for 2 minutes (until ${hm(r.brightUntil)}), then quiet hours dim it again until ${quietOf(this.store.get().settings).to}.`;
    return r.ended ? "☀️ Good morning. Widgets are back." : "The screen is not dimmed.";
  }

  cmd_goodnightmode(t) {
    const v = String(t || "").toLowerCase();
    if (v !== "on" && v !== "off") return `Goodnight mode is ${goodnightModeOn(this.store.get().settings) ? "on" : "off"}. Usage: /goodnightmode on|off`;
    setGoodnightMode(this.store, v === "on");
    return v === "on" ? "🌙 Goodnight mode on: goodnight dims the screen until the wake time." : "Goodnight mode off: the word goodnight does nothing now (quiet hours are separate).";
  }

  cmd_quiethours(t) {
    const words = String(t || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const q0 = quietOf(this.store.get().settings);
    const show = (q) => `${q.on ? "on" : "off"}, ${q.from}-${q.to}`;
    if (!words.length) return `Quiet hours: ${show(q0)}. Usage: /quiethours on|off, or /quiethours HH:MM HH:MM`;
    if (words.length === 1 && (words[0] === "on" || words[0] === "off")) {
      setQuiet(this.store, { on: words[0] === "on" });
      return words[0] === "on" ? `🌙 Quiet hours on: dim every night ${q0.from}-${q0.to}.` : "Quiet hours off (goodnight still works if goodnight mode is on).";
    }
    const from = parseWake(words[0]), to = parseWake(words[1]);
    if (words.length !== 2 || !from || !to) return "Usage: /quiethours on|off, or /quiethours HH:MM HH:MM (e.g. /quiethours 23:30 06:30)";
    if (from === to) return "Start and end must differ.";
    setQuiet(this.store, { from, to, on: true });
    return `🌙 Quiet hours on: dim every night ${from}-${to}.`;
  }
  cmd_quiet(t) { return this.cmd_quiethours(t); }

  // ---------- phones ----------
  findDevice(word) {
    const w = String(word || "").toLowerCase();
    return this.store.get().devices.find((d) => d.id === w || d.name.toLowerCase() === w) || null;
  }

  cmd_use(t) {
    if (!t) {
      const tg = this.target();
      return `Commands go to ${tg ? this.findDevice(tg).name + ` (${tg})` : "every phone"}. /use <id|name|all>`;
    }
    if (/^all$/i.test(t)) {
      this.store.update((s) => { s.target = "all"; }, { silent: true });
      return "Commands go to every phone (the camera uses the one seen last).";
    }
    const d = this.findDevice(t);
    if (!d) return `No phone "${t.slice(0, 30)}". /devices lists them.`;
    this.store.update((s) => { s.target = d.id; }, { silent: true });
    return `Commands (speech, camera, /play, /stop) now go to ${d.name} (${d.id}). /use all to undo.`;
  }

  cmd_name(t) {
    const m = /^(\S+)\s+(.+)$/.exec(t);
    const d = m && this.findDevice(m[1]);
    const name = m && m[2].replace(/[^\w .-]/g, "").trim().slice(0, 30);
    if (!d || !name) return "Usage: /name <id> <name>, e.g. /name dkx3m07 Kitchen (ids from /devices)";
    this.store.update((s) => { s.devices.find((x) => x.id === d.id).name = name; }, { silent: true });
    return `${d.id} is now called ${name}.`;
  }

  cmd_birthday(t) {
    const rm = /^(?:remove|delete|del)\s+(.+)$/i.exec(t);
    if (rm) {
      const name = rm[1].trim();
      const gone = this.store.update((s) => removeBirthday(s, name));
      const n = this.store.get().birthdays.length;
      return gone ? `Removed ${gone.name}. ${n} birthday${n === 1 ? "" : "s"} saved.` : `No birthday for "${name.slice(0, 40)}". See /birthdays.`;
    }
    const pv = /^preview(?:\s+(.+))?$/i.exec(t);
    if (pv) return this.birthdayPreview((pv[1] || "").trim());
    const usage = `Usage: /birthday <name> <YYYY-MM-DD> [${BIRTHDAY_TAGS.join("|")}] (adds or updates), /birthday <name> <tag>, /birthday preview <name>, /birthday remove <name>, /birthdays`;
    const find = (name) => this.store.get().birthdays.find((b) => b.name.toLowerCase() === name.toLowerCase());
    let m = /^(.+?)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\S+))?$/.exec(t);
    let tag;
    if (m && m[3] !== undefined && !(tag = normTag(m[3]))) return `Unknown tag "${m[3].slice(0, 20)}". Tags: ${BIRTHDAY_TAGS.join(", ")}.`;
    if (!m) {
      // tag only, for someone already saved: /birthday Maya female
      const k = /^(.+?)\s+(\S+)$/.exec(t);
      if (!(k && (tag = normTag(k[2])) && find(k[1].trim().replace(/\s+/g, " ")))) return usage;
      m = [t, k[1], null];
    }
    const birth = m[2] ? parseYmd(m[2]) : parseYmd(find(m[1].trim().replace(/\s+/g, " ")).birth);
    if (!birth) return usage;
    const name = m[1].trim().replace(/\s+/g, " ").slice(0, 40);
    const r = this.store.update((s) => upsertBirthday(s, name, m[2], tag));
    if (r === "full") return `The list is full (${MAX_BIRTHDAYS}). Remove one first: /birthday remove <name>.`;
    const n = this.store.get().birthdays.length;
    const a = ageBetween(birth, this.today());
    const c = celebration(find(name), this.today());
    const screen = c ? `\nBirthday screen: ${SCREEN_NAMES[c.kind]}${find(name).tag ? ` (tag ${find(name).tag})` : " (by age)"} - /birthday preview ${name}` : "";
    return `${r === "updated" ? "Updated" : "Saved"}. ${name} is ${a ? `${formatAge(a)} today` : "not born yet"}.\n${n} birthday${n === 1 ? "" : "s"} saved - /birthdays lists them.${screen}`;
  }

  // Shows that person's full-screen birthday takeover on the phones now, for 30 s.
  birthdayPreview(name) {
    const list = this.store.get().birthdays;
    if (!name) return `Usage: /birthday preview <name>${list.length ? `, e.g. /birthday preview ${list[0].name}` : ""}`;
    const p = list.find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (!p) return `No birthday for "${name.slice(0, 40)}". See /birthdays.`;
    const c = celebration(p, this.today());
    if (!c) return `${p.name} is not born yet, so there is no birthday screen.`;
    const until = Date.now() + PREVIEW_MS;
    this.store.update((s) => { s.bdayPreview = { name: p.name, until }; });
    const on = this.hub.onlineDevices().length;
    return `🎉 Showing ${p.name}'s birthday screen (${SCREEN_NAMES[c.kind]}) for ${PREVIEW_MS / 1000} s${on ? "" : " - no phone online right now"}. Tap the phone to close it early.`;
  }

  cmd_birthdays() {
    const list = this.store.get().birthdays;
    if (!list.length) return "No birthdays saved. Add one: /birthday <name> <YYYY-MM-DD>";
    const t = this.today();
    const lines = list.map((q) => {
      const p = { ...q, name: q.tag ? `${q.name} (${q.tag})` : q.name };
      const b = parseYmd(p.birth);
      const a = b && ageBetween(b, t);
      if (!a) return `${p.name} - not born yet (${p.birth})`;
      const nb = nextBirthday(b, t);
      if (nb.days === 0) return `🎂 ${p.name} - turns ${nb.turns} TODAY`;
      const soon = nb.days <= UPCOMING_DAYS ? "🎈 " : "";
      return `${soon}${p.name} - ${formatAge(a)} (turns ${nb.turns} in ${nb.days} day${nb.days === 1 ? "" : "s"})`;
    });
    return `Birthdays (${list.length}):\n${lines.join("\n")}`;
  }

  today() {
    const w = wallParts(Date.now(), this.store.get().settings.tz);
    return { y: w.y, m: w.m, d: w.d };
  }

  cmd_alarm(t) {
    const m = /^(\S+)\s*(daily\b)?\s*([\s\S]*)$/i.exec(t);
    const hm = m && parseHhmm(m[1]);
    if (!hm) return "Usage: /alarm HH:MM [daily] <label>";
    const tz = this.store.get().settings.tz;
    const a = { id: newId("a"), kind: "alarm", label: (m[3] || "Alarm").slice(0, 80), time: hm.text };
    if (m[2]) a.repeat = "daily";
    else a.at = nextAt(hm, tz);
    this.store.update((s) => s.alarms.push(a));
    return `⏰ ${a.id}: ${a.label} - ${a.repeat ? `every day at ${a.time}` : fmtWhen(a.at, tz)}`;
  }

  cmd_remind(t) {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(t);
    if (!m) return "Usage: /remind <20m|2h|HH:MM> <text>";
    const tz = this.store.get().settings.tz;
    const dur = parseDuration(m[1]);
    const hm = !dur && parseHhmm(m[1]);
    if (!dur && !hm) return "Usage: /remind <20m|2h|HH:MM> <text>";
    const at = dur ? Date.now() + dur : nextAt(hm, tz);
    const a = { id: newId("a"), kind: "reminder", label: m[2].slice(0, 120), at };
    this.store.update((s) => s.alarms.push(a));
    return `🔔 ${a.id}: ${a.label} - ${fmtWhen(at, tz)}`;
  }

  cmd_alarms() {
    const { alarms, settings } = this.store.get();
    if (!alarms.length) return "No alarms or reminders.";
    return alarms
      .map((a) => `${a.id}  ${a.kind === "reminder" ? "🔔" : "⏰"} ${a.repeat ? `daily ${a.time}` : fmtWhen(a.at, settings.tz)}  ${a.label}`)
      .join("\n");
  }

  cmd_delalarm(id) {
    const before = this.store.get().alarms.length;
    this.store.update((s) => { s.alarms = s.alarms.filter((a) => a.id !== id); });
    return this.store.get().alarms.length < before ? `Deleted ${id}.` : `No alarm ${id}. See /alarms.`;
  }

  findLayout(name) {
    const n = name.toLowerCase();
    return this.store.get().layouts.find((l) => l.id === n || l.name.toLowerCase() === n);
  }

  cmd_layouts() {
    const s = this.store.get();
    return s.layouts.map((l) => `${l.id === s.activeLayout ? "▶" : "  "} ${l.name} (${l.widgets.length} widgets, ${l.cycleSeconds}s)`).join("\n");
  }

  cmd_layout(name) {
    const l = name && this.findLayout(name);
    if (!l) return `No layout "${name}". ${this.cmd_layouts()}`;
    this.store.update((s) => { s.activeLayout = l.id; });
    return `▶ ${l.name}`;
  }

  cmd_newlayout(name) {
    if (!name || name.length > 30) return "Usage: /newlayout <name>";
    if (this.findLayout(name)) return `"${name}" exists.`;
    const cur = this.store.activeLayout();
    const l = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, cycleSeconds: cur.cycleSeconds,
      widgets: cur.widgets.map((w) => ({ ...w, id: newId("w") })) };
    this.store.update((s) => { s.layouts.push(l); s.activeLayout = l.id; });
    return `▶ ${name} (copy of ${cur.name}). Edit it with /add, /remove, /move.`;
  }

  cmd_widgets() {
    const l = this.store.activeLayout();
    const cw = this.store.get().customWidgets;
    return `${l.name}:\n` + l.widgets.map((w, i) => `${i + 1}. ${w.type}${w.ref ? ` (${cw[w.ref]?.name || w.ref})` : ""}`).join("\n");
  }

  cmd_add(t) {
    const type = t.toLowerCase();
    const cw = this.store.get().customWidgets[t];
    if (cw && cw.approved) {
      this.store.update(() => this.store.activeLayout().widgets.push({ id: newId("w"), type: "html", ref: t }));
      return `Added ${cw.name}. ${this.cmd_widgets()}`;
    }
    if (!WIDGET_TYPES.includes(type) || type === "html") return `Types: ${WIDGET_TYPES.filter((x) => x !== "html").join(", ")} (or an approved custom widget id)`;
    this.store.update(() => this.store.activeLayout().widgets.push({ id: newId("w"), type }));
    return `Added ${type}. ${this.cmd_widgets()}`;
  }

  cmd_remove(t) {
    const l = this.store.activeLayout();
    const i = parseInt(t, 10) - 1;
    if (!(i >= 0 && i < l.widgets.length)) return `Usage: /remove <n>. ${this.cmd_widgets()}`;
    if (l.widgets.length === 1) return "A layout needs at least one widget.";
    this.store.update(() => l.widgets.splice(i, 1));
    return this.cmd_widgets();
  }

  cmd_move(t) {
    const l = this.store.activeLayout();
    const [a, b] = t.split(/\s+/).map((x) => parseInt(x, 10) - 1);
    if (!(a >= 0 && a < l.widgets.length && b >= 0 && b < l.widgets.length)) return `Usage: /move <n> <pos>. ${this.cmd_widgets()}`;
    this.store.update(() => { const [w] = l.widgets.splice(a, 1); l.widgets.splice(b, 0, w); });
    return this.cmd_widgets();
  }

  cmd_cycle(t) {
    const n = parseInt(t, 10);
    if (!(n >= 3 && n <= 3600)) return "Usage: /cycle <seconds 3-3600>";
    this.store.update(() => { this.store.activeLayout().cycleSeconds = n; });
    return `Cycling every ${n}s.`;
  }

  // Data-driven: the card title is layout data, so this reaches the phone without a UI push.
  cmd_title(t) {
    const m = /^(\d+)\s*([\s\S]*)$/.exec(t);
    const ws = this.store.activeLayout().widgets;
    const w = m && ws[parseInt(m[1], 10) - 1];
    if (!w) return "Usage: /title <n> <text> (empty text = default title). /widgets shows the numbers.";
    const title = m[2].trim().slice(0, 40);
    this.store.update(() => { if (title) w.title = title; else delete w.title; });
    return title ? `Widget ${m[1]} is now titled "${title}".` : `Widget ${m[1]} has its default title again.`;
  }

  // The phone's whole UI comes from the hub: /ui push sends the current app/www/app as a new signed version.
  async cmd_ui(t) {
    if (!this.hub.uiStatus || !this.hub.uiStatus()) return "UI pushes need the relay link.";
    if (/^push$/i.test(t)) {
      try {
        const r = await this.hub.uiPush();
        return r.phones
          ? `UI v${r.v} (${Math.round(r.size / 1024)} KB, signed) sent to ${r.phones} phone${r.phones > 1 ? "s" : ""}. It switches at a quiet moment; I'll tell you when it runs.`
          : `UI v${r.v} built and signed, but no phone could be reached; it goes out when a phone connects.`;
      } catch (e) {
        return `UI push failed: ${e.message}`;
      }
    }
    const s = this.hub.uiStatus();
    const phones = s.phones.map((p) => `${p.name} (${p.id}): ${p.ui ? `on UI v${p.ui.active}` : "UI not reported yet"}`);
    return [`UI on the hub: v${s.version}${s.builtAt ? `, built ${s.builtAt.slice(0, 16).replace("T", " ")} UTC` : " (the one in the APK)"}`, ...phones,
      "/ui push sends the current UI to the phones."].join("\n");
  }

  // The phone tests itself: every card for 3 s, measured on the phone (app selftest.js, hub selftest.js).
  async cmd_selftest() {
    return this.hub.selfTest ? this.hub.selfTest() : "The self-test needs the relay link.";
  }

  cmd_errors() {
    return this.hub.phoneErrors ? this.hub.phoneErrors(12) : "The error log needs the relay link.";
  }

  // ---------- camera and screen: the phone shows a red REC indicator whenever its camera is on ----------
  // -> { facing, secs, audio } from words in any order, or null on a word it does not know
  camArgs(t, { unit, def, max }) {
    const o = { facing: "front", secs: def, audio: true };
    for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (w === "front" || w === "back") o.facing = w;
      else if (w === "mute" || w === "silent") o.audio = false;
      else if (unit && /^\d+$/.test(w) && +w >= 1 && +w <= max) o.secs = +w * unit;
      else return null;
    }
    return o;
  }

  async cmd_snap(t) {
    const o = this.camArgs(t, { unit: 0 });
    if (!o || !o.audio) return "Usage: /snap [front|back]";
    return this.hub.camera.start("snap", { facing: o.facing });
  }

  async cmd_clip(t) {
    const o = this.camArgs(t, { unit: 1, def: CAM.clipDefaultSecs, max: CAM.clipMaxSecs });
    if (!o) return `Usage: /clip [1-${CAM.clipMaxSecs} seconds] [front|back] [mute]`;
    return this.hub.camera.start("clip", o);
  }

  async cmd_live(t) {
    const o = this.camArgs(t, { unit: 60, def: CAM.liveDefaultMin * 60, max: CAM.liveMaxMin });
    if (!o || !o.audio) return `Usage: /live [1-${CAM.liveMaxMin} minutes] [front|back]`;
    return this.hub.camera.start("live", { facing: o.facing, secs: o.secs, audio: false });
  }

  async cmd_stop() {
    return this.hub.camera.stop();
  }

  async cmd_play(t) {
    let u = null;
    try { u = new URL(t); } catch {}
    if (!u || u.protocol !== "https:" || t.length > 2000) return "Usage: /play <YouTube or https video link>";
    return this.hub.camera.play(u.href);
  }

  async cmd_city(t) {
    if (!t) return "Usage: /city <name>";
    const g = await this.geocode(t).catch(() => null);
    if (!g) return `Couldn't find "${t}".`;
    this.store.update((s) => { s.settings.city = { name: g.name, country: g.country, lat: g.lat, lon: g.lon }; });
    await this.refreshWeather().catch(() => {});
    await this.refreshIslamic().catch(() => {}); // prayer times follow the city
    return `🌤 Weather for ${g.name}, ${g.country}.`;
  }

  cmd_theme(t) {
    if (!THEMES.includes(t)) return `Themes: ${THEMES.join(", ")}`;
    this.store.update((s) => { s.settings.theme = t; });
    return `Theme: ${t}`;
  }

  cmd_tz(t) {
    if (!t || !isValidTz(t)) return "Usage: /tz <Area/City>, e.g. /tz Asia/Kolkata";
    this.store.update((s) => { s.settings.tz = t; });
    return `Time zone: ${t}`;
  }

  cmd_pair(arg) {
    if (/^local$/i.test(arg)) {
      const code = this.hub.newLocalPairingCode();
      return `Local pairing code (old app, direct hub address): ${code}\nValid 10 minutes, single use.`;
    }
    const code = this.hub.newPairingCode();
    if (!code) return "Pairing is locked for 10 minutes after repeated failed attempts.";
    return `Pairing code: ${code}\nType it in the Dashboard app within 10 minutes. Single use. When it pairs I send you a fingerprint: it must match the one on the phone.`;
  }

  cmd_devices() {
    const online = new Set(this.hub.onlineDevices());
    const d = this.store.get().devices;
    if (!d.length) return "No paired phones. Send /pair.";
    const tg = this.target();
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
    const lines = d.map((x) => {
      const st = x.status || {};
      const bat = st.bat == null ? "🔋 ?" : `🔋 ${st.bat}%${st.chg ? " charging" : st.chg === false ? " on battery" : ""}`;
      const net = { wifi: "📶 Wi-Fi", cellular: "📡 mobile data", none: "no network", ethernet: "🔌 ethernet" }[st.net] || "network ?";
      const app = st.app ? `app ${st.app}` : x.cam ? "app 0.3.1+" : x.ui ? "app 0.3.0" : "old app (0.2.x)";
      return `${online.has(x.id) ? "🟢" : "⚪"} ${x.id} ${x.name}${tg === x.id ? " ◀ /use" : ""}\n   ${bat} · ${net} · ${app}${x.ui ? ` · UI v${x.ui.active}` : ""} · seen ${x.lastSeen ? ago(x.lastSeen) : "never"}${x.kind === "relay" ? `\n   fingerprint ${x.fp}` : ""}`;
    });
    return `${lines.join("\n")}\nCommands go to ${tg ? "the marked phone" : "every phone"}: /use <id|name|all>. Rename: /name <id> <name>. Battery and network come with the next heartbeat (20 min).`;
  }

  async cmd_unpair(id) {
    if (!id) return "Usage: /unpair <id> or /unpair all";
    if (id.toLowerCase() === "all") {
      await this.hub.rotate();
      return "Every phone is unpaired and the hub has a new key. Pair again with /pair.";
    }
    return (await this.hub.unpair(id)) ? `Unpaired ${id}: its key is deleted and the hub no longer listens to it.` : `No device ${id}. See /devices.`;
  }

  async cmd_ask(q) {
    if (!q) return "Usage: /ask <question>";
    const r = await this.agent.ask(q);
    return r.text;
  }

  cmd_agent() {
    const s = this.agent.status();
    return `Agent: ${s.enabled ? "ON" : `OFF (${s.reasonOff})`}\nModel: ${s.model}\n${s.month}: ${s.spentUsd.toFixed(4)} of ${s.capUsd} USD (warn at ${s.warnUsd}), ${s.queued} queued`;
  }

  async cmd_newwidget(desc) {
    if (!desc) return "Usage: /newwidget <what it should show>";
    if (!this.agent.enabled) return `Widget drafting needs the agent, which is ${this.agent.reasonOff}.`;
    const r = await this.agent.draftWidget(desc);
    if (!r.ok) return r.text;
    if (!r.check.ok) return `Draft failed the safety check: ${r.check.problems.join(", ")}. Not saved.`;
    const id = newId("cw");
    this.store.update((s) => { s.pendingWidgets[id] = { name: desc.slice(0, 40), html: r.html, at: Date.now() }; }, { silent: true });
    return `Draft ${id} passed the check (${r.html.length} bytes). /approve ${id} to make it available, then /add ${id}.`;
  }

  cmd_approve(id) {
    const p = this.store.get().pendingWidgets[id];
    if (!p) return `No pending widget ${id}.`;
    this.store.update((s) => { s.customWidgets[id] = { ...p, approved: true }; delete s.pendingWidgets[id]; });
    return `Approved ${id}. /add ${id} to put it on the current layout.`;
  }

  cmd_status() {
    const s = this.store.get();
    const l = this.store.activeLayout();
    const online = this.hub.onlineDevices().length;
    const next = s.alarms.filter((a) => a.at).sort((a, b) => a.at - b.at)[0];
    const t = this.today();
    const nextB = s.birthdays.map((p) => ({ p, nb: parseYmd(p.birth) && nextBirthday(parseYmd(p.birth), t) })).filter((x) => x.nb).sort((a, b) => a.nb.days - b.nb.days)[0];
    const bdays = s.birthdays.length
      ? `Birthdays: ${s.birthdays.length}${nextB ? `, next ${nextB.p.name} ${nextB.nb.days === 0 ? "today" : `in ${nextB.nb.days} d`}` : ""}`
      : "Birthdays: none (/birthday)";
    return [
      `Hub up ${Math.round(process.uptime() / 60)} min`,
      `Phones online: ${online} of ${s.devices.length} paired`,
      `Layout: ${l.name} (${l.widgets.map((w) => w.type).join(", ")})`,
      bdays,
      `Weather: ${s.settings.city ? `${s.settings.city.name}${s.weather ? `, ${Math.round(s.weather.current.temp)}°C ${s.weather.current.text}` : ""}` : "no city (/city)"}`,
      `Alarms: ${s.alarms.length}${next ? `, next ${fmtWhen(next.at, s.settings.tz)} ${next.label}` : ""}`,
      `Agent: ${this.agent.enabled ? "on" : "off"}`,
      `Goodnight mode: ${goodnightModeOn(s.settings) ? "on" : "off"} · Quiet hours: ${(({ on, from, to }) => `${on ? "on" : "off"} ${from}-${to}`)(quietOf(s.settings))}`,
      this.dimLine(),
    ].join("\n");
  }

  // What dims the screen right now (both switches can at once).
  dimLine() {
    const d = dimNow(this.store, this.tz());
    const hm = (ms) => this.fmtIn(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const why = [d.goodnight && `goodnight until ${hm(d.goodnightUntil)}`, d.quiet && `quiet hours until ${quietOf(this.store.get().settings).to}`].filter(Boolean);
    if (why.length) return `Screen: dim (${why.join(" + ")})`;
    return d.wokeUntil ? `Screen: bright after a wake, quiet hours dim it again at ${hm(d.wokeUntil)}` : "Screen: bright";
  }
}
