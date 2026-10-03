import { z } from 'zod';

/**
 * The ONE date-range contract between admin report pages and the API.
 *
 * Owner report 2026-09-30: "for the sales reports, why does the selected
 * filter not apply?" Every instance traced back to the two sides naming or
 * reading the range differently (the cashflow route read `from`/`to` while
 * the admin sent `startDate`/`endDate`; a route that got only one of the two
 * silently fell back to month-to-date). Both sides now go through here:
 *
 * - the admin builds the query string with `reportRangeParams(range)`;
 * - the API parses it with `parseReportRange(req.query)`.
 *
 * Values are ISO-8601 instants resolved in the VIEWER's timezone by the
 * admin (local 00:00:00.000 → 23:59:59.999), so "Sep 1 – Sep 30" means the
 * merchant's calendar days, not UTC days.
 */
export const REPORT_RANGE_START_PARAM = 'startDate';
export const REPORT_RANGE_END_PARAM = 'endDate';

export interface ReportRange {
  startDate: Date;
  endDate: Date;
}

/** Query-string pairs for a range, in the one naming the API reads. */
export function reportRangeParams(range: ReportRange): Record<string, string> {
  return {
    [REPORT_RANGE_START_PARAM]: range.startDate.toISOString(),
    [REPORT_RANGE_END_PARAM]: range.endDate.toISOString(),
  };
}

/** `startDate=…&endDate=…` — encoded, ready to append after `?` or `&`. */
export function reportRangeQueryString(range: ReportRange): string {
  return new URLSearchParams(reportRangeParams(range)).toString();
}

const isoInstant = z
  .string()
  .min(1)
  .refine(s => !Number.isNaN(new Date(s).getTime()), 'must be an ISO date');

/**
 * Query schema: both bounds or neither. Half a range, an unparseable date or
 * a start after the end is a 422 — never a silent fall-back to the default
 * window, which is what made a selected filter look ignored.
 */
export const reportRangeQuerySchema = z
  .object({
    [REPORT_RANGE_START_PARAM]: isoInstant.optional(),
    [REPORT_RANGE_END_PARAM]: isoInstant.optional(),
  })
  .passthrough()
  .superRefine((q, ctx) => {
    const s = q[REPORT_RANGE_START_PARAM];
    const e = q[REPORT_RANGE_END_PARAM];
    if ((s === undefined) !== (e === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${REPORT_RANGE_START_PARAM} and ${REPORT_RANGE_END_PARAM} must be sent together`,
        path: [s === undefined ? REPORT_RANGE_START_PARAM : REPORT_RANGE_END_PARAM],
      });
      return;
    }
    if (s !== undefined && e !== undefined && new Date(s).getTime() > new Date(e).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${REPORT_RANGE_START_PARAM} must not be after ${REPORT_RANGE_END_PARAM}`,
        path: [REPORT_RANGE_START_PARAM],
      });
    }
  });

export type ReportRangeParseResult =
  | { ok: true; range: ReportRange | undefined }
  | { ok: false; error: z.ZodError };

/**
 * Parses the range out of a request query. `range` is undefined when the
 * caller sent no range at all (the route then applies its documented default).
 */
export function parseReportRange(query: unknown): ReportRangeParseResult {
  const parsed = reportRangeQuerySchema.safeParse(query ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error };
  const s = parsed.data[REPORT_RANGE_START_PARAM] as string | undefined;
  const e = parsed.data[REPORT_RANGE_END_PARAM] as string | undefined;
  if (s === undefined || e === undefined) return { ok: true, range: undefined };
  return { ok: true, range: { startDate: new Date(s), endDate: new Date(e) } };
}

/** Earliest / latest bound an open-ended day filter widens to. */
const OPEN_START = () => new Date(0);
const OPEN_END = () => new Date(9999, 11, 31, 23, 59, 59, 999);

/**
 * Turns a pair of `<input type="date">` values (`YYYY-MM-DD`, either may be
 * empty) into a contract range of the viewer's LOCAL days. An empty side is
 * open-ended. Both empty → undefined (no range filter).
 */
export function localDayRange(fromDay?: string, toDay?: string): ReportRange | undefined {
  const parse = (s: string | undefined, end: boolean) => {
    const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return undefined;
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    return end ? new Date(y, mo, d, 23, 59, 59, 999) : new Date(y, mo, d, 0, 0, 0, 0);
  };
  const start = parse(fromDay, false);
  const end = parse(toDay, true);
  if (!start && !end) return undefined;
  return { startDate: start ?? OPEN_START(), endDate: end ?? OPEN_END() };
}

// ─── Store-local days (finance reports) ─────────────────────────────────────
//
// Owner decision 2026-10-01: Finance Reports (P&L, trial balance, balance
// sheet, tax report and their exports) count days in the STORE's time zone,
// the same days the finance dashboard shows an Egypt merchant. A date-only
// `YYYY-MM-DD` bound is resolved here, on the server, from the store's
// `timezone` column — never from the server's own TZ and never as a UTC day.

/** Used when a store has no usable `timezone` (Ruling FRT-2). */
export const DEFAULT_STORE_TIME_ZONE = 'Africa/Cairo';

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** True when `timeZone` is an IANA zone this runtime can format in. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    partsFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The store's zone when it is a usable IANA name, else `DEFAULT_STORE_TIME_ZONE`. */
export function resolveStoreTimeZone(timeZone: unknown): string {
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_STORE_TIME_ZONE;
}

/** Wall-clock fields of an instant in `timeZone`. */
function wallClock(d: Date, timeZone: string) {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(d)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return p as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** Offset (ms, east-positive) of `timeZone` at instant `d`. */
function offsetAt(d: Date, timeZone: string): number {
  const w = wallClock(d, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** `YYYY-MM-DD` of an instant as a calendar day in `timeZone`. */
export function zonedIsoDay(d: Date, timeZone: string): string {
  const w = wallClock(d, timeZone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The instant `YYYY-MM-DD 00:00:00.000` happens in `timeZone`; undefined if not a day. */
export function zonedDayStart(day: string, timeZone: string): Date | undefined {
  const m = DAY_RE.exec(day);
  if (!m) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 10) !== day) return undefined;
  // Two passes: the offset at the first guess can differ from the offset at
  // the answer when a DST change falls within the offset's width.
  let t = wall - offsetAt(new Date(wall), timeZone);
  t = wall - offsetAt(new Date(t), timeZone);
  return new Date(t);
}

/** The last millisecond of `YYYY-MM-DD` in `timeZone` (next day's start − 1ms). */
export function zonedDayEnd(day: string, timeZone: string): Date | undefined {
  const start = zonedDayStart(day, timeZone);
  if (!start) return undefined;
  const next = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1)
  );
  const nextStart = zonedDayStart(next.toISOString().slice(0, 10), timeZone);
  return nextStart ? new Date(nextStart.getTime() - 1) : undefined;
}

/** First day (`YYYY-MM-01`) of the month `d` falls in, in `timeZone`. */
export function zonedMonthStartDay(d: Date, timeZone: string): string {
  return `${zonedIsoDay(d, timeZone).slice(0, 8)}01`;
}
