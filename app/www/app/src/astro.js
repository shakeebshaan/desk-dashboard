// Sun and moon, computed (no API, works offline). Shared by the phone (moon and sun widgets, timed events) and the
// hub (/moon, /sun), and unit-tested against published tables in hub/test/astro.test.js:
//   moon phases     Meeus, Astronomical Algorithms ch. 49 (periodic terms; planetary terms left out, < 1 min)
//   illumination    Meeus ch. 48, low-precision phase angle (about 0.1 % off)
//   sunrise/sunset  NOAA solar calculator equations, refraction + solar disc = 0.833 deg, iterated twice
// Every time here is an absolute UTC millisecond value.

const RAD = Math.PI / 180;
const sin = (d) => Math.sin(d * RAD), cos = (d) => Math.cos(d * RAD), tan = (d) => Math.tan(d * RAD);
const norm = (d) => ((d % 360) + 360) % 360;
const JD_UNIX = 2440587.5;
export const msToJd = (ms) => ms / 86400000 + JD_UNIX;
export const jdToMs = (jd) => (jd - JD_UNIX) * 86400000;
export const SYNODIC_DAYS = 29.530588861;

// TT - UT in seconds (NASA polynomial for 2005-2050; a few seconds off, irrelevant at minute precision)
const deltaT = (year) => { const t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; };

// ---------- moon phases ----------
export const PHASES = ["new", "first", "full", "last"]; // k + 0, 0.25, 0.5, 0.75

// The instant of the phase with lunation number k (k = 0 the new moon of 6 Jan 2000; .25 .5 .75 the others).
export function phaseTime(k) {
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;
  const Om = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;
  const q = ((k % 1) + 1) % 1;
  let c;
  if (q < 0.01 || q > 0.99 || Math.abs(q - 0.5) < 0.01) {
    const full = Math.abs(q - 0.5) < 0.01;
    c = (full ? -0.40614 : -0.4072) * sin(Mp) + (full ? 0.17302 : 0.17241) * E * sin(M) + (full ? 0.01614 : 0.01608) * sin(2 * Mp)
      + (full ? 0.01043 : 0.01039) * sin(2 * F) + (full ? 0.00734 : 0.00739) * E * sin(Mp - M) - (full ? 0.00515 : 0.00514) * E * sin(Mp + M)
      + (full ? 0.00209 : 0.00208) * E * E * sin(2 * M) - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F)
      + 0.00056 * E * sin(2 * Mp + M) - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F)
      - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(Om) - 0.00007 * sin(Mp + 2 * M) + 0.00004 * sin(2 * Mp - 2 * F)
      + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F) + 0.00003 * sin(2 * Mp + 2 * F) - 0.00003 * sin(Mp + M + 2 * F)
      + 0.00003 * sin(Mp - M + 2 * F) - 0.00002 * sin(Mp - M - 2 * F) - 0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
  } else {
    c = -0.62801 * sin(Mp) + 0.17172 * E * sin(M) - 0.01183 * E * sin(Mp + M) + 0.00862 * sin(2 * Mp) + 0.00804 * sin(2 * F)
      + 0.00454 * E * sin(Mp - M) + 0.00204 * E * E * sin(2 * M) - 0.0018 * sin(Mp - 2 * F) - 0.0007 * sin(Mp + 2 * F)
      - 0.0004 * sin(3 * Mp) - 0.00034 * E * sin(2 * Mp - M) + 0.00032 * E * sin(M + 2 * F) + 0.00032 * E * sin(M - 2 * F)
      - 0.00028 * E * E * sin(Mp + 2 * M) + 0.00027 * E * sin(2 * Mp + M) - 0.00017 * sin(Om) - 0.00005 * sin(Mp - M - 2 * F)
      + 0.00004 * sin(2 * Mp + 2 * F) - 0.00004 * sin(Mp + M + 2 * F) + 0.00004 * sin(Mp - 2 * M) + 0.00003 * sin(Mp + M - 2 * F)
      + 0.00003 * sin(3 * M) + 0.00002 * sin(2 * Mp - 2 * F) + 0.00002 * sin(Mp - M + 2 * F) - 0.00002 * sin(3 * Mp + M);
    const W = 0.00306 - 0.00038 * E * cos(M) + 0.00026 * cos(Mp) - 0.00002 * cos(Mp - M) + 0.00002 * cos(Mp + M) + 0.00002 * cos(2 * F);
    c += q < 0.5 ? W : -W;
  }
  jde += c;
  const ms = jdToMs(jde);
  return ms - deltaT(new Date(ms).getUTCFullYear()) * 1000;
}

// The first phase of the given kind ("new" | "first" | "full" | "last") after `ms`.
export function nextPhase(kind, ms = Date.now()) {
  const off = PHASES.indexOf(kind) / 4;
  let k = Math.floor((ms - Date.UTC(2000, 0, 6, 18, 14)) / (SYNODIC_DAYS * 86400000)) - 1 + off;
  for (;;) {
    const t = phaseTime(k);
    if (t > ms) return t;
    k += 1;
  }
}
export function prevPhase(kind, ms = Date.now()) {
  const t = nextPhase(kind, ms);
  const off = PHASES.indexOf(kind) / 4;
  const k = Math.round((t - Date.UTC(2000, 0, 6, 18, 14)) / (SYNODIC_DAYS * 86400000) - off) + off;
  return phaseTime(k - 1);
}

// ---------- moon now ----------
const NAMES = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];

// -> { illum 0..1, angle 0..360 (0 new, 90 first quarter, 180 full, 270 last quarter), waxing, name, ageDays,
//      nextFull, nextNew }
export function moonNow(ms = Date.now()) {
  const T = (msToJd(ms) - 2451545) / 36525;
  const D = norm(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T);
  const M = norm(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T);
  const Mp = norm(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T);
  const i = norm(180 - D - 6.289 * sin(Mp) + 2.1 * sin(M) - 1.274 * sin(2 * D - Mp) - 0.658 * sin(2 * D) - 0.214 * sin(2 * Mp) - 0.11 * sin(D));
  const illum = (1 + cos(i)) / 2;
  const angle = norm(180 - i); // elongation-like: grows from 0 at new moon through 180 at full
  const waxing = angle < 180;
  // names: the principal phases get +-6.5 deg (about half a day) around their exact angle
  const idx = angle < 6.5 || angle >= 353.5 ? 0 : angle < 83.5 ? 1 : angle < 96.5 ? 2 : angle < 173.5 ? 3 : angle < 186.5 ? 4 : angle < 263.5 ? 5 : angle < 276.5 ? 6 : 7;
  const lastNew = prevPhase("new", ms + 1);
  return { illum, angle, waxing, name: NAMES[idx], ageDays: (ms - lastNew) / 86400000, nextFull: nextPhase("full", ms), nextNew: nextPhase("new", ms) };
}

// SVG path of the lit part of a moon disc of radius r centred at (r, r): the outer limb is a half circle, the
// terminator a half ellipse whose width follows the illumination. Lit side: right while waxing (northern sky).
export function moonPath(illum, waxing, r = 50) {
  const k = 1 - 2 * illum; // terminator x-radius as a fraction of r: +1 new, 0 quarter, -1 full
  const rx = Math.abs(k) * r;
  const top = `${r} 0`, bottom = `${r} ${2 * r}`;
  const outer = waxing ? 1 : 0; // sweep of the limb: right half while waxing, left half while waning
  // terminator from bottom back to top; bulges toward the lit side when more than half is lit
  const sweep = waxing ? (k > 0 ? 0 : 1) : (k > 0 ? 1 : 0);
  return `M${top} A${r} ${r} 0 0 ${outer} ${bottom} A${rx.toFixed(2)} ${r} 0 0 ${sweep} ${top} Z`;
}

// ---------- sun ----------
function sunAt(jd) {
  const T = (jd - 2451545) / 36525;
  const L0 = norm(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
  const om = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * sin(om);
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * cos(om);
  const decl = Math.asin(sin(eps) * sin(lambda)) / RAD;
  const y = tan(eps / 2) ** 2;
  const eot = 4 * (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M)) / RAD;
  return { decl, eot };
}

// Sunrise, solar noon and sunset for one calendar date (y, m, d) at (lat, lon). The date is the local date at
// that place: the result is the instants of that day's events. -> { rise, noon, set, dayMs } (rise/set null in
// polar day or night)
export function sunTimes(y, m, d, lat, lon) {
  const day0 = Date.UTC(y, m - 1, d);
  const at = (minutes) => day0 + minutes * 60000;
  const noonGuess = 720 - 4 * lon;
  let { eot } = sunAt(msToJd(at(noonGuess)));
  const noon = at(720 - 4 * lon - eot);
  const event = (sign) => {
    let t = noon;
    for (let i = 0; i < 3; i++) {
      const s = sunAt(msToJd(t));
      const cosH = cos(90.833) / (cos(lat) * cos(s.decl)) - tan(lat) * tan(s.decl);
      if (cosH > 1 || cosH < -1) return null;
      const H = Math.acos(cosH) / RAD;
      t = at(720 - 4 * lon - s.eot + sign * 4 * H);
    }
    return t;
  };
  const rise = event(-1), set = event(1);
  return { rise, noon, set, dayMs: rise && set ? set - rise : null };
}

// Where the sun is on its day arc: 0 at sunrise, 1 at sunset; null at night. Night: 0 at sunset .. 1 at next sunrise.
export function sunProgress(now, today, tomorrow, yesterday) {
  if (!today.rise || !today.set) return { day: null, night: null };
  if (now >= today.rise && now <= today.set) return { day: (now - today.rise) / (today.set - today.rise), night: null };
  const [a, b] = now > today.set ? [today.set, tomorrow && tomorrow.rise] : [yesterday && yesterday.set, today.rise];
  return { day: null, night: a && b ? (now - a) / (b - a) : null };
}

export const fmtDur = (ms) => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
