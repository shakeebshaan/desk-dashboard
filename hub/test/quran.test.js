// Verse of the day (hub/src/quran.js): the source's text kept as is, one verse per local date, cached, a new one after
// midnight, a failed fetch keeps the old one. A stand-in for api.alquran.cloud answers in its real format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verseCandidates, fetchVerse, verseOfDay, VerseKeeper, EDITIONS, MAX_ARABIC, TOTAL_AYAHS } from "../src/quran.js";
import { Store } from "../src/store.js";
import { tmpDir } from "./helpers.js";

// fake api.alquran.cloud: verse n is in surah 2, ayah n+1; n = 100 is long (does not fit), n = 7 is ayah 1 of a surah
function fakeApi({ fail = false, long = [100], first = [7] } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (fail) return { ok: false, status: 503 };
    const m = /\/ayah\/(\d+)\/editions\/([\w.,-]+)$/.exec(url);
    const n = +m[1];
    const surah = { number: first.includes(n) ? 3 : 2, name: "سُورَةُ البَقَرَةِ", englishName: "Al-Baqara", englishNameTranslation: "The Cow" };
    const ayah = first.includes(n) ? 1 : n + 1;
    const text = { [EDITIONS.ar]: long.includes(n) ? "ب".repeat(MAX_ARABIC + 1) : `آية ${n}`, [EDITIONS.en]: `English ${n}`, [EDITIONS.ur]: `اردو ${n}` };
    const names = { [EDITIONS.ar]: "Uthmani", [EDITIONS.en]: "Saheeh International", [EDITIONS.ur]: "Jalandhry" };
    return { ok: true, status: 200, json: async () => ({ code: 200, status: "OK",
      data: m[2].split(",").map((id) => ({ number: n, text: text[id], edition: { identifier: id, englishName: names[id] }, surah, numberInSurah: ayah })) }) };
  };
  f.calls = calls;
  return f;
}

test("candidates: a fixed list per date, in range, different on the next day", () => {
  const a = verseCandidates("2026-10-24");
  assert.deepEqual(a, verseCandidates("2026-10-24"), "same date -> same verse after a restart");
  assert.notDeepEqual(a, verseCandidates("2026-10-25"));
  for (const n of [...a, ...verseCandidates("2027-02-28")]) assert.ok(Number.isInteger(n) && n >= 1 && n <= TOTAL_AYAHS);
  assert.ok(new Set(Array.from({ length: 60 }, (_, i) => verseCandidates(`2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`)[0])).size > 50);
});

test("fetchVerse: Arabic (Uthmani) and both named translations exactly as the source sends them", async () => {
  const api = fakeApi();
  const v = await fetchVerse(5, api);
  assert.match(api.calls[0], /\/ayah\/5\/editions\/quran-uthmani,en\.sahih,ur\.jalandhry$/);
  assert.equal(v.arabic, "آية 5");
  assert.deepEqual(v.tr.en, { text: "English 5", name: "Saheeh International", id: "en.sahih" });
  assert.equal(v.tr.ur.text, "اردو 5");
  assert.deepEqual([v.surah.englishName, v.surah.number, v.ayah], ["Al-Baqara", 2, 6]);
  await assert.rejects(fetchVerse(5, async () => ({ ok: true, json: async () => ({ code: 200, data: [] }) })), /unexpected answer/);
});

test("verseOfDay: skips a verse too long for the card and a Bismillah-prefixed first verse", async () => {
  const cands = verseCandidates("2026-10-24");
  // the first candidate is too long, the second is an ayah 1: the third is chosen
  const v = await verseOfDay("2026-10-24", fakeApi({ long: [cands[0]], first: [cands[1]] }));
  assert.equal(v.date, "2026-10-24");
  assert.equal(v.n, cands[2]);
});

test("VerseKeeper: fetched once per local date, cached all day, new after midnight, a failure keeps the old verse", async () => {
  const store = new Store(tmpDir());
  let today = "2026-10-24";
  const api = fakeApi();
  const k = new VerseKeeper({ store, today: () => today, fetchImpl: api, retryMs: 0 });
  assert.equal(await k.refresh(), true);
  const first = store.get().verse;
  assert.equal(first.date, "2026-10-24");
  const calls = api.calls.length;
  for (let i = 0; i < 5; i++) assert.equal(await k.refresh(), false, "same date: nothing fetched");
  assert.equal(api.calls.length, calls);
  assert.equal(store.publicState().verse.n, first.n, "the phone gets the cached verse");
  // a restart reads the cache instead of fetching
  const k2 = new VerseKeeper({ store: new Store(store.file.replace(/state\.json$/, "")), today: () => today, fetchImpl: api, retryMs: 0 });
  assert.equal(await k2.refresh(), false);
  // midnight: a new date, a new verse
  today = "2026-10-25";
  assert.equal(await k.refresh(), true);
  assert.equal(store.get().verse.date, "2026-10-25");
  assert.notEqual(store.get().verse.n, first.n);
  // the source is down after the next midnight: the card keeps yesterday's verse until a fetch works
  today = "2026-10-26";
  const down = new VerseKeeper({ store, today: () => today, fetchImpl: fakeApi({ fail: true }), retryMs: 60000 });
  assert.equal(await down.refresh(), false);
  assert.equal(store.get().verse.date, "2026-10-25");
  assert.equal(await down.refresh(), false, "no retry storm inside the retry gap");
});
