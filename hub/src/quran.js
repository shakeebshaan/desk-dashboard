// Quran verse of the day from api.alquran.cloud (free, no key, no account), fetched by the hub so the phone never
// calls a third party. The text is shown exactly as the source gives it: Uthmani script plus two named, published
// translations. No model ever writes, shortens or paraphrases a verse (the agent is not involved at all).
// One verse per local date: the same all day, a new one after local midnight; cached in the hub's state.

export const QURAN_API = "https://api.alquran.cloud/v1";
export const EDITIONS = { ar: "quran-uthmani", en: "en.sahih", ur: "ur.jalandhry" };
export const VERSE_LANGS = ["en", "ur"];
export const TOTAL_AYAHS = 6236;
export const MAX_ARABIC = 420; // longer verses do not fit a phone card; the day takes the next candidate instead

// Candidate verse numbers (1..6236) for a date, in order: a fixed shuffle of the day number, so every date has its
// own verse and the hub picks the same one after a restart.
export function verseCandidates(ymd, n = 8) {
  const day = Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000);
  const out = [];
  for (let i = 0; i < n; i++) {
    let h = (day * 2654435761 + i * 40503) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    out.push(((h ^ (h >>> 16)) >>> 0) % TOTAL_AYAHS + 1);
  }
  return out;
}

// One verse in Arabic + both translations, in one call. -> { n, surah, ayah, arabic, tr: { en, ur } }
export async function fetchVerse(n, fetchImpl = fetch) {
  const url = `${QURAN_API}/ayah/${n}/editions/${EDITIONS.ar},${EDITIONS.en},${EDITIONS.ur}`;
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`alquran.cloud HTTP ${r.status}`);
  const j = await r.json();
  const data = j && j.code === 200 && Array.isArray(j.data) ? j.data : null;
  const by = (id) => data && data.find((d) => d && d.edition && d.edition.identifier === id);
  const ar = by(EDITIONS.ar), en = by(EDITIONS.en), ur = by(EDITIONS.ur);
  const ok = (d) => d && typeof d.text === "string" && d.text.trim() && d.number === n && d.surah && d.surah.number >= 1 && d.numberInSurah >= 1;
  if (!ok(ar) || !ok(en) || !ok(ur)) throw new Error("alquran.cloud: unexpected answer");
  const s = ar.surah;
  return {
    n,
    surah: { number: s.number, name: s.name, englishName: s.englishName, meaning: s.englishNameTranslation },
    ayah: ar.numberInSurah,
    arabic: ar.text,
    tr: {
      en: { text: en.text, name: en.edition.englishName || en.edition.name, id: EDITIONS.en },
      ur: { text: ur.text, name: ur.edition.englishName || ur.edition.name, id: EDITIONS.ur },
    },
    source: "api.alquran.cloud",
  };
}

// The verse for a local date: the first candidate that fits a card. Verse 1 of surahs 2-114 is skipped: the
// source prefixes it with the Bismillah, which is not part of that verse's numbering.
export async function verseOfDay(ymd, fetchImpl = fetch) {
  let last = null;
  for (const n of verseCandidates(ymd)) {
    const v = await fetchVerse(n, fetchImpl);
    last = v;
    if (v.ayah === 1 && v.surah.number !== 1) continue;
    if (v.arabic.length <= MAX_ARABIC) return { ...v, date: ymd, at: Date.now() };
  }
  return { ...last, date: ymd, at: Date.now() };
}

// Keeps state.verse on today's verse: nothing to do while the date matches; after midnight a new one. A failed
// fetch keeps the old verse on the card and is retried after `retryMs`.
export class VerseKeeper {
  constructor({ store, today, fetchImpl = fetch, log = () => {}, retryMs = 5 * 60 * 1000 }) {
    Object.assign(this, { store, today, fetchImpl, log, retryMs });
    this.failedAt = 0;
    this.busy = null;
  }

  due() {
    const v = this.store.get().verse;
    return !v || v.date !== this.today();
  }

  async refresh({ force = false } = {}) {
    if (this.busy) return this.busy;
    if (!force && !this.due()) return false;
    if (!force && Date.now() - this.failedAt < this.retryMs) return false;
    const ymd = this.today();
    this.busy = verseOfDay(ymd, this.fetchImpl).then((v) => {
      this.store.update((s) => { s.verse = v; });
      this.failedAt = 0;
      return true;
    }, (e) => {
      this.failedAt = Date.now();
      this.log(`verse: ${e.message}`);
      return false;
    }).finally(() => { this.busy = null; });
    return this.busy;
  }
}
