// A fake api.aladhan.com for tests: fixed (or given) prayer times, a simple Hijri <-> Gregorian mapping, a call log.
export const TIMES = { Fajr: "05:05", Sunrise: "06:18", Dhuhr: "12:07", Asr: "16:19", Sunset: "17:55", Maghrib: "17:55", Isha: "19:08 (IST)" };
// times: override the prayer times (e.g. a prayer one minute from now for a browser test)
export function fakeAladhan({ times = TIMES } = {}) {
  const calls = [];
  const base = Date.UTC(2026, 9, 24); // 24 Oct 2026 = 13 Jumada al-ula 1448 (as Aladhan says)
  const dmy = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`; };
  const MONTHS = ["Muharram", "Safar", "Rabi al-awwal", "Rabi al-thani", "Jumada al-ula", "Jumada al-akhira", "Rajab", "Shaban", "Ramadan", "Shawwal", "Dhu al-Qadah", "Dhu al-Hijjah"];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const ok = (data) => new Response(JSON.stringify({ code: 200, status: "OK", data }));
    let m;
    if ((m = /\/timings\/(\d\d-\d\d-\d{4})/.exec(u.pathname))) {
      return ok({ timings: times, date: { hijri: { day: "13", month: { en: "Jumada al-ula" }, year: "1448" } }, q: u.search });
    }
    if (/\/gToH\//.test(u.pathname)) return ok({ hijri: { year: "1448" } });
    if ((m = /\/hToG\/(\d\d)-(\d\d)-(\d{4})/.exec(u.pathname))) {
      const [d, mo, y] = [+m[1], +m[2], +m[3]];
      const days = Math.round((y - 1448) * 354.37 + (mo - 5) * 29.53 + (d - 13));
      return ok({ gregorian: { date: dmy(base + days * 86400000) }, hijri: { month: { en: MONTHS[mo - 1] } } });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}

