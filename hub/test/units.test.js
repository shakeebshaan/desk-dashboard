import { test } from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Store, migrate, upsertBirthday, removeBirthday, MAX_BIRTHDAYS } from "../src/store.js";
import { Agent, monthKey } from "../src/agent.js";
import { checkWidgetHtml } from "../src/widgetcheck.js";
import { nextAt, parseHhmm, parseDuration, wallParts, zonedToEpoch } from "../src/time.js";
import { isOwnerMessage } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

const mockClient = (usage = { input_tokens: 100, output_tokens: 50 }, text = "It is sunny.") => {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(req); return { content: [{ type: "text", text }], usage, stop_reason: "end_turn" }; } } };
};

const keyFileWith = (text) => { const f = path.join(tmpDir(), "k.key"); fs.writeFileSync(f, text); return f; };
const missingKey = () => path.join(tmpDir(), "missing.key");
const mkAgent = (o = {}) => new Agent({ store: new Store(tmpDir()), enabled: true, keyFile: keyFileWith("sk-test-key\n"), model: "claude-haiku-5-5", capUsd: 10, warnUsd: 8, client: mockClient(), ...o });

test("key file missing -> 'Agent offline', no API call, phone state says off", async () => {
  const client = mockClient();
  const a = mkAgent({ keyFile: missingKey(), client });
  const r = await a.ask("hi");
  assert.deepEqual([r.ok, r.off, r.text], [false, true, "Agent offline."]);
  assert.equal(client.calls.length, 0);
  assert.match(a.status().reasonOff, /offline \(no key file yet\)/);
  assert.equal(a.store.publicState().agent.enabled, false);
  assert.deepEqual(await a.drainQueue(), []);
  // empty file = no key
  assert.equal(mkAgent({ keyFile: keyFileWith("\n") }).enabled, false);
  // switched off wins over a present key
  const off = mkAgent({ enabled: false, client });
  assert.match((await off.ask("hi")).text, /switched off/);
  assert.equal(client.calls.length, 0);
  // unpriced model -> off, the cap could not be enforced
  assert.equal(mkAgent({ model: "claude-unknown" }).enabled, false);
});

test("key file appearing later turns the agent on without a restart; the key never reaches state", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "dashboard-anthropic.key");
  const client = mockClient();
  const a = mkAgent({ keyFile: file, client });
  let pushes = 0;
  a.store.on("change", () => pushes++);
  assert.equal(a.enabled, false);
  fs.writeFileSync(file, "sk-secret-value\r\n");
  assert.equal(a.refresh(), true);
  assert.equal(a.enabled, true);
  assert.equal(pushes, 1, "phone gets the new on state");
  assert.equal((await a.ask("hi")).ok, true);
  assert.ok(!JSON.stringify(a.store.get()).includes("sk-secret"), "key not in stored state");
  assert.ok(!JSON.stringify(a.store.publicState()).includes("sk-secret"));
  assert.ok(!JSON.stringify(a.status()).includes("sk-secret"));
  fs.unlinkSync(file);
  a.refresh();
  assert.equal((await a.ask("hi")).text, "Agent offline.");
});

test("request: haiku, small max_tokens, thinking off, low effort", async () => {
  const client = mockClient();
  await mkAgent({ client }).ask("weather?");
  const req = client.calls[0];
  assert.equal(req.model, "claude-haiku-5-5");
  assert.equal(req.max_tokens, 300);
  assert.deepEqual(req.thinking, { type: "disabled" });
  assert.deepEqual(req.output_config, { effort: "low" });
});

test("spend guard: books real usage, warns once at 8 USD, refuses + queues at 10 USD", async () => {
  const warns = [];
  // each call bills 4.0 USD: 10M in * 0.10 + 6M out * 0.50 /1M = 1 + 3
  const client = mockClient({ input_tokens: 10_000_000, output_tokens: 6_000_000 });
  const a = mkAgent({ client, onWarn: (m) => warns.push(m) });
  const store = a.store;
  assert.equal((await a.ask("one")).ok, true);
  assert.ok(Math.abs(store.get().agent.spentUsd - 4) < 1e-9);
  assert.equal(warns.length, 0);
  assert.equal((await a.ask("two")).ok, true); // 8.0 -> warning
  assert.equal(warns.length, 1);
  assert.match(warns[0], /8\.00 of 10 USD/);
  assert.equal((await a.ask("three")).ok, true); // 12.0: pre-check passed on a tiny worst case; booked from usage
  assert.equal(warns.length, 1, "one warning per month");
  const r = await a.ask("four");
  assert.equal(r.capped, true);
  assert.match(r.text, /Monthly agent limit reached \(12\.00 of 10 USD\)/);
  assert.equal(client.calls.length, 3);
  assert.equal(store.get().agent.queue[0].question, "four");

  // cache tokens are billed too (write 1.25x, read 0.1x of input)
  const c2 = mockClient({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
  const b = mkAgent({ client: c2 });
  await b.ask("x");
  assert.ok(Math.abs(b.store.get().agent.spentUsd - 0.135) < 1e-9);

  // worst case of THIS call over the cap -> refused before calling
  const c3 = mockClient();
  const tight = mkAgent({ client: c3, capUsd: 0.0001 });
  assert.equal((await tight.ask("hi")).capped, true);
  assert.equal(c3.calls.length, 0);

  // new month: ledger and warning reset, queue drains
  store.get().agent.month = "1999-01";
  const drained = await a.drainQueue();
  assert.equal(store.get().agent.month, monthKey());
  assert.equal(drained.length, 1);
  assert.equal(store.get().agent.queue.length, 0);
});

test("config: key comes only from the key file path, never from env or the secrets .env", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "env-key-must-not-be-used";
  const a = mkAgent({ keyFile: missingKey(), client: undefined });
  assert.equal(a.enabled, false);
  assert.equal(a.client, null);
  if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  const cfg = loadConfig({ DASHBOARD_SECRETS: "C:/nonexistent.env", ANTHROPIC_API_KEY: "x", DASHBOARD_ANTHROPIC_API_KEY: "y" });
  assert.equal(cfg.agent.keyFile, path.join(os.homedir(), ".desk-dashboard", "dashboard-anthropic.key"));
  assert.equal(JSON.stringify(cfg).includes('"y"') || JSON.stringify(cfg).includes('"x"'), false);
  assert.deepEqual([cfg.agent.enabled, cfg.agent.model, cfg.agent.capUsd, cfg.agent.warnUsd], [true, "claude-haiku-5-5", 10, 8]);
  assert.equal(loadConfig({ DASHBOARD_SECRETS: "C:/nonexistent.env", DASHBOARD_AGENT_ENABLED: "0" }).agent.enabled, false);
});

test("widget check blocks network, storage, device APIs and frame escapes", () => {
  assert.equal(checkWidgetHtml("<!doctype html><style>b{color:red}</style><b>hi</b><script>let t=0;requestAnimationFrame(()=>t++)</script>").ok, true);
  const bad = {
    fetch: "<script>fetch('/x')</script>",
    xhr: "<script>new XMLHttpRequest()</script>",
    ws: "<script>new WebSocket('ws://x')</script>",
    img: "<img src='https://tracker.example/p.gif'>",
    css: "<style>body{background:url(https://x.example/a.png)}</style>",
    ext: "<script src='a.js'></script>",
    storage: "<script>localStorage.x=1</script>",
    mic: "<script>navigator.mediaDevices.getUserMedia({audio:true})</script>",
    top: "<script>top.location='x'</script>",
    eval: "<script>eval('1')</script>",
    iframe: "<iframe src='x'></iframe>",
  };
  for (const [k, html] of Object.entries(bad)) assert.equal(checkWidgetHtml(html).ok, false, k);
});

test("time helpers: next HH:MM in a zone, durations", () => {
  assert.deepEqual(parseHhmm("7:05"), { hh: 7, mm: 5, text: "07:05" });
  assert.equal(parseHhmm("24:00"), null);
  assert.equal(parseDuration("20m"), 20 * 60000);
  assert.equal(parseDuration("1h30m"), 90 * 60000);
  assert.equal(parseDuration("abc"), null);
  const tz = "Asia/Kolkata";
  const now = zonedToEpoch({ y: 2026, m: 10, d: 23, hh: 22, mm: 0 }, tz);
  assert.equal(new Date(now).toISOString(), "2026-10-23T16:30:00.000Z");
  const a = nextAt({ hh: 7, mm: 30 }, tz, now); // tomorrow morning
  assert.deepEqual(wallParts(a, tz), { y: 2026, m: 10, d: 24, hh: 7, mm: 30, ss: 0 });
  const b = nextAt({ hh: 23, mm: 0 }, tz, now); // later today
  assert.deepEqual(wallParts(b, tz), { y: 2026, m: 10, d: 23, hh: 23, mm: 0, ss: 0 });
  const c = nextAt({ hh: 9, mm: 0 }, "Europe/London", Date.UTC(2026, 9, 24, 12)); // across the 25 Oct DST change
  assert.deepEqual(wallParts(c, "Europe/London"), { y: 2026, m: 10, d: 25, hh: 9, mm: 0, ss: 0 });
});

test("owner gate", () => {
  const u = (from, chat, type = "private") => ({ message: { from: { id: from }, chat: { id: chat, type }, text: "x" } });
  assert.equal(isOwnerMessage(u(5, 5), "5"), true);
  assert.equal(isOwnerMessage(u(6, 6), "5"), false);
  assert.equal(isOwnerMessage(u(5, -10, "group"), "5"), false);
  assert.equal(isOwnerMessage(u(6, 5), "5"), false);
  assert.equal(isOwnerMessage(u(5, 5), ""), false, "no owner configured -> nobody");
  assert.equal(isOwnerMessage({ edited_message: {} }, "5"), false);
});

test("birthdays: old single `child` migrates into the list; add/update ignoring case; remove; cap", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ child: { name: "Lina", birth: "1994-06-11" }, alarms: [] }));
  const store = new Store(dir);
  assert.deepEqual(store.get().birthdays, [{ name: "Lina", birth: "1994-06-11" }]);
  assert.equal("child" in store.get(), false);
  assert.equal("child" in JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")), false, "migration saved");
  assert.deepEqual(new Store(dir).get().birthdays, [{ name: "Lina", birth: "1994-06-11" }], "idempotent");
  // the phone gets the list, and `child` = first person for app 0.2.0
  assert.deepEqual(store.publicState().child, { name: "Lina", birth: "1994-06-11" });

  const s = store.get();
  assert.equal(upsertBirthday(s, "Felix", "2023-12-20"), "added");
  assert.equal(upsertBirthday(s, "fELIX", "2023-12-21"), "updated");
  assert.deepEqual(s.birthdays[1], { name: "fELIX", birth: "2023-12-21" });
  assert.deepEqual(removeBirthday(s, "FELIX"), { name: "fELIX", birth: "2023-12-21" });
  assert.equal(removeBirthday(s, "FELIX"), null);
  for (let i = s.birthdays.length; i < MAX_BIRTHDAYS; i++) upsertBirthday(s, `P${i}`, "2000-01-01");
  assert.equal(upsertBirthday(s, "One more", "2000-01-01"), "full");
  assert.equal(upsertBirthday(s, "p5", "2001-01-01"), "updated", "updates still work when full");

  // a child already in the list is not duplicated; empty child just goes away
  const st = { child: { name: "LINA", birth: "1994-06-11" }, birthdays: [{ name: "Lina", birth: "1994-06-11" }] };
  migrate(st);
  assert.equal(st.birthdays.length, 1);
  const st2 = { child: null };
  assert.equal(migrate(st2), true);
  assert.deepEqual(st2.birthdays, []);
});
