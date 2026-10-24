// Every example in the /help text goes through the real bot parsers; none may come back as a usage or error reply.
// The examples are read from the rendered HELP text (what the owner sees), plus the ones hidden because they equal
// the command itself, so the help can never drift from the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bot, HELP, HELP_SECTIONS } from "../src/bot.js";
import { splitMessage } from "../src/telegram.js";
import { Store } from "../src/store.js";
import { Media } from "../src/media.js";
import { tmpDir, OWNER } from "./helpers.js";

// Every error/usage reply the bot can give starts (or ends) like one of these.
const ERROR = /^(Usage|Unknown command|No |The list is full|Types:|Themes:|A layout needs|Couldn't|Pairing is locked|UI push(es need| failed)|Widget drafting needs|Draft failed|The camera|Could not|\/play needs)|exists\.$/;

function makeBot() {
  const cams = [];
  const store = new Store(tmpDir());
  // The help examples refer to ids from /alarms, /devices and /newwidget; they exist here as they would there.
  store.update((s) => {
    s.alarms.push({ id: "akx3m05", kind: "alarm", label: "x", time: "07:00", repeat: "daily" });
    s.devices.push({ id: "dkx3m07", name: "phone", kind: "relay", fp: "ab", pairedAt: Date.now() });
    s.pendingWidgets.cwkx3m09 = { name: "x", html: "<div>x</div>", at: Date.now() };
  });
  const hub = {
    speak: () => 1, onlineDevices: () => [], newPairingCode: () => "123456", newLocalPairingCode: () => "654321",
    rotate: async () => {}, unpair: async (id) => store.get().devices.some((d) => d.id === id),
    uiStatus: () => ({ version: 1, builtAt: null, phones: [] }), uiPush: async () => ({ v: 2, size: 4096, phones: 1 }),
    camera: {
      start: async (op, o) => { cams.push({ op, ...o }); return "ok " + op; },
      stop: async () => { cams.push({ op: "stop" }); return "Stopped"; },
      play: async (url) => { cams.push({ op: "play", url }); return "Playing"; },
    },
  };
  const agent = {
    enabled: true, reasonOff: "",
    ask: async () => ({ text: "Nothing on today." }),
    status: () => ({ enabled: true, model: "m", month: "2026-10", spentUsd: 0, capUsd: 5, warnUsd: 4, queued: 0 }),
    draftWidget: async () => ({ ok: true, html: "<div>Eid</div>", check: { ok: true, problems: [] } }),
  };
  const sent = [];
  // the photo-frame examples need a photo; /prayer needs today's times
  const media = new Media({ store, dir: tmpDir() });
  media.addPhoto(new Uint8Array([0xff, 0xd8, 1, 2]), { w: 800, h: 600 });
  const times = { fajr: "05:05", sunrise: "06:18", dhuhr: "12:07", asr: "16:19", maghrib: "17:55", isha: "19:08" };
  store.update((s) => {
    s.prayer = { city: "Testpur", methodName: "University of Islamic Sciences, Karachi", asr: "Hanafi",
      today: { date: "2026-10-24", times, hijri: "13 Jumada al-ula 1448 AH" }, tomorrow: { date: "2026-10-25", times, hijri: "" } };
  });
  const bot = new Bot({ store, hub, agent, ownerId: OWNER, send: async (_c, t) => sent.push(t), media,
    download: async () => new Uint8Array([0xff, 0xd8, 9]), geocode: async (name) => ({ name, country: "IN", lat: 19, lon: 72.8 }) });
  const say = async (text) => {
    const n = sent.length;
    await bot.onUpdate({ update_id: 1, message: { from: { id: +OWNER }, chat: { id: +OWNER, type: "private" }, text } });
    assert.equal(sent.length, n + 1, `no reply to ${text}`);
    return sent[n];
  };
  return { say, cams };
}

const shown = HELP.split("\n").filter((l) => l.startsWith("   e.g. ")).map((l) => l.slice(8));
const all = HELP_SECTIONS.flatMap((s) => s.lines.flatMap(([, ...ex]) => ex));

test("help: goes out whole in pieces under Telegram's 4096 limit, every section and command line has an example", () => {
  const parts = splitMessage(`Hi. ${HELP}`);
  assert.ok(parts.every((p) => p.length <= 4000) && parts.length <= 2, `${parts.length} parts`);
  assert.equal(parts.join("\n\n"), `Hi. ${HELP}`, "split only between sections, nothing lost");
  for (const s of HELP_SECTIONS) for (const [u, ...ex] of s.lines) assert.ok(ex.length >= 1, `no example for ${u}`);
  for (const e of shown) assert.ok(all.includes(e), `${e} is shown but not in HELP_SECTIONS`);
  assert.ok(shown.length >= 20);
});

test("help: every example runs through the bot without a usage or error reply", async () => {
  const { say } = makeBot();
  for (const ex of all) {
    const out = await say(ex);
    assert.ok(out && !ERROR.test(out), `${ex} -> ${out}`);
  }
});

test("help: /help and /start send the full list, /help <command> one section", async () => {
  const { say } = makeBot();
  assert.equal(await say("/help"), HELP);
  assert.ok((await say("/start")).endsWith(HELP));
  const alarm = await say("/help alarm");
  assert.match(alarm, /^⏰ ALARMS AND REMINDERS/);
  assert.match(alarm, /e\.g\. \/remind 20m Check the oven/);
  assert.doesNotMatch(alarm, /BIRTHDAYS/);
  assert.match(await say("/help /unpair"), /^📱 PHONES/);
  assert.match(await say("/help birthdays"), /^🎂 BIRTHDAYS/);
  assert.match(await say("/help nothing"), /^No help for "nothing"\. Sections: Speak, Birthdays/);
});

test("camera commands: arguments, limits and defaults reach the hub as asked", async () => {
  const { say, cams } = makeBot();
  await say("/snap");
  await say("/clip 30 back mute");
  await say("/clip");
  await say("/live 5 back");
  await say("/live");
  await say("/play https://youtu.be/abcdefghijk");
  assert.deepEqual(cams, [
    { op: "snap", facing: "front" },
    { op: "clip", facing: "back", secs: 30, audio: false },
    { op: "clip", facing: "front", secs: 15, audio: true },
    { op: "live", facing: "back", secs: 300, audio: false },
    { op: "live", facing: "front", secs: 120, audio: false },
    { op: "play", url: "https://youtu.be/abcdefghijk" },
  ]);
  for (const bad of ["/snap 5", "/snap sideways", "/clip 61", "/clip 0", "/live 11", "/live 2 mute", "/play http://x.test/v.mp4", "/play javascript:alert(1)", "/play"]) {
    assert.match(await say(bad), /^Usage: /, bad);
  }
  assert.equal(cams.length, 6);
});
