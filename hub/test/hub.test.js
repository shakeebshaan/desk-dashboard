// End-to-end in-process: real hub + fake Telegram API + WebSocket "phones". No real bot or network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "../src/index.js";
import { fakeTelegram, testConfig, phone, pairDevice, OWNER, STRANGER } from "./helpers.js";

let tg, cfg, h, base, wsUrl, sentCount = 0;

const say = async (text, from = OWNER, opts) => {
  tg.push(from, text, opts);
  return tg.waitSent(++sentCount);
};
const getCode = async () => /(\d{6})/.exec(await say("/pair"))[1];

before(async () => {
  tg = fakeTelegram();
  cfg = testConfig({ telegramApi: await tg.start() });
  h = await startHub(cfg);
  base = `http://127.0.0.1:${h.hub.port}`;
  wsUrl = `ws://127.0.0.1:${h.hub.port}/ws`;
});

after(async () => {
  await h.stop();
  await tg.close();
});

test("bot answers only the owner (strangers, groups and forged chats get nothing)", async () => {
  tg.push(STRANGER, "/status");
  tg.push(STRANGER, "hello phone, speak this");
  tg.push(OWNER, "/status", { chatId: -100123, chatType: "group" }); // owner, but in a group
  tg.push(STRANGER, "/pair", { chatId: OWNER }); // stranger pretending the chat is the owner's
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(tg.sent.length, 0, "no reply to anyone but the owner's private chat");
  const status = await say("/status");
  assert.match(status, /Hub up/);
  assert.equal(tg.sent[0].chat_id, OWNER);
});

test("pairing: wrong code refused, right code once, bad token refused", async () => {
  const code = await getCode();
  assert.equal((await pairDevice(base, "000000" === code ? "111111" : "000000")).status, 403);
  assert.equal((await pairDevice(base, code, "http://evil.example")).status, 403, "foreign origin");
  const ok = await pairDevice(base, code);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token.length >= 40);
  assert.equal((await pairDevice(base, code)).status, 403, "single use");
  const raw = JSON.stringify(h.store.get());
  assert.ok(!raw.includes(ok.body.token), "only the token hash is stored");

  const bad = phone(wsUrl, "not-a-token");
  await bad.hello();
  assert.equal(await bad.closed, 4001);
});

test("pairing locks after 5 wrong codes", async () => {
  const code = await getCode();
  const wrong = code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) assert.equal((await pairDevice(base, wrong)).status, 403);
  assert.equal((await pairDevice(base, code)).status, 429, "even the right code is refused while locked");
  h.hub.pairLockedUntil = 0;
});

test("speak text from the bot arrives on the phone, birthday and alarms update the phone's state", async () => {
  const { body } = await pairDevice(base, await getCode());
  const p = phone(wsUrl, body.token);
  await p.hello();
  await p.waitFor((m) => m.type === "state");

  assert.match(await say("Dinner is ready"), /Speaking on 1 phone/);
  const sp = await p.waitFor((m) => m.type === "speak");
  assert.equal(sp.text, "Dinner is ready");

  assert.match(await say("/say Time to go"), /Speaking/);
  await p.waitFor((m) => m.type === "speak" && m.text === "Time to go");

  assert.match(await say("/birthday Aria 2023-12-05"), /Saved\. Aria is \d+ years? \d+ months? \d+ days? today\.\n1 birthday saved/);
  await p.waitFor((m) => m.type === "state" && m.state.birthdays?.[0]?.birth === "2023-12-05" && m.state.child?.name === "Aria");
  assert.equal((await say("/birthday remove aria")).split(".")[0], "Removed Aria");

  assert.match(await say("/alarm 07:30 daily Wake up"), /every day at 07:30/);
  assert.match(await say("/remind 20m Drink water"), /Drink water/);
  const st = await p.waitFor((m) => m.type === "state" && m.state.alarms.length === 2);
  assert.ok(Math.abs(st.state.alarms[1].at - (Date.now() + 20 * 60000)) < 5000);
  assert.ok(!JSON.stringify(st.state).includes("tokenHash"), "device hashes never go to the phone");

  // one-shot alarm reported as fired is removed; daily stays
  p.ws.send(JSON.stringify({ type: "fired", id: st.state.alarms[1].id }));
  await p.waitFor((m) => m.type === "state" && m.state.alarms.length === 1);
  p.close();
});

test("birthdays: add many, update by name ignoring case, list with ages, remove, status", async () => {
  // the bot messages, in order: before, each replaced the last
  for (const [i, line] of ["Felix 2023-12-20", "Kian 2026-05-14", "Sam 1986-03-02", "Lina 1994-06-11"].entries()) {
    assert.match(await say(`/birthday ${line}`), new RegExp(`${i + 1} birthdays? saved`));
  }
  assert.deepEqual(h.store.get().birthdays.map((b) => b.name), ["Felix", "Kian", "Sam", "Lina"]);
  assert.match(await say("/birthday LINA 1994-06-12"), /^Updated\. LINA is .*\n4 birthdays saved/);
  assert.deepEqual(h.store.get().birthdays[3], { name: "LINA", birth: "1994-06-12" });
  const list = await say("/birthdays");
  assert.match(list, /^Birthdays \(4\):\n/);
  assert.match(list, /Felix - \d+ years? \d+ months? \d+ days? \(turns \d+ in \d+ days?\)/);
  assert.match(await say("/birthday Kabir 2099-01-01"), /Kabir is not born yet/);
  assert.match(await say("/birthdays"), /Kabir - not born yet/);
  assert.match(await say("/birthday remove kabir"), /^Removed Kabir\. 4 birthdays saved/);
  assert.match(await say("/birthday remove Nobody"), /No birthday for "Nobody"/);
  assert.match(await say("/birthday Felix 2024-02-30"), /^Usage/);
  assert.match(await say("/status"), /Birthdays: 4, next \w+ (today|in \d+ d)/);
  for (const n of ["felix", "kian", "sam", "lina"]) await say(`/birthday remove ${n}`);
  assert.match(await say("/birthdays"), /No birthdays saved/);
});

test("layouts and widgets: list, add, move, remove, new layout, switch", async () => {
  assert.match(await say("/layouts"), /▶ Home/);
  assert.match(await say("/add clock"), /15\. clock/); // the 5 first widgets + 6, then 3 more added on 2026-10-24
  assert.match(await say("/move 15 1"), /1\. clock/);
  assert.match(await say("/remove 1"), /^Home:\n1\. age/);
  assert.match(await say("/add nonsense"), /Types:/);
  assert.match(await say("/newlayout Night"), /▶ Night/);
  assert.equal(h.store.activeLayout().name, "Night");
  assert.match(await say("/layout home"), /▶ Home/);
  assert.match(await say("/cycle 8"), /8s/);
  assert.match(await say("/theme ember"), /ember/);
  assert.match(await say("/agent"), /OFF \(offline \(no key file yet\)\)/);
  assert.match(await say("/ask what time is it"), /^Agent offline\.$/);
  assert.match(await say("/newwidget a lava lamp"), /needs the agent/);
});

test("phone reconnects after a hub restart and still gets speech; queued speech is delivered on reconnect", async () => {
  const { body } = await pairDevice(base, await getCode());
  const port = h.hub.port;
  await h.stop();
  // restart on the same port and data dir, as the scheduled task would
  h = await startHub({ ...cfg, port });
  assert.match(await say("Hub came back"), /No phone online - queued/);
  const p = phone(wsUrl, body.token);
  await p.hello();
  const q = await p.waitFor((m) => m.type === "speak");
  assert.equal(q.text, "Hub came back", "queued while offline, delivered on reconnect");
  assert.match(await say("Second message"), /Speaking on 1 phone/);
  await p.waitFor((m) => m.type === "speak" && m.text === "Second message");
  p.close();
});

test("unpair closes the session", async () => {
  const { body } = await pairDevice(base, await getCode());
  const p = phone(wsUrl, body.token);
  await p.hello();
  await p.waitFor((m) => m.type === "state");
  const id = body.deviceId;
  assert.match(await say(`/unpair ${id}`), /Unpaired/);
  assert.equal(await p.closed, 4001);
});

test("birthday tags pick the screen, and /birthday preview reaches the phone's state for 30 s", async () => {
  for (const line of ["Ben 2023-11-28", "Leo 2026-05-12", "Omar 1985-02-08 head", "Maya 1994-06-09"]) await say(`/birthday ${line}`);
  assert.match(await say("/birthday Maya female"), /Birthday screen: elegant \(tag female\)/);
  assert.equal(h.store.get().birthdays.find((b) => b.name === "Maya").birth, "1994-06-09", "a tag-only update keeps the date");
  assert.match(await say("/birthday Maya 1994-06-10"), /elegant \(tag female\)/, "a date update keeps the tag");
  assert.match(await say("/birthdays"), /Omar \(head\)/);
  assert.match(await say("/birthday Ben 2023-11-28 wizard"), /^Unknown tag "wizard"/);
  assert.match(await say("/birthday Leo auto"), /newborn \(by age\)/);
  const out = await say("/birthday preview omar");
  assert.match(out, /Showing Omar's birthday screen \(head of the family\) for 30 s/);
  const pv = h.store.publicState().bdayPreview;
  assert.equal(pv.name, "Omar");
  assert.ok(Math.abs(pv.until - Date.now() - 30000) < 3000);
  assert.match(await say("/birthday preview Nobody"), /^No birthday for "Nobody"/);
  assert.match(await say("/birthday preview"), /^Usage: \/birthday preview <name>/);
  for (const n of ["Ben", "Leo", "Omar", "Maya"]) await say(`/birthday remove ${n}`);
});
