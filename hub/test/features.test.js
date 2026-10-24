// The 2026-10-24 features: family board, countdowns (own events + Islamic dates), prayer times and their alarms,
// weather now (umbrella), photo frame + adhan files to the phone, clock styles, night mode, several phones.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveObjectURL } from "node:buffer";
import nacl from "tweetnacl";
import * as L from "../../app/www/app/src/securelink.js";
import { pairViaRelay, RelayLink } from "../../app/www/app/src/relaylink.js";
import { parseEvent, nextOccurrence, countdownText, upcoming, wallFromParts } from "../../app/www/app/src/events.js";
import { prayerBoard, duePrayers } from "../../app/www/app/src/prayer.js";
import { FileCache } from "../../app/www/app/src/files.js";
import { wallParts } from "../src/time.js";
import { umbrellaOf } from "../src/weather.js";
import { fetchPrayer, fetchIslamicDays, pace } from "../src/islamic.js";

pace.gapMs = 0; // tests: no pause between fake Aladhan calls
import { startHub } from "../src/index.js";
import { fakeNtfy } from "./fakeNtfy.js";
import { fakeTelegram, testConfig, tmpDir, OWNER } from "./helpers.js";
import { fakeAladhan } from "./fakeAladhan.js";

L.useNacl(nacl);

const W = (y, m, d, hh = 0, mm = 0) => wallFromParts({ y, m, d, hh, mm });
const until = async (fn, ms = 6000, what = "condition") => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ---------- pure parts ----------
test("events: parse the forms, refuse junk", () => {
  assert.deepEqual(parseEvent("Tuesday 11:00 Work").ev, { kind: "weekly", name: "Work", weekday: 2, time: "11:00" });
  assert.deepEqual(parseEvent("every fri Jummah").ev, { kind: "weekly", name: "Jummah", weekday: 5 });
  assert.deepEqual(parseEvent("2026-12-25 Trip").ev, { kind: "once", name: "Trip", date: "2026-12-25" });
  assert.deepEqual(parseEvent("2026-12-25 7:30 Flight").ev, { kind: "once", name: "Flight", date: "2026-12-25", time: "07:30" });
  assert.deepEqual(parseEvent("yearly 03-15 Anniversary").ev, { kind: "yearly", name: "Anniversary", md: "03-15" });
  assert.deepEqual(parseEvent("daily 07:30 School run").ev, { kind: "daily", name: "School run", time: "07:30" });
  for (const bad of ["", "Tuesday", "2026-02-30 Trip", "yearly 13-01 X", "daily School", "someday Trip", "2026-12-25"]) assert.equal(parseEvent(bad).ok, false, bad);
});

test("events: next occurrence and countdown text", () => {
  const sat = W(2026, 10, 24, 10, 0); // Saturday 24 Oct 2026 10:00
  const wk = parseEvent("Tuesday 11:00 Work").ev;
  assert.equal(nextOccurrence(wk, sat).at, W(2026, 10, 27, 11, 0));
  assert.equal(nextOccurrence(wk, W(2026, 10, 27, 11, 1)).at, W(2026, 11, 3, 11, 0), "just missed -> next week");
  assert.equal(nextOccurrence(parseEvent("Saturday Market").ev, W(2026, 10, 24, 23, 0)).at, W(2026, 10, 24), "all-day counts until the day ends");
  assert.equal(nextOccurrence(parseEvent("2026-10-23 Gone").ev, sat), null);
  assert.equal(nextOccurrence(parseEvent("yearly 03-15 A").ev, sat).at, W(2027, 3, 15));
  assert.equal(nextOccurrence(parseEvent("daily 09:00 Walk").ev, sat).at, W(2026, 10, 25, 9, 0));
  assert.equal(countdownText(W(2026, 10, 24), sat, true), "today");
  assert.equal(countdownText(W(2026, 10, 25), sat, true), "tomorrow");
  assert.equal(countdownText(W(2026, 12, 25), sat, true), "in 62 days");
  assert.equal(countdownText(W(2026, 10, 24, 12, 30), sat, false), "in 2 h 30 m");
  assert.equal(countdownText(W(2026, 10, 25, 13, 0), sat, false), "in 1 day 3 h");
  const list = upcoming({ events: [wk, parseEvent("2026-12-25 Trip").ev], islamic: [{ name: "Eid al-Fitr", date: "2027-03-09", hijri: "1 Shawwal 1448" }] }, sat);
  assert.deepEqual(list.map((x) => x.name), ["Work", "Trip", "Eid al-Fitr"]);
  assert.equal(list[2].kind, "islamic");
});

test("prayer board: next prayer, after Isha it is tomorrow's Fajr, alarms fire once in their minute", () => {
  const times = { fajr: "05:05", sunrise: "06:18", dhuhr: "12:07", asr: "16:19", maghrib: "17:55", isha: "19:08" };
  const pr = { today: { date: "2026-10-24", times }, tomorrow: { date: "2026-10-25", times: { ...times, fajr: "05:06" } } };
  const b = prayerBoard(pr, W(2026, 10, 24, 13, 0));
  assert.equal(b.next.key, "asr");
  assert.deepEqual(b.list.filter((p) => p.past).map((p) => p.key), ["fajr", "dhuhr"]);
  const late = prayerBoard(pr, W(2026, 10, 24, 21, 0));
  assert.deepEqual([late.next.key, late.next.tomorrow, late.next.time], ["fajr", true, "05:06"]);
  const fired = new Set();
  const al = { asr: "chime", isha: "off" };
  assert.deepEqual(duePrayers(pr, al, W(2026, 10, 24, 16, 18), fired), []);
  const due = duePrayers(pr, al, W(2026, 10, 24, 16, 19) + 20000, fired);
  assert.deepEqual(due.map((p) => [p.key, p.mode]), [["asr", "chime"]]);
  fired.add(due[0].fired);
  assert.deepEqual(duePrayers(pr, al, W(2026, 10, 24, 16, 19) + 40000, fired), [], "once");
  assert.deepEqual(duePrayers(pr, al, W(2026, 10, 24, 19, 8), fired), [], "off stays quiet");
  assert.equal(prayerBoard(pr, W(2026, 10, 27, 12, 0)), null, "no data for that day");
});

test("weather: umbrella flag", () => {
  const h = (p) => ({ time: p.map((_, i) => `2026-10-24T${String(10 + i).padStart(2, "0")}:00`), precipitation_probability: p });
  assert.deepEqual(umbrellaOf(h([0, 10, 70, 20]), 1), { yes: true, why: "70% rain around 12:00" });
  assert.equal(umbrellaOf(h([0, 10, 40]), 1).yes, false);
  assert.deepEqual(umbrellaOf(h([0]), 63), { yes: true, why: "raining now" });
});

test("aladhan: Karachi + Hanafi by default, method/school in the query, Islamic days on or after today", async () => {
  const a = fakeAladhan();
  const pr = await fetchPrayer({ name: "Testpur", lat: 48.2, lon: 16.4 }, {}, "2026-10-24", "2026-10-25", a.fetchImpl);
  assert.match(a.calls[0], /method=1&school=1/);
  assert.equal(pr.today.times.isha, "19:08", "the (IST) suffix is cut");
  assert.equal(pr.methodName, "University of Islamic Sciences, Karachi");
  assert.equal(pr.asr, "Hanafi");
  const days = await fetchIslamicDays("2026-10-24", a.fetchImpl);
  assert.ok(days.length >= 9 && days.every((d) => d.date >= "2026-10-24"));
  assert.ok(days.some((d) => d.name === "Eid al-Fitr" && /Shawwal 1448/.test(d.hijri)));
  assert.deepEqual([...days].sort((x, y) => (x.date < y.date ? -1 : 1)), days, "sorted");
});

test("aladhan: a 429 (rate limit) is retried after a pause, calls go out one at a time", async () => {
  const a = fakeAladhan();
  let n = 0, inFlight = 0, maxInFlight = 0;
  const flaky = async (url) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (n++ === 0) return new Response("{}", { status: 429 });
    return a.fetchImpl(url);
  };
  const old = pace.retryMs;
  pace.retryMs = 20;
  try {
    const pr = await fetchPrayer({ name: "Testpur", lat: 48.2, lon: 16.4 }, {}, "2026-10-24", "2026-10-25", flaky);
    assert.equal(pr.today.times.fajr, "05:05");
    assert.equal(maxInFlight, 1, "never two at once");
  } finally {
    pace.retryMs = old;
  }
});

// ---------- through the hub, the bot and a phone ----------
async function setup() {
  const relay = await fakeNtfy();
  const tg = fakeTelegram();
  const al = fakeAladhan();
  const cfg = testConfig({ telegramApi: await tg.start(), islamicEnabled: true, islamicFetch: al.fetchImpl,
    relay: { enabled: true, url: relay.base, hubKeyFile: path.join(tmpDir(), "hub.key") } });
  const h = await startHub(cfg);
  let n = 0;
  const bot = async (text) => { tg.push(OWNER, text); return tg.waitSent(++n, 8000); };
  const raw = async (message) => { tg.pushRaw(OWNER, message); return tg.waitSent(++n, 8000); };
  const close = async () => { await h.stop(); await relay.close(); await tg.close(); };
  return { relay, tg, h, bot, raw, al, cfg, close, skip: () => n++ };
}

async function phone(s, name = "phone", status = { bat: 77, chg: true, net: "wifi", app: "0.3.2" }) {
  const code = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})/.exec(await s.bot("/pair"))[1];
  const paired = await pairViaRelay({ base: s.relay.base, code, name, timeoutMs: 5000 });
  await s.tg.waitSent(s.skip() + 1, 4000); // "Paired ... fingerprint"
  const got = [];
  let state = null;
  const link = new RelayLink({ cfg: paired.cfg, secretKey: paired.secretKey, getState: () => state, getStatus: () => status });
  const ready = [];
  const files = new FileCache({ post: (m) => link.post(m), onReady: (id) => ready.push(id) });
  link.addEventListener("message", (e) => {
    got.push(e.detail);
    if (e.detail.type === "state") state = e.detail.state;
    if (e.detail.type === "file") files.add(e.detail);
  });
  link.start();
  await until(() => state, 5000, "first snapshot");
  return { link, got, files, ready, id: paired.cfg.id, state: () => state, stop: () => link.stop() };
}

test("family board: notes and to-dos from the bot reach the phone and stay until cleared", async () => {
  const s = await setup();
  try {
    const p = await phone(s);
    assert.match(await s.bot("/note Pick up the dry cleaning"), /On the board/);
    assert.match(await s.bot("/todo add Buy milk"), /⬜ 1\. Buy milk/);
    await s.bot("/todo add Call the plumber");
    assert.match(await s.bot("/todo done 1"), /✅ 1\. Buy milk/);
    assert.match(await s.bot("/todo done 9"), /No item 9/);
    assert.match(await s.bot("/board"), /📝 Pick up the dry cleaning[\s\S]*1\. ✅ Buy milk\n2\. ⬜ Call the plumber/);
    await until(() => p.state().board && p.state().board.todos.length === 2 && p.state().board.todos[0].done, 6000, "board on the phone");
    assert.equal(p.state().board.notes[0].text, "Pick up the dry cleaning");
    await s.bot("/todo clear");
    await s.bot("/note clear");
    await until(() => !p.state().board.todos.length && !p.state().board.notes.length, 6000, "cleared on the phone");
    p.stop();
  } finally {
    await s.close();
  }
});

test("countdowns and prayer times: /event, /events with Islamic dates, /prayer settings refetch, alarms reach the phone", async () => {
  const s = await setup();
  try {
    const p = await phone(s);
    // a stand-in city, set the way /city does (no geocoding call from a test)
    s.h.store.update((st) => { st.settings.city = { name: "Testpur", country: "AT", lat: 48.2, lon: 16.4 }; });
    await s.h.refreshIslamic();
    await until(() => s.h.store.get().prayer && s.h.store.get().islamic, 6000, "prayer + islamic fetched");
    assert.match(await s.bot("/event Tuesday 11:00 Work"), /📅 Work \(every Tuesday\): next Tue \d+ \w+ 11:00, in /);
    assert.match(await s.bot("/event 2099-12-25 Trip"), /Trip: next Fri 25 Dec, in \d+ days/);
    assert.match(await s.bot("/event 1999-01-01 Old"), /that date has passed/);
    assert.match(await s.bot("/event remove 3"), /Removed Old/);
    const ev = await s.bot("/events");
    assert.match(ev, /1\. Work \(every Tuesday\)[\s\S]*2\. Trip/);
    assert.match(ev, /Islamic dates \(calculated; may move a day with the moon sighting\)\n🌙 /);
    assert.match(await s.bot("/event sometime Party"), /^Usage:/);
    const pr = await s.bot("/prayer");
    assert.match(pr, /🕌 Testpur[\s\S]*Fajr 05:05[\s\S]*Isha 19:08[\s\S]*Karachi · Asr: Hanafi/);
    const before = s.al.calls.length;
    assert.match(await s.bot("/prayer method mwl"), /Muslim World League/);
    assert.match(s.al.calls.slice(before).join(" "), /method=3&school=1/, "refetched with the new method");
    assert.match(await s.bot("/prayer asr shafi"), /Shafi'i/);
    assert.match(s.al.calls.at(-1), /method=3&school=0/);
    assert.match(await s.bot("/prayer method moon"), /^Methods:/);
    assert.match(await s.bot("/prayer alarm fajr chime"), /Fajr: chime/);
    assert.match(await s.bot("/prayer alarm all adhan"), /Every prayer: adhan\. No adhan recording yet/);
    await until(() => p.state().prayer && p.state().islamic && p.state().events.length === 2 && p.state().settings.prayer.alarms.isha === "adhan", 6000, "on the phone");
    assert.equal(p.state().prayer.today.times.fajr, "05:05");
    p.stop();
  } finally {
    await s.close();
  }
});

test("photo frame + adhan: Telegram files are kept on the hub only and reach the phone encrypted, into memory", async () => {
  const s = await setup();
  try {
    const p = await phone(s);
    const jpg = Uint8Array.from({ length: 120000 }, (_, i) => (i * 13) & 255);
    jpg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    s.tg.blobs.set("big", { bytes: Uint8Array.from({ length: 4000000 }), path: "photos/big.jpg" });
    s.tg.blobs.set("ok", { bytes: jpg, path: "photos/ok.jpg" });
    const reply = await s.raw({ photo: [{ file_id: "small", width: 90, height: 60 }, { file_id: "ok", width: 1280, height: 853 }, { file_id: "big", width: 2560, height: 1706 }] });
    assert.match(reply, /Added to the photo frame \(1 photo\)\. Kept only on the hub/);
    const ph = s.h.store.get().photos[0];
    assert.deepEqual([ph.w, ph.h], [1280, 853], "largest size up to 1280 px");
    assert.deepEqual(s.h.media.read(ph.id).bytes, jpg);
    // the phone sees the id, asks for the file, gets it encrypted, holds it as a blob: URL
    await until(() => p.state().photos.length === 1, 6000, "photo id on the phone");
    p.files.want(p.state().photos.map((x) => x.id));
    await until(() => p.ready.includes(ph.id), 8000, "photo in the phone's memory");
    const blob = resolveObjectURL(p.files.url(ph.id));
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), jpg);
    const att = s.relay.messages.filter((m) => m.attachment && m.topic !== undefined && m.message.startsWith("d1."));
    assert.ok(att.length >= 1 && [...s.relay.files.values()].every((b) => b[0] !== 0xff || b[1] !== 0xd8), "relay held ciphertext only");
    // asking again within 10 min sends nothing
    const sentBefore = s.relay.messages.length;
    await p.link.post({ t: "get", ids: [ph.id] });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.relay.messages.filter((m) => m.attachment).length, att.length, "no resend");
    assert.ok(s.relay.messages.length >= sentBefore);
    // adhan: an audio file with the caption "adhan"
    s.tg.blobs.set("aud", { bytes: Uint8Array.from({ length: 50000 }, (_, i) => i & 255), path: "music/adhan.mp3" });
    assert.match(await s.raw({ audio: { file_id: "aud", mime_type: "audio/mpeg" }, caption: "Adhan" }), /Adhan recording saved \(49 KB\)/);
    assert.match(await s.bot("/adhan"), /Adhan recording: 49 KB/);
    // an audio file without the caption is not taken; neither is a photo from a stranger
    assert.match(await s.bot("/photos"), /Photo frame: 1 of 24\n1\. \d{4}-\d\d-\d\d 1280x853/);
    assert.match(await s.bot("/photo remove 1"), /Removed photo 1/);
    assert.equal(s.h.media.read(ph.id), null, "file deleted from the hub");
    await until(() => p.state().photos.length === 0, 6000, "gone from the phone's state");
    p.files.want([]);
    assert.equal(p.files.url(ph.id), null, "and from the phone's memory");
    p.stop();
  } finally {
    await s.close();
  }
});

test("clock style, night mode (goodnight in any case, /wake), several phones with status and /use", async () => {
  const s = await setup();
  try {
    const a = await phone(s, "kitchen", { bat: 81, chg: true, net: "wifi", app: "0.3.2" });
    const b = await phone(s, "hall", { bat: 34, chg: false, net: "cellular", app: "0.3.2" });
    assert.match(await s.bot("/clockstyle analog"), /analogue/);
    assert.match(await s.bot("/clockstyle neon"), /^Usage/);
    assert.match(await s.bot("/motion"), /^Motion: full\./);
    assert.match(await s.bot("/motion CALM"), /Motion: calm/);
    assert.match(await s.bot("/motion wild"), /^Usage/);
    assert.equal(s.h.store.publicState().settings.motion, "calm");
    // quiet hours (01:00-07:00 by default) are off here, so the run does not depend on the real time of day
    assert.match(await s.bot("/quiethours"), /^Quiet hours: on, 01:00-07:00\./);
    assert.match(await s.bot("/quiethours off"), /Quiet hours off/);
    assert.match(await s.bot("GoodNight!"), /🌙 Good night\. The dashboard shows a dim clock until/);
    assert.match(await s.bot("/status"), /Goodnight mode: on · Quiet hours: off 01:00-07:00\nScreen: dim \(goodnight until 07:00\)/);
    const n = s.h.store.get().night;
    const w = wallParts(n.until, "Asia/Kolkata");
    assert.equal(`${w.hh}:${w.mm}`, "7:0", "dim until 07:00 local, not a fixed 6 h");
    assert.ok(n.until - Date.now() > 0 && n.until - Date.now() <= 24 * 3600e3 && n.wake === "07:00" && typeof n.since === "number");
    await until(() => a.state().night && b.state().night && a.state().settings.clockStyle === "analogue", 6000, "night on both phones");
    assert.match(await s.bot("/wake"), /Good morning/);
    await until(() => a.state().night === null, 6000, "awake");
    assert.match(await s.bot("/goodnight 6:30"), /Good night\. .* until .*06:30 \(wake time is now 06:30\)/);
    assert.equal(s.h.store.get().settings.wakeTime, "06:30");
    assert.match(await s.bot("/goodnight 25:00"), /^Usage: \/goodnight/);
    // a tap on the phone's screen ends it for every phone
    a.link.send({ type: "wake" });
    await until(() => s.h.store.get().night === null, 6000, "tap woke the hub");
    await until(() => b.state().night === null, 6000, "and the other phone");
    // said to the phone: "good night" dims (without the agent), "good morning" wakes
    a.link.send({ type: "ask", text: "Good night" });
    await until(() => a.got.some((m) => m.type === "speak" && /Good night\. The screen stays dim until 06:30/.test(m.text)), 6000, "goodnight by voice");
    assert.ok(s.h.store.get().night && s.h.store.get().night.wake === "06:30");
    a.link.send({ type: "ask", text: "good morning" });
    await until(() => s.h.store.get().night === null, 6000, "good morning by voice");
    // the goodnight switch: off -> goodnight does nothing (by text, command or voice)
    assert.match(await s.bot("/goodnightmode off"), /Goodnight mode off/);
    assert.match(await s.bot("goodnight"), /Goodnight mode is off, so goodnight does nothing/);
    assert.equal(s.h.store.get().night, null);
    assert.match(await s.bot("/goodnightmode"), /^Goodnight mode is off\./);
    assert.match(await s.bot("/goodnightmode maybe"), /Usage: \/goodnightmode on\|off/);
    assert.match(await s.bot("/goodnightmode on"), /Goodnight mode on/);
    // quiet hours: new times, bad input, and what /status says
    assert.match(await s.bot("/quiethours 23:30 6:30"), /Quiet hours on: dim every night 23:30-06:30/);
    assert.deepEqual(s.h.store.get().settings.quiet, { on: true, from: "23:30", to: "06:30" });
    assert.match(await s.bot("/quiethours 02:00 02:00"), /must differ/);
    assert.match(await s.bot("/quiethours 25:00 07:00"), /^Usage: \/quiethours/);
    assert.match(await s.bot("/status"), /Goodnight mode: on · Quiet hours: on 23:30-06:30\nScreen: (bright|dim \(quiet hours until 06:30\))/);
    await until(() => a.state().settings.quiet && a.state().settings.quiet.from === "23:30", 6000, "quiet hours reach the phone");
    assert.match(await s.bot("/quiethours 01:00 07:00"), /01:00-07:00/);
    // /devices: both phones, battery, charging, network, app
    await until(() => s.h.store.get().devices.every((d) => d.status), 6000, "status from the hellos");
    const dv = await s.bot("/devices");
    assert.match(dv, new RegExp(`🟢 ${a.id} kitchen\\n   🔋 81% charging · 📶 Wi-Fi · app 0\\.3\\.2`));
    assert.match(dv, new RegExp(`🟢 ${b.id} hall\\n   🔋 34% on battery · 📡 mobile data`));
    // /use: speech goes to one phone only
    assert.match(await s.bot("/use hall"), new RegExp(`now go to hall \\(${b.id}\\)`));
    await s.bot("Dinner is ready");
    await until(() => b.got.some((m) => m.type === "speak" && m.text === "Dinner is ready"), 6000, "spoken on hall");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!a.got.some((m) => m.type === "speak" && m.text === "Dinner is ready"), "not on kitchen");
    assert.match(await s.bot("/name " + a.id + " Kitchen Shelf"), /is now called Kitchen Shelf/);
    assert.match(await s.bot("/use all"), /every phone/);
    await s.bot("Tea time");
    await until(() => a.got.some((m) => m.text === "Tea time") && b.got.some((m) => m.text === "Tea time"), 6000, "spoken on both");
    a.stop();
    b.stop();
  } finally {
    await s.close();
  }
});
