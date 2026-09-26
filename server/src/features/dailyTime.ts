// Pure Europe/Bratislava date/time helpers for the daily puzzle (server/src/features/Daily.ts).
// scripts/spots-gen.mjs needs the same "18:00 local -> ISO" conversion but is a plain .mjs script with
// no TypeScript loader, so it keeps its own copy of bratislavaReveal18's few lines; this is the tested
// original the copy must keep matching.
//
// DST note: the EU's spring-forward/fall-back transitions both happen in the small hours (around
// 01:00-03:00 local), nowhere near the 18:00 reveal or an ordinary day-rollover check, so a single
// Intl lookup at a nearby guessed instant always lands on the correct side of the transition — no
// need to special-case the transition day itself (verified for both 2026 transitions in the tests).

/** Today's calendar date in Europe/Bratislava ('YYYY-MM-DD') for a UTC timestamp (ms). */
export function bratislavaDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** 18:00 local time in Bratislava on `day` ('YYYY-MM-DD'), as an ISO-8601 UTC instant. */
export function bratislavaReveal18(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 18, 0, 0);
  return new Date(guess - bratislavaOffsetMinutes(guess) * 60_000).toISOString();
}

/** `day` shifted by `delta` calendar days (delta may be negative), 'YYYY-MM-DD'. Calendar-date
 *  arithmetic only, so it needs no timezone: a date string minus a day is unambiguous. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Europe/Bratislava's UTC offset in minutes (60 in winter/CET, 120 in summer/CEST) at instant `ms`. */
function bratislavaOffsetMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Bratislava', timeZoneName: 'shortOffset' }).formatToParts(new Date(ms));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1');
  if (!m) return 60;
  const sign = m[1].startsWith('-') ? -1 : 1;
  return parseInt(m[1], 10) * 60 + sign * (m[2] ? parseInt(m[2], 10) : 0);
}
