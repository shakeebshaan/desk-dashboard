// Calendar-exact age: whole years, months and days since a birth date.
// Shared by the app (age widget) and the hub (/status), and unit-tested in hub/test/age.test.js.
//
// Rule: the n-th "monthiversary" is the birth date moved n months forward, with the day clamped to the end of that
// month (a 31 Jan birth reaches 1 month on 28/29 Feb, a 29 Feb birth turns 1 on 28 Feb in a non-leap year). The age
// is the largest n whose monthiversary is on or before today (n = years * 12 + months), then the days since it.

export function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

function addMonths(b, n) {
  const total = b.m - 1 + n;
  const y = b.y + Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(b.d, daysInMonth(y, m)) };
}

const dayNo = (x) => Date.UTC(x.y, x.m - 1, x.d) / 86400000;

// birth, today: {y, m, d} (today in the phone's local calendar). Returns null when today is before the birth date.
export function ageBetween(birth, today) {
  if (dayNo(today) < dayNo(birth)) return null;
  let n = (today.y - birth.y) * 12 + (today.m - birth.m);
  while (n > 0 && dayNo(addMonths(birth, n)) > dayNo(today)) n--;
  const days = dayNo(today) - dayNo(addMonths(birth, n));
  return { years: Math.floor(n / 12), months: n % 12, days, totalDays: dayNo(today) - dayNo(birth) };
}

// Next birthday on or after today (a 29 Feb birth celebrates on 28 Feb in non-leap years): days until it, the age it
// brings, and how far through the current year of life we are (0..1). Null when today is before the birth date.
export function nextBirthday(b, t) {
  if (dayNo(t) < dayNo(b)) return null;
  const at = (y) => ({ y, m: b.m, d: Math.min(b.d, daysInMonth(y, b.m)) });
  let n = at(t.y);
  if (dayNo(n) < dayNo(t)) n = at(t.y + 1);
  if (n.y === b.y) n = at(b.y + 1); // born today: the next one is the first birthday
  const span = dayNo(n) - dayNo(at(n.y - 1));
  const days = dayNo(n) - dayNo(t);
  return { days, turns: n.y - b.y, frac: days === 0 ? 1 : 1 - days / span };
}

export const UPCOMING_DAYS = 7;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const weekday = (x) => WEEKDAYS[new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay()];

// The calendar date of the next birthday (same clamping as nextBirthday).
export function nextBirthdayDate(b, t) {
  const nb = nextBirthday(b, t);
  if (!nb) return null;
  const y = b.y + nb.turns;
  return { y, m: b.m, d: Math.min(b.d, daysInMonth(y, b.m)) };
}

// Milliseconds from `now` (a Date, the phone's local time) to the start of the next birthday; 0 on the day itself.
export function msToNextBirthday(b, now = new Date()) {
  const t = localYmd(now);
  const d = nextBirthdayDate(b, t);
  if (!d) return null;
  if (dayNo(d) === dayNo(t)) return 0;
  return new Date(d.y, d.m - 1, d.d).getTime() - now.getTime();
}

// Day-count milestones: every 100 days up to 1,000, then every 1,000.
export function nextDayMilestone(totalDays) {
  const m = totalDays < 1000 ? Math.max(100, Math.ceil(totalDays / 100) * 100) : Math.ceil(totalDays / 1000) * 1000;
  return { days: m, inDays: m - totalDays };
}

// Half-birthday: the 6-month monthiversary of each year of life (same end-of-month clamping as ages).
export function nextHalfBirthday(b, t) {
  if (dayNo(t) < dayNo(b)) return null;
  for (let k = 0; ; k++) {
    const d = addMonths(b, 12 * k + 6);
    if (dayNo(d) >= dayNo(t)) return { date: d, inDays: dayNo(d) - dayNo(t), turnsHalf: k + 0.5 };
  }
}

// The next special day for one person: a day-count milestone or a half-birthday, whichever comes first.
export function nextSpecial(b, t) {
  const a = ageBetween(b, t);
  if (!a) return null;
  const m = nextDayMilestone(a.totalDays);
  const h = nextHalfBirthday(b, t);
  return h && h.inDays < m.inDays
    ? { kind: "half", inDays: h.inDays, label: h.turnsHalf < 1 ? "½ year" : `${Math.floor(h.turnsHalf)}½ years`, date: h.date }
    : { kind: "days", inDays: m.inDays, label: `${m.days.toLocaleString("en-US")} days` };
}

// Whose birthday is next across the family (ties: first in the list). people: [{ name, b }]
export function familyNext(people, t) {
  let best = null;
  for (const p of people) {
    const nb = nextBirthday(p.b, t);
    if (nb && (!best || nb.days < best.nb.days)) best = { ...p, nb };
  }
  return best;
}

// ---------- birthday takeover: which screen a person gets, and whether today is their day ----------
// Tags set with /birthday <name> [date] <tag>. "auto" (or no tag) picks by age: under 1 newborn, 1-4 toddler,
// 5-12 kid, otherwise adult. female / male only change an adult's screen; head, newborn, toddler, kid always win.
export const BIRTHDAY_TAGS = ["auto", "head", "female", "male", "newborn", "toddler", "kid"];
export const TAKEOVER_KINDS = ["newborn", "toddler", "female", "head", "default"];
const TAG_ALIASES = { mom: "female", mother: "female", wife: "female", woman: "female", girl: "female", f: "female",
  dad: "head", father: "head", husband: "head", man: "male", boy: "male", m: "male", baby: "newborn", infant: "newborn", child: "kid" };
export function normTag(w) {
  const t = String(w || "").toLowerCase();
  const v = TAG_ALIASES[t] || t;
  return BIRTHDAY_TAGS.includes(v) ? v : null;
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

// The occasion for one person on day t: their birthday, or for a baby under 1 a monthiversary ("3 months").
// -> { kind, today, months?, weeks?, turns?, years, title, line } or null (not born yet). `today` false outside the day;
// the preview still gets a screen: a baby's months now, everyone else the age they turn next.
export function celebration(person, t) {
  const b = parseYmd(person.birth);
  const a = b && ageBetween(b, t);
  if (!a) return null;
  const nb = nextBirthday(b, t);
  const bday = nb.days === 0;
  const tag = normTag(person.tag) || "auto";
  const turns = nb.turns; // the age celebrated today, or (preview) at the next birthday
  let kind;
  if (["head", "newborn", "toddler"].includes(tag)) kind = tag;
  else if (tag === "kid") kind = "default";
  else if (a.years === 0 && !bday) kind = "newborn";
  else if (turns <= 4) kind = "toddler";
  else if (turns <= 12) kind = "default";
  else kind = tag === "female" ? "female" : "default";
  const months = a.years * 12 + a.months;
  // a baby's month day: same day of the month as the birth (clamped at month end), months 1..11
  const monthDay = a.years === 0 && months >= 1 && a.days === 0;
  const name = person.name;
  const o = { kind, today: bday || monthDay, turns, years: a.years, months, weeks: Math.floor(a.totalDays / 7), name };
  if (kind === "newborn" && !bday) {
    o.title = months === 0 ? `Welcome, ${name}` : `Happy ${months} ${months === 1 ? "month" : "months"}, ${name}`;
    o.line = months === 0 ? `${o.weeks} ${o.weeks === 1 ? "week" : "weeks"} of you` : `${o.weeks} weeks of tiny wonders`;
    o.big = months === 0 ? `${o.weeks}w` : `${months}`;
  } else if (kind === "head") {
    o.title = `Happy birthday, ${name}`;
    o.line = "Happy birthday to the head of the family";
    o.big = String(turns);
  } else {
    o.title = `Happy ${turns ? ordinal(turns) + " " : ""}birthday, ${name}`;
    o.line = kind === "toddler" ? (bday ? `${name} is ${turns} today!` : `${name} turns ${turns}!`) : kind === "female" ? "Wishing you a day as lovely as you are" : `${turns} amazing years`;
    o.big = String(turns);
  }
  return o;
}

export function localYmd(date = new Date()) {
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

const unit = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function formatAge(a) {
  if (!a) return "not born yet";
  return `${unit(a.years, "year")} ${unit(a.months, "month")} ${unit(a.days, "day")}`;
}
