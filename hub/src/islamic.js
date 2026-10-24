// Prayer times and Islamic dates from Aladhan (api.aladhan.com: free, no key, no account), fetched by the hub so
// the phone never calls a third party. Hijri dates are calculated (Aladhan's HJCoSA method); the real date can be
// a day later or earlier depending on the moon sighting, which the countdown card says.

const API = "https://api.aladhan.com/v1";

// Aladhan method ids (the common ones by name; any id 0-23 is accepted).
export const METHODS = {
  0: "Shia Ithna-Ashari (Jafari)", 1: "University of Islamic Sciences, Karachi", 2: "ISNA (North America)",
  3: "Muslim World League", 4: "Umm al-Qura, Makkah", 5: "Egyptian General Authority", 7: "University of Tehran",
  8: "Gulf Region", 9: "Kuwait", 10: "Qatar", 11: "Singapore", 12: "France (UOIF)", 13: "Turkey (Diyanet)",
  14: "Russia", 15: "Moonsighting Committee", 16: "Dubai", 17: "Malaysia (JAKIM)", 18: "Tunisia", 19: "Algeria",
  20: "Indonesia", 21: "Morocco", 22: "Portugal", 23: "Jordan",
};
export const METHOD_ALIASES = { karachi: 1, isna: 2, mwl: 3, makkah: 4, ummalqura: 4, egypt: 5, tehran: 7, gulf: 8, kuwait: 9,
  qatar: 10, singapore: 11, france: 12, turkey: 13, diyanet: 13, russia: 14, moonsighting: 15, dubai: 16, malaysia: 17, jafari: 0 };
export const PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
export const DEFAULT_PRAYER = { method: 1, school: 1, alarms: {} }; // Karachi, Hanafi Asr, no alarms

// [hijri day, hijri month, name]
export const ISLAMIC_DAYS = [
  [1, 1, "Islamic New Year"], [10, 1, "Ashura"], [12, 3, "Mawlid an-Nabi"], [15, 8, "Shab-e-Barat"],
  [1, 9, "Ramadan begins"], [27, 9, "Laylat al-Qadr (27th)"], [1, 10, "Eid al-Fitr"], [9, 12, "Day of Arafah"], [10, 12, "Eid al-Adha"],
];

const ymdToDmy = (ymd) => ymd.split("-").reverse().join("-");
const dmyToYmd = (dmy) => dmy.split("-").reverse().join("-");
const clean = (t) => String(t || "").slice(0, 5);

// Aladhan rate-limits bursts (HTTP 429 seen 2026-10-24 when ~20 calls went out at once): calls go out one at a
// time, about a second apart, and a 429 is retried after a pause.
export const pace = { gapMs: 1100, retryMs: 5000 };
let queue = Promise.resolve();
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(path, fetchImpl) {
  const run = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + pace.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const r = await fetchImpl(`${API}${path}`, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429 && attempt < 3) { await sleep(pace.retryMs * (attempt + 1)); continue; }
      return r;
    }
  });
  queue = run.catch(() => {});
  return run.then(parse);
}

async function parse(r) {
  if (!r.ok) throw new Error(`aladhan HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 200 || !j.data) throw new Error("aladhan: bad answer");
  return j.data;
}

export async function fetchPrayerDay(city, ymd, { method, school }, fetchImpl = fetch) {
  const q = new URLSearchParams({ latitude: String(city.lat), longitude: String(city.lon), method: String(method), school: String(school) });
  const d = await get(`/timings/${ymdToDmy(ymd)}?${q}`, fetchImpl);
  const t = d.timings || {};
  const h = (d.date && d.date.hijri) || {};
  return {
    date: ymd,
    times: { fajr: clean(t.Fajr), sunrise: clean(t.Sunrise), dhuhr: clean(t.Dhuhr), asr: clean(t.Asr), maghrib: clean(t.Maghrib), isha: clean(t.Isha) },
    hijri: h.day ? `${Number(h.day)} ${(h.month && h.month.en) || ""} ${h.year} AH` : "",
  };
}

// Today and tomorrow (tomorrow's Fajr is "next" after Isha).
export async function fetchPrayer(city, prayer, todayYmd, tomorrowYmd, fetchImpl = fetch) {
  const p = { ...DEFAULT_PRAYER, ...prayer };
  const [today, tomorrow] = await Promise.all([fetchPrayerDay(city, todayYmd, p, fetchImpl), fetchPrayerDay(city, tomorrowYmd, p, fetchImpl)]);
  return { city: city.name, method: p.method, methodName: METHODS[p.method] || `method ${p.method}`, school: p.school, asr: p.school === 1 ? "Hanafi" : "Shafi'i",
    today, tomorrow, at: Date.now() };
}

// The next date of each Islamic day on or after today. -> [{ name, date: "YYYY-MM-DD", hijri }], soonest first
export async function fetchIslamicDays(todayYmd, fetchImpl = fetch) {
  const h = await get(`/gToH/${ymdToDmy(todayYmd)}`, fetchImpl);
  const year = Number(h.hijri.year);
  const out = [];
  for (const [day, month, name] of ISLAMIC_DAYS) {
    for (const y of [year, year + 1]) {
      const g = await get(`/hToG/${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${y}`, fetchImpl);
      const date = dmyToYmd(g.gregorian.date);
      if (date >= todayYmd) {
        out.push({ name, date, hijri: `${day} ${g.hijri.month.en} ${y}` });
        break;
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// "HH:MM" on a "YYYY-MM-DD" as wall ms (see app/www/app/src/events.js)
export const wallAt = (ymd, hhmm) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
};
