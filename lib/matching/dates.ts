/**
 * The ONE place a document's ISO 8601 `documentDate` is parsed and turned into a calendar day. The extraction schema
 * (is this string acceptable?), the date signal and the candidate-window query (which day is it?) all go through here,
 * so a date that validates can never be un-interpretable later.
 *
 * Accepted: `YYYY-MM-DD`, or a datetime `YYYY-MM-DDTHH:mm[:ss[.fff]]` that ends in `Z` or a `+HH:MM` / `-HH:MM` offset.
 * A datetime without Z or an offset is rejected on purpose: its day depends on a timezone nobody told us.
 * Impossible dates (2026-02-30) and out-of-range times (24:00, 09:60) are rejected, never rolled over.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

type Parsed = { kind: 'day'; epochDay: number } | { kind: 'instant'; epochMs: number };

/** UTC milliseconds of a calendar date and time, or null if the date does not exist (setUTCFullYear also handles years < 100). */
function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number | null {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

function parse(iso: string): Parsed | null {
  const m = ISO_8601.exec(iso);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])] as const;

  if (m[4] === undefined) {
    const ms = utcMs(year, month, day);
    return ms === null ? null : { kind: 'day', epochDay: ms / MS_PER_DAY };
  }

  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] as const;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  const zone = m[7]!;
  if (zone !== 'Z') {
    const [oh, om] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))] as const;
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const local = utcMs(year, month, day, hour, minute, second);
  return local === null ? null : { kind: 'instant', epochMs: local - offsetMinutes * MS_PER_MINUTE };
}

/** Is this string an ISO 8601 date or datetime we can interpret? (what the extraction schema calls to validate) */
export function isValidDocumentDate(iso: string): boolean {
  return parse(iso) !== null;
}

/**
 * Whole days since 1970-01-01 of the calendar day this document date falls on in a zone `offsetMinutes` east of UTC,
 * or null if it is not a valid date. A date-only value IS a calendar day (printed on the receipt, no zone to apply);
 * a datetime is an instant, shifted by the offset first, so `2026-10-01T22:30:00Z` is 2026-10-02 in Riyadh (+180).
 */
export function documentDay(iso: string, offsetMinutes: number): number | null {
  const p = parse(iso);
  if (p === null) return null;
  return p.kind === 'day' ? p.epochDay : Math.floor((p.epochMs + offsetMinutes * MS_PER_MINUTE) / MS_PER_DAY);
}
