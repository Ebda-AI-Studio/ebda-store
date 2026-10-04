import { z } from 'zod';
import { type ReportRange, reportRangeParams, parseReportRange } from './report-range';

/**
 * Filter contracts for the admin lists that have an Export button. The list
 * request and the export request are built from ONE params object and parsed
 * by ONE schema, so "export what is on screen" cannot drift (owner report
 * 2026-09-30: the orders export held the whole store history — every status,
 * every date — while the list on screen was filtered).
 */

export const ORDER_LIST_STATUSES = [
  'pending',
  'awaiting_payment_confirmation',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderListStatus = (typeof ORDER_LIST_STATUSES)[number];

export const ORDER_LIST_PAYMENT_STATUSES = [
  'unpaid',
  'paid',
  'failed',
  'refunded',
  'disputed',
] as const;
export type OrderListPaymentStatus = (typeof ORDER_LIST_PAYMENT_STATUSES)[number];

export interface OrderListFilters {
  range?: ReportRange;
  status?: OrderListStatus;
  paymentStatus?: OrderListPaymentStatus;
  search?: string;
}

/** Longest search string either side will send / accept. */
export const LIST_SEARCH_MAX = 100;

/** Query params for the order list AND its export. */
export function orderListFilterParams(f: OrderListFilters): URLSearchParams {
  const qs = new URLSearchParams(f.range ? reportRangeParams(f.range) : {});
  if (f.status) qs.set('status', f.status);
  if (f.paymentStatus) qs.set('paymentStatus', f.paymentStatus);
  const search = f.search?.trim();
  if (search) qs.set('search', search.slice(0, LIST_SEARCH_MAX));
  return qs;
}

const orderListQuerySchema = z
  .object({
    status: z.enum(ORDER_LIST_STATUSES).optional(),
    paymentStatus: z.enum(ORDER_LIST_PAYMENT_STATUSES).optional(),
    search: z.string().optional(),
  })
  .passthrough();

export type ListFilterParseResult<T> = { ok: true; filters: T } | { ok: false; error: z.ZodError };

/**
 * Parses the order list/export filters. An unknown status or a malformed
 * range is a 422 (an unknown status used to reach Prisma as a 500).
 */
export function parseOrderListFilters(query: unknown): ListFilterParseResult<OrderListFilters> {
  const range = parseReportRange(query);
  if (!range.ok) return { ok: false, error: range.error };
  const parsed = orderListQuerySchema.safeParse(query ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error };
  const search = parsed.data.search?.trim().slice(0, LIST_SEARCH_MAX) || undefined;
  return {
    ok: true,
    filters: {
      range: range.range,
      status: parsed.data.status,
      paymentStatus: parsed.data.paymentStatus,
      search,
    },
  };
}

export const CUSTOMER_LIST_SEGMENT_MAX = 64;

export interface CustomerListFilters {
  search?: string;
  /** An RFM segment name or `guest`; validated by the API's own parser. */
  segment?: string;
}

/** Query params for the customer list AND its export. */
export function customerListFilterParams(f: CustomerListFilters): URLSearchParams {
  const qs = new URLSearchParams();
  const search = f.search?.trim();
  if (search) qs.set('search', search.slice(0, LIST_SEARCH_MAX));
  if (f.segment) qs.set('segment', f.segment.slice(0, CUSTOMER_LIST_SEGMENT_MAX));
  return qs;
}

/** `YYYY-MM-DD` of a Date in the viewer's own timezone. */
export function localIsoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Export filename carrying the applied range, e.g.
 * `orders-2026-09-01_to_2026-09-30.xlsx`. `dayOf` renders a bound as a day in
 * the timezone the range was picked in (the admin passes `localIsoDay`).
 */
export function exportFilename(
  base: string,
  range: ReportRange | undefined,
  ext: string,
  dayOf: (d: Date) => string = localIsoDay
): string {
  const span = range ? `${dayOf(range.startDate)}_to_${dayOf(range.endDate)}` : 'all-time';
  return `${base}-${span}.${ext}`;
}

/**
 * One human line naming the filters an export applied, for the "Filters:"
 * header row in the file.
 */
export function describeListFilters(
  parts: Array<[label: string, value: string | undefined]>
): string {
  const applied = parts.filter(([, v]) => v !== undefined && v !== '');
  return applied.length === 0
    ? 'Filters: none (all records)'
    : `Filters: ${applied.map(([k, v]) => `${k} = ${v}`).join('; ')}`;
}

/**
 * `dayOf` for a server that only knows the viewer's UTC offset (minutes,
 * east-positive — the admin sends `-new Date().getTimezoneOffset()`), so the
 * filename and the "Filters:" line name the same days the viewer picked.
 */
export function dayInOffset(offsetMinutes: number): (d: Date) => string {
  return d => new Date(d.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Parses an export's `tzOffset` query value; out-of-range or absent → 0 (UTC). */
export function parseTzOffset(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : 0;
}
