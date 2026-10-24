// Hub entry point: store + phone server + Telegram bot + weather + agent (offline until its key file exists).
import path from "node:path";
import { loadConfig, ROOT } from "./config.js";
import { Store } from "./store.js";
import { Hub } from "./server.js";
import { Bot } from "./bot.js";
import { Telegram } from "./telegram.js";
import { Agent } from "./agent.js";
import { fetchWeather } from "./weather.js";
import { Relay } from "./relay.js";
import { UiPublisher } from "./ui.js";
import { CameraDesk } from "./camera.js";
import { SelfTestDesk } from "./selftest.js";
import { Media } from "./media.js";
import { fetchPrayer, fetchIslamicDays, DEFAULT_PRAYER } from "./islamic.js";
import { wallParts } from "./time.js";
import { goodnight, wake, phoneNightCommand, NIGHT_KEEP_MS } from "./nightmode.js";
const tzOf = (store) => store.get().settings.tz;
import { VerseKeeper } from "./quran.js";
import fs from "node:fs";
import crypto from "node:crypto";

// Local admin token for scripts/ui-push.mjs (made on first run, kept in the secrets folder).
function adminToken(file) {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

export async function startHub(cfg = loadConfig(), { agentClient, relayWS } = {}) {
  const store = new Store(cfg.dataDir);
  let bot = null;
  let tg = null;
  let ui = null; // UI pushes (needs the relay)
  let desk = null; // camera + /play (needs the relay and the bot)
  let tests = null; // the phone's error log and self-test (needs the relay)
  const media = new Media({ store, dir: path.join(cfg.dataDir, "media"), log });
  const tell = (msg) => { log(msg); if (tg) Promise.resolve(tg.send(cfg.ownerId, msg)).catch(() => {}); };
  const uiPush = async () => {
    if (!ui) throw new Error("UI pushes need the relay link");
    return ui.push();
  };
  const agent = new Agent({
    store, ...cfg.agent, client: agentClient, log,
    onWarn: (msg) => { log(msg); if (tg) Promise.resolve(tg.send(cfg.ownerId, msg)).catch((e) => log(`agent warn send: ${e.message}`)); },
  });

  // Said to the phone: "good night" / "wake up" work the night mode like the bot; anything else goes to the agent.
  const phoneAsk = async (text) => {
    const c = phoneNightCommand(text);
    if (c === "goodnight") {
      const r = goodnight(store, tzOf(store), null);
      if (!r) return { ok: true, text: "Goodnight mode is off." };
      return { ok: true, text: `Good night. The screen stays dim until ${r.wake}.` };
    }
    if (c === "wake") return { ok: true, text: wake(store, tzOf(store)).brightUntil ? "Bright for two minutes." : "Good morning." };
    return agent.ask(text, { source: "phone" }).catch((e) => ({ ok: false, text: `Agent error: ${e.message}` }));
  };

  const hub = new Hub({
    store,
    host: cfg.host,
    port: cfg.port,
    serveDir: cfg.serveApp ? path.join(ROOT, "app", "www") : null,
    log,
    onAsk: phoneAsk,
    onWake: () => wake(store, tzOf(store)),
    // A one-shot alarm that rang on the phone is removed; daily ones stay.
    onFired: (id) => store.update((s) => { s.alarms = s.alarms.filter((a) => !(a.id === id && a.at)); }),
    admin: cfg.ui ? { token: adminToken(cfg.ui.adminTokenFile), push: uiPush, status: () => (ui ? ui.status() : { error: "no relay" }),
      unpair: (id) => links.unpair(id) } : null, // same as /unpair <id> (links is set up below, before any request)
  });
  const addr = await hub.listen();
  log(`hub listening on http://${addr.address}:${addr.port} (agent ${agent.enabled ? "ON" : "off"})`);

  // Relay link (default): the phone and the hub only make outbound connections to the relay; every frame is
  // sealed end to end. The local listener above stays on 127.0.0.1 for the old app and browser development.
  const relay = cfg.relay && cfg.relay.enabled
    ? new Relay({
      store, base: cfg.relay.url, keyFile: cfg.relay.hubKeyFile, log, WS: relayWS,
      onAsk: phoneAsk,
    onWake: () => wake(store, tzOf(store)),
      onFired: (id) => store.update((s) => { s.alarms = s.alarms.filter((a) => !(a.id === id && a.at)); }),
      onUi: (id, m) => ui && ui.onUi(id, m),
      onHello: (id, m) => ui && ui.onHello(id, m).catch((e) => log(`ui: ${e.message}`)),
      onBlob: (id, m, att) => (m.kind === "selftest" || m.kind === "captures" ? tests && tests.onBlob(id, m, att) : desk && desk.onBlob(id, m, att)),
      onErr: (id, m) => tests && tests.onErr(id, m),
      onSelfTest: (id, m) => tests && tests.onSelfTest(id, m),
      onCam: (id, m) => desk && desk.onCam(id, m),
      // the phone asks for photo-frame / adhan files it does not hold in memory
      // the phone's performance reports, one JSON line each, for before/after comparisons
      onPerf: (id, p) => fs.promises.appendFile(path.join(cfg.dataDir, "perf.jsonl"), `${JSON.stringify({ dev: id, ...p })}\n`).catch(() => {}),
      onGet: async (id, ids) => {
        for (const fid of ids) {
          const f = media.read(fid);
          if (f) await relay.sendFile(id, { id: fid, kind: f.kind, mime: f.mime }, f.bytes).catch((e) => log(`relay: file ${fid}: ${e.message}`));
        }
      },
      uiPublic: () => (ui ? ui.publicKey : null),
      onPaired: (dev) => {
        if (tg) Promise.resolve(tg.send(cfg.ownerId, `📱 Paired ${dev.id} (${dev.name}).\nFingerprint: ${dev.fp}\nIt must match the fingerprint on the phone. If it does not, send /unpair ${dev.id}.`)).catch(() => {});
      },
    }).start()
    : null;
  log(relay ? `relay link via ${cfg.relay.url}` : "relay link off");
  if (relay) tests = new SelfTestDesk({ relay, tg: null, ownerId: cfg.ownerId, base: cfg.relay.url, store, dataDir: cfg.dataDir, captureDir: cfg.captureDir, log });
  if (relay && cfg.ui) {
    ui = new UiPublisher({ store, relay, srcDir: cfg.ui.srcDir, keyFile: cfg.ui.keyFile, dataDir: cfg.dataDir, log, notify: tell });
    log(`UI v${ui.version}, signing key ${ui.publicKey.slice(0, 8)}...`);
  }

  // What the bot sees: one set of phones, local and relay.
  const links = {
    newPairingCode: () => (relay ? relay.newPairingCode() : hub.newPairingCode()),
    newLocalPairingCode: () => hub.newPairingCode(),
    onlineDevices: () => [...hub.onlineDevices(), ...(relay ? relay.online() : [])],
    speak: (text, o = {}) => {
      const local = o.to ? 0 : hub.onlineDevices().length;
      if (!o.to) hub.speak(text, o);
      if (!relay) return local;
      relay.speak(text, o).catch((e) => log(`relay speak: ${e.message}`));
      return local + relay.online().filter((id) => !o.to || id === o.to).length;
    },
    unpair: async (id) => (relay && relay.devices().some((d) => d.id === id) ? relay.unpair(id) : hub.unpair(id)),
    uiPush,
    uiStatus: () => (ui ? ui.status() : null),
    selfTest: () => (tests ? tests.start() : "The self-test needs the relay link."),
    phoneErrors: (n) => (tests ? tests.latest(n) : "The error log needs the relay link."),
    camera: {
      start: (op, o) => (desk ? desk.start(op, o) : "The camera needs the relay link and the bot."),
      stop: () => (desk ? desk.stop() : "The camera needs the relay link and the bot."),
      play: (url) => (desk ? desk.play(url) : "/play needs the relay link and the bot."),
    },
    rotate: async () => {
      for (const d of store.get().devices.filter((x) => x.kind !== "relay")) hub.unpair(d.id);
      if (relay) await relay.rotate();
    },
  };

  // One-shot alarms more than 10 min in the past are dropped (the phone was off or missed them).
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    if (store.get().alarms.some((a) => a.at && a.at < cutoff)) store.update((s) => { s.alarms = s.alarms.filter((a) => !a.at || a.at >= cutoff); });
    // a finished night is dropped (the phone ends it at the wake time on its own clock; the margin covers a phone
    // in another zone than /tz)
    const n = store.get().night;
    if (n && (n.until || 0) + NIGHT_KEEP_MS <= Date.now()) store.update((s) => { s.night = null; });
  }, 60 * 1000);

  // Prayer times (today + tomorrow) when the day, the city or a /prayer setting changes; Islamic dates weekly or
  // when one has passed. Aladhan: free, no key.
  const ymdIn = (ms) => { const w = wallParts(ms, store.get().settings.tz); return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`; };
  const islamicOn = cfg.islamicEnabled ?? cfg.weatherEnabled;
  const islamicFetch = cfg.islamicFetch || fetch;
  const refreshIslamic = async ({ force = false } = {}) => {
    const s = store.get();
    const city = s.settings.city;
    if (!islamicOn || !city) return;
    const today = ymdIn(Date.now());
    const p = { ...DEFAULT_PRAYER, ...(s.settings.prayer || {}) };
    const key = `${city.lat},${city.lon},${p.method},${p.school},${today}`;
    if (force || !s.prayer || s.prayer.key !== key) {
      const pr = await fetchPrayer(city, p, today, ymdIn(Date.now() + 86400000), islamicFetch);
      store.update((x) => { x.prayer = { ...pr, key }; });
    }
    const isl = store.get().islamic;
    const stale = !isl || !isl.items || Date.now() - (isl.at || 0) > 7 * 86400000 || isl.items.some((i) => i.date < today);
    if (stale) {
      const items = await fetchIslamicDays(today, islamicFetch);
      store.update((x) => { x.islamic = { at: Date.now(), items }; });
    }
  };
  const islamicTimer = setInterval(() => refreshIslamic().catch((e) => log(`prayer/islamic: ${e.message}`)), 20 * 60 * 1000);
  refreshIslamic().catch((e) => log(`prayer/islamic: ${e.message}`));

  // Quran verse of the day (alquran.cloud, free, no key): checked every minute, fetched once per local date.
  const verse = new VerseKeeper({ store, today: () => ymdIn(Date.now()), fetchImpl: cfg.quranFetch || fetch, log });
  const quranOn = cfg.quranEnabled ?? cfg.weatherEnabled;
  const verseTimer = quranOn ? setInterval(() => verse.refresh(), 60 * 1000) : null;
  if (quranOn) verse.refresh();

  const refreshWeather = async () => {
    const city = store.get().settings.city;
    if (!cfg.weatherEnabled || !city) return;
    const w = await fetchWeather(city);
    store.update((s) => { s.weather = w; });
  };
  const weatherTimer = setInterval(() => refreshWeather().catch((e) => log(`weather: ${e.message}`)), 15 * 60 * 1000);
  refreshWeather().catch((e) => log(`weather: ${e.message}`));

  if (cfg.telegramEnabled && cfg.botToken && cfg.ownerId) {
    tg = new Telegram({ token: cfg.botToken, base: cfg.telegramApi, log });
    if (relay) desk = new CameraDesk({ relay, tg, ownerId: cfg.ownerId, base: cfg.relay.url, store, log });
    if (tests) tests.tg = tg;
    bot = new Bot({ store, hub: links, agent, ownerId: cfg.ownerId, send: (c, t) => tg.send(c, t), refreshWeather, log,
      refreshIslamic: () => refreshIslamic({ force: true }), media, verse, download: (fileId, max) => tg.download(fileId, max) });
    tg.poll({
      getOffset: () => store.get().telegramOffset,
      setOffset: (o) => store.update((s) => { s.telegramOffset = o; }, { silent: true }),
      onUpdate: (u) => bot.onUpdate(u),
    });
    log("telegram polling started");
  } else {
    log("telegram off (no token / owner id, or DASHBOARD_TELEGRAM=0)");
  }

  // The key file is re-read every minute: dropping it in (or removing it) flips the agent without a restart.
  const keyTimer = setInterval(() => agent.refresh(), 60 * 1000);

  // Month rollover: run questions that were queued by the spend cap.
  const drainTimer = setInterval(async () => {
    try {
      for (const q of await agent.drainQueue()) {
        if (q.source === "phone") hub.speak(q.answer.text, { from: "agent" });
        else if (tg) await tg.send(cfg.ownerId, `Queued question: ${q.question}\n\n${q.answer.text}`);
      }
    } catch (e) {
      log(`agent queue: ${e.message}`);
    }
  }, 60 * 60 * 1000);

  const stop = async () => {
    clearInterval(sweep);
    clearInterval(weatherTimer);
    clearInterval(islamicTimer);
    clearInterval(verseTimer);
    clearInterval(drainTimer);
    clearInterval(keyTimer);
    if (desk) desk.close();
    if (tests) tests.close();
    if (relay) relay.stop();
    if (tg) tg.stop();
    await hub.close();
  };
  return { store, hub, relay, links, bot, agent, stop, refreshWeather, refreshIslamic, media, verse, get ui() { return ui; }, get desk() { return desk; }, get tests() { return tests; } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  startHub().then(({ stop }) => {
    const bye = () => stop().finally(() => process.exit(0));
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
  }).catch((e) => {
    console.error("hub failed to start:", e.message);
    process.exit(1);
  });
}
