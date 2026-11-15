// Calendar dates (YYYY-MM-DD) in the user's time zone.
//
// Workers run in UTC. Garmin files data under the user's local calendar day, so "today"
// must be computed in their zone, or late in the evening in the Americas it is already
// tomorrow in UTC and every "today" query comes back empty.

export class DateError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in `timeZone` (an IANA name such as "America/Los_Angeles"). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10); // unknown zone: fall back to UTC
  }
}

/** Validate a YYYY-MM-DD string (or default to `today`). */
export function parseDate(value: string | undefined | null, today: string): string {
  if (!value) return today;
  const d = new Date(`${value}T00:00:00Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new DateError(`Invalid date ${JSON.stringify(value)}; expected YYYY-MM-DD.`);
  }
  return value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
}

/** Validate a date range of at most `maxDays` days (inclusive). `end` defaults to `start`. */
export function parseRange(
  start: string | undefined,
  end: string | undefined,
  today: string,
  maxDays: number,
): [string, string] {
  const s = parseDate(start, today);
  const e = parseDate(end ?? start, today);
  const days = daysBetween(s, e);
  if (days < 0) throw new DateError("end_date must be on or after start_date.");
  if (days >= maxDays) {
    throw new DateError(`Date range too long (${days + 1} days); max is ${maxDays}.`);
  }
  return [s, e];
}

/** Split [start, end] into consecutive chunks of at most `size` days. */
export function chunkRange(start: string, end: string, size: number): [string, string][] {
  const chunks: [string, string][] = [];
  for (let s = start; daysBetween(s, end) >= 0; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    chunks.push([s, daysBetween(e, end) < 0 ? end : e]);
  }
  return chunks;
}
