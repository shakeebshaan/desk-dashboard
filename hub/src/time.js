// Time-zone helpers without a library: wall clock in an IANA zone via Intl.

export function wallParts(epochMs, tz) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(epochMs)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

export function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Epoch of the wall time y-m-d hh:mm in tz (two passes handle DST shifts).
export function zonedToEpoch({ y, m, d, hh, mm }, tz) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const w = wallParts(guess, tz);
    const diff = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm) - Date.UTC(y, m - 1, d, hh, mm);
    guess -= diff;
  }
  return guess;
}

export function parseHhmm(s) {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(String(s || "").trim());
  return m ? { hh: +m[1], mm: +m[2], text: `${m[1].padStart(2, "0")}:${m[2]}` } : null;
}

// Next epoch at which the wall clock in tz shows hh:mm (today if still ahead, else tomorrow).
export function nextAt(hhmm, tz, now = Date.now()) {
  const w = wallParts(now, tz);
  let at = zonedToEpoch({ y: w.y, m: w.m, d: w.d, hh: hhmm.hh, mm: hhmm.mm }, tz);
  if (at <= now) {
    const t = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
    at = zonedToEpoch({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: hhmm.hh, mm: hhmm.mm }, tz);
  }
  return at;
}

// "20m", "2h", "1h30m", "45s" -> ms
export function parseDuration(s) {
  const m = /^(?:(\d+)h)?(?:(\d+)m(?:in)?)?(?:(\d+)s)?$/i.exec(String(s || "").trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  return ms > 0 && ms <= 30 * 86400000 ? ms : null;
}

export function fmtWhen(epochMs, tz) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}
