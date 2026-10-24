import { test } from "node:test";
import assert from "node:assert/strict";
import { ageBetween, formatAge, parseYmd, daysInMonth, nextBirthday, nextBirthdayDate, weekday, msToNextBirthday, nextDayMilestone, nextHalfBirthday, nextSpecial, familyNext } from "../../app/www/app/src/age.js";

const age = (b, t) => {
  const a = ageBetween(parseYmd(b), parseYmd(t));
  return a && [a.years, a.months, a.days];
};

test("example: 2y 2m 2d today, 2y 2m 3d tomorrow", () => {
  assert.deepEqual(age("2023-12-05", "2026-02-07"), [2, 2, 2]);
  assert.deepEqual(age("2023-12-05", "2026-02-08"), [2, 2, 3]);
  assert.equal(formatAge(ageBetween(parseYmd("2023-12-05"), parseYmd("2026-02-07"))), "2 years 2 months 2 days");
});

test("birth day and singulars", () => {
  assert.deepEqual(age("2025-10-23", "2025-10-23"), [0, 0, 0]);
  assert.equal(formatAge(ageBetween(parseYmd("2025-09-22"), parseYmd("2026-10-23"))), "1 year 1 month 1 day");
  assert.equal(ageBetween(parseYmd("2026-10-24"), parseYmd("2026-10-23")), null);
});

test("month ends: day counts restart on the monthiversary", () => {
  assert.deepEqual(age("2026-01-15", "2026-02-14"), [0, 0, 30]);
  assert.deepEqual(age("2026-01-15", "2026-02-15"), [0, 1, 0]);
  assert.deepEqual(age("2026-01-31", "2026-02-27"), [0, 0, 27]);
  assert.deepEqual(age("2026-01-31", "2026-02-28"), [0, 1, 0]); // clamped to Feb's last day
  assert.deepEqual(age("2026-01-31", "2026-03-01"), [0, 1, 1]);
  assert.deepEqual(age("2026-01-31", "2026-03-30"), [0, 1, 30]);
  assert.deepEqual(age("2026-01-31", "2026-03-31"), [0, 2, 0]); // back to the 31st, not chained from 28 Feb
  assert.deepEqual(age("2026-03-31", "2026-04-30"), [0, 1, 0]);
  assert.deepEqual(age("2026-03-31", "2026-05-01"), [0, 1, 1]);
  assert.deepEqual(age("2025-12-31", "2026-01-01"), [0, 0, 1]); // year boundary
  assert.deepEqual(age("2025-12-31", "2026-12-31"), [1, 0, 0]);
});

test("leap years", () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.deepEqual(age("2024-02-29", "2025-02-27"), [0, 11, 29]);
  assert.deepEqual(age("2024-02-29", "2025-02-28"), [1, 0, 0]); // non-leap year: birthday on 28 Feb
  assert.deepEqual(age("2024-02-29", "2025-03-01"), [1, 0, 1]);
  assert.deepEqual(age("2024-02-29", "2028-02-28"), [3, 11, 30]);
  assert.deepEqual(age("2024-02-29", "2028-02-29"), [4, 0, 0]); // leap year: the real day
  assert.deepEqual(age("2024-01-30", "2024-02-29"), [0, 1, 0]); // Jan 30 -> Feb clamps to 29 in a leap year
  assert.deepEqual(age("2024-01-30", "2024-03-01"), [0, 1, 1]);
  assert.deepEqual(age("2023-03-01", "2024-02-29"), [0, 11, 28]);
  assert.equal(ageBetween(parseYmd("2024-02-28"), parseYmd("2024-03-01")).totalDays, 2);
});

test("every day for 4 years moves forward by exactly one day or resets on a monthiversary", () => {
  for (const b of ["2024-02-29", "2024-01-31", "2023-08-30", "2023-12-05"]) {
    const birth = parseYmd(b);
    let prev = null;
    for (let i = 0; i < 4 * 366; i++) {
      const dt = new Date(Date.UTC(birth.y, birth.m - 1, birth.d + i));
      const a = ageBetween(birth, { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
      assert.equal(a.totalDays, i);
      assert.ok(a.months < 12 && a.days >= 0 && a.days < 31, `${b} +${i}`);
      if (prev) {
        const n = a.years * 12 + a.months, p = prev.years * 12 + prev.months;
        if (n === p) assert.equal(a.days, prev.days + 1, `${b} +${i}`);
        else assert.ok(n === p + 1 && a.days === 0, `${b} +${i}`);
      }
      prev = a;
    }
  }
});

test("parseYmd rejects bad dates", () => {
  for (const s of ["2025-02-29", "2026-13-01", "2026-00-10", "26-01-01", "", "2026-04-31"]) assert.equal(parseYmd(s), null, s);
  assert.deepEqual(parseYmd("2024-02-29"), { y: 2024, m: 2, d: 29 });
});

test("next birthday: days to go, the age it brings, today, month end and leap day", () => {
  const nb = (b, t) => { const r = nextBirthday(parseYmd(b), parseYmd(t)); return r && [r.days, r.turns]; };
  assert.deepEqual(nb("2023-12-20", "2026-10-24"), [57, 3]);
  assert.deepEqual(nb("1994-06-11", "2026-10-24"), [230, 33]);
  assert.deepEqual(nb("1986-03-02", "2016-03-02"), [0, 30], "today");
  assert.deepEqual(nb("2026-05-14", "2026-10-24"), [202, 1]);
  assert.deepEqual(nb("2026-10-24", "2026-10-24"), [365, 1], "born today: next is the first birthday");
  assert.equal(nb("2027-01-01", "2026-10-24"), null, "not born yet");
  assert.deepEqual(nb("2024-02-29", "2025-02-27"), [1, 1]);
  assert.deepEqual(nb("2024-02-29", "2025-02-28"), [0, 1], "leap-day birth: 28 Feb in a common year, same day age() turns 1");
  assert.deepEqual(nb("2024-02-29", "2028-02-28"), [1, 4], "29 Feb again in a leap year");
  assert.deepEqual(nb("2023-12-31", "2026-12-31"), [0, 3]);
  assert.deepEqual(nb("2023-12-31", "2027-01-01"), [364, 4]);
  // 7-day window used for the marks
  assert.ok(nb("1979-10-31", "2026-10-24")[0] === 7);
  assert.ok(nb("1979-11-01", "2026-10-24")[0] === 8);
});

test("next birthday date + weekday, countdown in ms, milestones, half-birthdays, who is next", () => {
  const t = parseYmd("2026-10-24");
  assert.deepEqual(nextBirthdayDate(parseYmd("2023-12-05"), t), { y: 2026, m: 12, d: 5 });
  assert.equal(weekday({ y: 2026, m: 12, d: 5 }), "Saturday");
  assert.equal(weekday(parseYmd("2026-10-24")), "Saturday");
  assert.deepEqual(nextBirthdayDate(parseYmd("2024-02-29"), parseYmd("2027-01-10")), { y: 2027, m: 2, d: 28 }, "leap-day birth, common year");
  assert.deepEqual(nextBirthdayDate(parseYmd("2024-02-29"), parseYmd("2027-03-01")), { y: 2028, m: 2, d: 29 });
  // hours on the eve: local time 2026-10-23 20:30 -> 3.5 h to the birthday on the 24th; 0 on the day
  assert.equal(msToNextBirthday(parseYmd("2000-10-24"), new Date(2026, 9, 23, 20, 30)), 3.5 * 3600 * 1000);
  assert.equal(msToNextBirthday(parseYmd("2000-10-24"), new Date(2026, 9, 24, 9, 0)), 0);
  // day milestones: every 100 to 1,000, then every 1,000
  assert.deepEqual(nextDayMilestone(0), { days: 100, inDays: 100 });
  assert.deepEqual(nextDayMilestone(793), { days: 800, inDays: 7 });
  assert.deepEqual(nextDayMilestone(1000), { days: 1000, inDays: 0 });
  assert.deepEqual(nextDayMilestone(1001), { days: 2000, inDays: 999 });
  // half-birthdays use the same month-end clamping as ages
  assert.deepEqual(nextHalfBirthday(parseYmd("2026-08-31"), parseYmd("2026-10-24")), { date: { y: 2027, m: 2, d: 28 }, inDays: 127, turnsHalf: 0.5 });
  assert.deepEqual(nextHalfBirthday(parseYmd("2023-12-05"), parseYmd("2027-06-05")).inDays, 0);
  // the soonest special day wins
  assert.deepEqual(nextSpecial(parseYmd("2021-05-09"), t), { kind: "days", inDays: 6, label: "2,000 days" });
  const half = nextSpecial(parseYmd("2026-05-14"), t);
  assert.deepEqual([half.kind, half.inDays, half.label], ["half", 21, "½ year"]);
  assert.equal(nextSpecial(parseYmd("2027-01-01"), t), null, "not born yet");
  // family: whose birthday is next
  const fam = [["A", "2023-12-05"], ["B", "1990-10-27"], ["C", "2026-05-14"]].map(([name, d]) => ({ name, b: parseYmd(d) }));
  assert.equal(familyNext(fam, t).name, "B");
  assert.equal(familyNext(fam, t).nb.days, 3);
  assert.equal(familyNext([], t), null);
});

test("birthday takeover kinds: by age, by tag, a baby's month days, the wording", async () => {
  const { celebration, normTag } = await import("../../app/www/app/src/age.js");
  const t = parseYmd("2026-10-24");
  const c = (birth, tag) => celebration({ name: "X", birth, ...(tag ? { tag } : {}) }, t);
  // Sample people on 24 Oct 2026
  assert.equal(c("2026-05-12").kind, "newborn"); // 5 months
  assert.equal(c("2026-05-12").title, "Happy 5 months, X");
  assert.equal(c("2026-05-12").today, false);
  assert.equal(c("2023-11-28").kind, "toddler"); // 2 (turns 3)
  assert.equal(c("1994-06-09", "female").kind, "female");
  assert.equal(c("1985-02-08", "head").kind, "head");
  assert.match(c("1985-02-08", "head").line, /head of the family/);
  assert.equal(c("1985-02-08").kind, "default");
  assert.equal(c("2018-01-01").kind, "default", "kid of 8");
  assert.equal(c("2018-01-01", "female").kind, "default", "female only changes an adult's screen");
  assert.equal(c("2018-01-01", "toddler").kind, "toddler", "an explicit kind wins");
  // on the day
  const today = c("2023-10-24");
  assert.deepEqual([today.kind, today.today, today.turns, today.title], ["toddler", true, 3, "Happy 3rd birthday, X"]);
  assert.deepEqual([c("2025-10-24").kind, c("2025-10-24").title], ["toddler", "Happy 1st birthday, X"], "the first birthday");
  assert.deepEqual([c("2026-08-24").today, c("2026-08-24").title], [true, "Happy 2 months, X"], "a baby's month day");
  assert.equal(c("2026-10-20").title, "Welcome, X");
  assert.equal(c("2015-10-24").title, "Happy 11th birthday, X");
  assert.equal(c("2014-10-24").title, "Happy 12th birthday, X");
  assert.equal(c("2005-10-24").title, "Happy 21st birthday, X");
  assert.equal(c("2099-01-01"), null);
  assert.deepEqual(["Mom", "HEAD", "baby", "nope"].map(normTag), ["female", "head", "newborn", null]);
});
