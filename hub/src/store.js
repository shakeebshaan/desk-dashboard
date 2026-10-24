// State in one JSON file under data/ (gitignored). Writes are atomic (tmp + rename) and serialised.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export const WIDGET_TYPES = ["age", "clock", "weather", "alarms", "agent", "board", "countdown", "prayer", "photos", "quote", "ambient", "html", "verse", "moon", "sun"];
export const THEMES = ["aurora", "ember", "mono"];
export const CLOCK_STYLES = ["rings", "analogue", "flip", "minimal"];
// Animation level on the phone: full, calm (no particles, shake or tilt parallax), off. A layout's own `motion`
// field wins over this setting; the phone's system "reduce motion" switch wins over both.
export const MOTION_LEVELS = ["full", "calm", "off"];
// Widgets added 2026-10-24; existing layouts get them once (migrate).
export const NEW_WIDGETS_2 = ["prayer", "countdown", "board", "photos", "quote", "ambient"];
// Widgets added 2026-10-24 (second batch): verse of the day, moon phase, sunrise and sunset.
export const NEW_WIDGETS_3 = ["verse", "moon", "sun"];
export const MAX_PHOTOS = 24;
export const MAX_NOTES = 12;
export const MAX_TODOS = 30;

let seq = 0;
export const newId = (p) => `${p}${Date.now().toString(36).slice(-4)}${(seq++ % 1296).toString(36).padStart(2, "0")}`;

export const MAX_BIRTHDAYS = 20;
const sameName = (a, b) => a.toLocaleLowerCase() === b.toLocaleLowerCase();

// Older state kept one person in `child`; it moves into `birthdays`. Returns true when something changed.
export function migrate(st) {
  let changed = false;
  if (!Array.isArray(st.birthdays)) { st.birthdays = []; changed = true; }
  if ("child" in st) {
    const c = st.child;
    if (c && c.name && c.birth && !st.birthdays.some((b) => sameName(b.name, c.name))) st.birthdays.unshift({ name: c.name, birth: c.birth });
    delete st.child;
    changed = true;
  }
  const fill = { board: { notes: [], todos: [] }, events: [], islamic: null, prayer: null, night: null, quietWake: null, photos: [], adhan: null, target: "all", migrations: {}, verse: null };
  for (const [k, v] of Object.entries(fill)) if (!(k in st)) { st[k] = v; changed = true; }
  for (const [flag, types] of [["widgets2", NEW_WIDGETS_2], ["widgets3", NEW_WIDGETS_3]]) {
    if (st.migrations[flag]) continue;
    const layouts = st.layouts || [];
    const home = layouts.find((l) => l.id === "home") || layouts[0];
    if (home) {
      for (const type of types) {
        if (!home.widgets.some((w) => w.type === type)) home.widgets.push({ id: newId("w"), type });
      }
    }
    st.migrations[flag] = true;
    changed = true;
  }
  return changed;
}

// Adds a person, or updates the date (and spelling) of the one with the same name, ignoring case.
// tag (age.js BIRTHDAY_TAGS) picks the birthday screen: undefined keeps the saved one, "auto" clears it.
// birth null keeps the saved date (a tag-only update). -> "added" | "updated" | "full"
export function upsertBirthday(st, name, birth, tag) {
  const i = st.birthdays.findIndex((b) => sameName(b.name, name));
  const old = i >= 0 ? st.birthdays[i] : {};
  const t = tag === undefined ? old.tag : tag === "auto" ? undefined : tag;
  const entry = { name, birth: birth || old.birth, ...(t ? { tag: t } : {}) };
  if (i >= 0) { st.birthdays[i] = entry; return "updated"; }
  if (st.birthdays.length >= MAX_BIRTHDAYS) return "full";
  st.birthdays.push(entry);
  return "added";
}

// /birthday preview: that person's birthday screen on the phones for this long
export const PREVIEW_MS = 30 * 1000;

// -> the removed entry or null
export function removeBirthday(st, name) {
  const i = st.birthdays.findIndex((b) => sameName(b.name, name));
  return i >= 0 ? st.birthdays.splice(i, 1)[0] : null;
}

export function defaultState() {
  return {
    version: 1,
    settings: { tz: "Asia/Kolkata", theme: "aurora", city: null },
    birthdays: [], // [{ name, birth: "YYYY-MM-DD", tag? }], in the order they were added
    layouts: [
      {
        id: "home",
        name: "Home",
        cycleSeconds: 12,
        widgets: ["age", "clock", "weather", "alarms", "agent"].map((type, i) => ({ id: `w${i + 1}`, type })),
      },
    ],
    activeLayout: "home",
    alarms: [],
    customWidgets: {},
    pendingWidgets: {},
    devices: [],
    weather: null,
    agent: { month: "", spentUsd: 0, queue: [] },
    telegramOffset: 0,
  };
}

export class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, "state.json");
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.state = { ...defaultState(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      this.state = defaultState();
    }
    if (migrate(this.state)) this.save();
  }

  get() {
    return this.state;
  }

  // fn mutates the state in place; `silent` skips the phone broadcast (bookkeeping like the Telegram offset).
  update(fn, { silent = false } = {}) {
    const r = fn(this.state);
    this.save();
    if (!silent) this.emit("change", this.state);
    return r;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  activeLayout() {
    const s = this.state;
    return s.layouts.find((l) => l.id === s.activeLayout) || s.layouts[0];
  }

  // What the phone gets: no device token hashes, no Telegram bookkeeping, no agent queue.
  publicState() {
    const s = this.state;
    return {
      settings: s.settings,
      birthdays: s.birthdays,
      child: s.birthdays[0] || null, // app 0.2.0 and older read one person from here
      layouts: s.layouts,
      activeLayout: s.activeLayout,
      alarms: s.alarms,
      customWidgets: Object.fromEntries(
        Object.entries(s.customWidgets).filter(([, w]) => w.approved).map(([id, w]) => [id, { name: w.name, html: w.html }]),
      ),
      weather: s.weather,
      board: s.board,
      events: s.events,
      islamic: s.islamic,
      prayer: s.prayer,
      night: s.night,
      quietWake: s.quietWake && s.quietWake.until > Date.now() ? s.quietWake : null, // a tap/wake in quiet hours: bright until
      verse: s.verse, // today's verse (quran.js): Arabic + both translations; settings.verseLang picks one
      bdayPreview: s.bdayPreview && s.bdayPreview.until > Date.now() ? s.bdayPreview : null, // { name, until }
      // photo frame / adhan: ids only; the phone fetches the files (encrypted) and keeps them in memory
      photos: s.photos.map((p) => ({ id: p.id })),
      adhan: s.adhan ? { id: s.adhan.id } : null,
      agent: { enabled: !!this.agentEnabled },
      serverTime: Date.now(),
    };
  }
}
