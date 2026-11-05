import { z } from 'zod/v3';
import {
  DAY,
  DEFAULT_DELIVERY_OFF_DAYS,
  DEFAULT_TZ,
  deliveryOffDaysSchema,
  safeZone,
  wallClock,
} from './delivery-window';

/**
 * Delivery DATE choices at checkout (Phase B4, Lamma; Ruling B4-7).
 *
 * `settings.checkoutDelivery.daysAhead` (integer 1-14) turns the today/tomorrow windows picker into
 * a short row of date chips: the next `daysAhead` delivery days, each with the store's windows.
 * Absent = the picker behaves exactly as before (today, rolling to tomorrow).
 *
 * ONE pure function decides what is offered, and the storefront and the order endpoint both call
 * it. The server recomputes the set from LIVE settings and the cart's lead times at order time
 * and refuses anything outside it; the client's list is only a hint.
 *
 * CACHE CLASS (rule 3): NEVER-stale for the server check (it reads the store row, never a cache);
 * the storefront copy of the settings rides the bounded public settings cache (`public-store-
 * settings`), which only ever makes the HINT stale, never the check.
 */
export const DELIVERY_DAYS_AHEAD_MAX = 14;
export const daysAheadSchema = z.number().int().min(1).max(DELIVERY_DAYS_AHEAD_MAX);

/** A merchant delivery window as the chips need it (a subset of `CheckoutDeliveryWindow`). */
export interface DeliveryDateWindow {
  id: string;
  /** 24h "HH:mm", store-local. */
  start: string;
  /** Last order time for TODAY, falls back to `start` (same rule as the windows picker). */
  orderBy?: string;
}

export interface DeliveryDateChoice {
  /** Store-local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Calendar days from today (0 = today, 1 = tomorrow): the relative words are the UI's. */
  offset: number;
  /** Every configured window with whether it can still be booked for this date. */
  windows: Array<{ id: string; available: boolean }>;
}

function minutes(time: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

const iso = (cal: number) => new Date(cal).toISOString().slice(0, 10);

/**
 * The delivery dates a shopper may pick.
 *
 * - The first date is today (store timezone) moved forward by `estimateDays + maxLeadTimeDays`
 *   BUSINESS days (the store's off days skipped; zero days from an off day moves to the next
 *   working day). A made-to-order product with a lead time therefore hides today.
 * - Today is offered only while at least one window can still be booked (`orderBy`, else `start`,
 *   has not passed); with every window past its cut-off the first date is the next working day
 *   (the existing "roll to tomorrow" behaviour). A store with NO windows has no cut-off, so
 *   today stays.
 * - Then `daysAhead` consecutive working days. Future days book every window.
 */
export function deliveryDateChoices(a: {
  now: Date;
  /** IANA store timezone; defaults to Africa/Cairo, a typo falls back to it. */
  timeZone?: string;
  /** Weekdays with no delivery (`getUTCDay` numbers); null/invalid = Friday only, `[]` = every day. */
  offDays?: number[] | null;
  windows: readonly DeliveryDateWindow[];
  daysAhead: number;
  /** Store delivery estimate in business days (`settings.deliveryDays.min`); 0 when none. */
  estimateDays?: number;
  /** The largest `leadTimeDays` among the cart's products; 0 when none. */
  maxLeadTimeDays?: number;
}): DeliveryDateChoice[] {
  const parsed = daysAheadSchema.safeParse(a.daysAhead);
  if (!parsed.success) return [];
  const tz = safeZone(a.timeZone || DEFAULT_TZ);
  const w = wallClock(a.now.getTime(), tz);
  const nowMinutes = w.h * 60 + w.mi;
  const offParsed = deliveryOffDaysSchema.safeParse(a.offDays);
  const off = new Set<number>(offParsed.success ? offParsed.data : DEFAULT_DELIVERY_OFF_DAYS);
  // A UTC-noon number stands for a calendar day; +DAY is always the next calendar day.
  const today = Date.UTC(w.y, w.mo - 1, w.d, 12);
  const working = (cal: number) => !off.has(new Date(cal).getUTCDay());
  const nextWorking = (cal: number) => {
    let c = cal;
    while (!working(c)) c += DAY;
    return c;
  };
  const stepWorking = (cal: number) => nextWorking(cal + DAY);

  let first = today;
  const steps =
    Math.max(0, Math.floor(a.estimateDays ?? 0)) + Math.max(0, Math.floor(a.maxLeadTimeDays ?? 0));
  for (let i = 0; i < steps; i++) first = stepWorking(first);
  first = nextWorking(first);

  const todayWindows = a.windows.map(win => ({
    id: win.id,
    available: nowMinutes < minutes(win.orderBy || win.start),
  }));
  if (first === today && a.windows.length > 0 && !todayWindows.some(x => x.available))
    first = stepWorking(first);

  const out: DeliveryDateChoice[] = [];
  let cal = first;
  for (let i = 0; i < parsed.data; i++) {
    out.push({
      date: iso(cal),
      offset: Math.round((cal - today) / DAY),
      windows:
        cal === today ? todayWindows : a.windows.map(win => ({ id: win.id, available: true })),
    });
    cal = stepWorking(cal);
  }
  return out;
}

/**
 * Check a shopper's pick against `deliveryDateChoices`. `windowsConfigured` = the store has
 * windows switched on with at least one window: then a window is required and must be bookable on
 * that date; without windows a window id is ignored. Returns the chosen date + window id, or why
 * it is refused.
 */
export function checkDeliveryPick(
  choices: readonly DeliveryDateChoice[],
  pick: { deliveryDate?: string | null; deliveryWindowId?: string | null },
  windowsConfigured: boolean
):
  | { ok: true; date: string; windowId: string | null }
  | {
      ok: false;
      reason: 'DATE_REQUIRED' | 'DATE_UNAVAILABLE' | 'WINDOW_REQUIRED' | 'WINDOW_UNAVAILABLE';
    } {
  if (choices.length === 0) return { ok: true, date: '', windowId: null };
  if (!pick.deliveryDate) return { ok: false, reason: 'DATE_REQUIRED' };
  const choice = choices.find(c => c.date === pick.deliveryDate);
  if (!choice) return { ok: false, reason: 'DATE_UNAVAILABLE' };
  if (!windowsConfigured) return { ok: true, date: choice.date, windowId: null };
  const anyBookable = choice.windows.some(x => x.available);
  if (!pick.deliveryWindowId)
    return anyBookable
      ? { ok: false, reason: 'WINDOW_REQUIRED' }
      : { ok: true, date: choice.date, windowId: null };
  const win = choice.windows.find(x => x.id === pick.deliveryWindowId);
  if (!win || !win.available) return { ok: false, reason: 'WINDOW_UNAVAILABLE' };
  return { ok: true, date: choice.date, windowId: win.id };
}

/** "13:00" -> "1:00 PM" / "1:00 م" (the storefront's 12-hour window time, shared with the order note). */
export function formatWindowTime12(time: string, locale: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim());
  if (!match) return time;
  const hours = Number(match[1]);
  const mins = match[2];
  if (!Number.isFinite(hours) || hours > 23 || Number(mins) > 59) return time;
  const isAr = locale === 'ar';
  const period = hours < 12 ? (isAr ? 'ص' : 'AM') : isAr ? 'م' : 'PM';
  return `${hours % 12 === 0 ? 12 : hours % 12}:${mins} ${period}`;
}

/**
 * "Fri 23 Oct" / "الجمعة ٢٣ أكتوبر" for a store-local `YYYY-MM-DD`. Western digits in both
 * languages (NUMERALS-1); the weekday and month words are the platform locale's. Pure: the date
 * string is read as a calendar day, never as an instant, so it cannot slip a day across a timezone.
 */
export function formatDeliveryDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(tag, {
    numberingSystem: 'latn',
    timeZone: 'UTC',
    weekday: locale === 'ar' ? 'long' : 'short',
    day: 'numeric',
    month: locale === 'ar' ? 'long' : 'short',
  })
    .format(at)
    .replace(/[,،]/g, '')
    .trim();
}

/**
 * The line the SERVER writes at the top of an order's notes for a date store (Ruling B4-7):
 * "Delivery: Fri 23 Oct, Evening (6:00 PM-8:00 PM)" / "التوصيل: الجمعة 23 أكتوبر، عشا (6:00 م...)".
 * Same prefix words as the client-written line of today/tomorrow stores, so every reader of the
 * notes string (admin, the orders app, receipts, emails) reads it unchanged.
 */
export function deliveryNoteLine(a: {
  locale: string;
  date: string;
  window?: { label: string; labelAr: string; start: string; end: string } | null;
}): string {
  const ar = a.locale === 'ar';
  const day = formatDeliveryDate(a.date, a.locale);
  const prefix = ar ? 'التوصيل' : 'Delivery';
  if (!a.window) return `${prefix}: ${day}`;
  const label = ar ? a.window.labelAr || a.window.label : a.window.label || a.window.labelAr;
  const range = `${formatWindowTime12(a.window.start, a.locale)}–${formatWindowTime12(a.window.end, a.locale)}`;
  return `${prefix}: ${day}${ar ? '،' : ','} ${label} (${range})`;
}

/**
 * The delivery line at the top of an order's `notes` ("Delivery: Fri 23 Oct, Evening (6:00 PM-8:00 PM)" /
 * "التوصيل: ..."), WITHOUT its prefix, or null. `notes` itself never reaches a shopper (it may carry the
 * merchant's own text), so every shopper-facing surface (receipt, confirmation email) reads only this
 * line, which the server wrote from the structured pick (Ruling B4-7) or the client wrote for
 * today/tomorrow stores. Only the FIRST line counts: a customer who types "Delivery: ..." into their
 * own note cannot forge it.
 */
export function deliveryLineFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const first = notes.split('\n', 1)[0] ?? '';
  const m = /^(?:التوصيل|Delivery):\s*(.+)$/.exec(first.trim());
  return m?.[1]?.trim() || null;
}
