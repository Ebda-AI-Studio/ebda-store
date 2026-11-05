import {
  deliveryDaysSchema,
  deliveryOffDaysSchema,
  DEFAULT_DELIVERY_OFF_DAYS,
  type CheckoutDeliverySettings,
  type DeliveryDays,
} from '@ebda/shared';
import { textFieldValue } from './form-text';

import { roundToMinor } from '@ebda/shared';
/**
 * Payload builder for the per-store checkout-delivery settings page.
 *
 * Extracted from `stores/[id]/delivery/page.tsx` so the empty-field contract
 * is testable ON THE SERIALIZED BODY. This bug does not exist in the
 * pre-serialization object at all: the page spreads the store's existing
 * `settings` and then overrides one key, so an `undefined` override looks
 * correct in memory — and `JSON.stringify` then DROPS that key, leaving the
 * server's shallow merge to resurrect the stale value it was spread over.
 *
 * (Historical: the page used to spread the store's `settings` first.) For `orderInvoiceEmail` that was a live data-exposure bug, not a cosmetic
 * one: a merchant who removed the order-invoice address kept having every
 * order's invoice emailed to it (a possibly-former employee), because the
 * cleared key never reached `StoreService.update`.
 *
 * `null` clears, `undefined` leaves alone — the same three-layer convention
 * as `form-text.ts`. `settings` is a JSON column, so `null` is stored
 * literally; every reader of `settings.orderInvoiceEmail`
 * (`resolveOrderInvoiceRecipient`) type-checks for a non-empty string, so a
 * literal `null` reads exactly like "not configured".
 */

/** Round a EGP string input to integer piastres. Empty/invalid/non-positive
 *  input resolves to 0 (= no minimum), matching the platform's opt-in
 *  convention for this field. */
export function majorInputToMinor(major: string): number {
  const parsed = parseFloat(major);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return roundToMinor(parsed);
}

/**
 * Parse the two "delivery time (business days)" inputs. Both empty = cleared (`null`, which
 * the page sends explicitly: the server's settings merge is shallow, so an omitted key would
 * resurrect the old value). Anything else must be two whole days 0..30 with min <= max.
 */
export function parseDeliveryDaysInput(
  min: string,
  max: string
): { ok: true; value: DeliveryDays | null } | { ok: false } {
  const a = min.trim();
  const b = max.trim();
  if (a === '' && b === '') return { ok: true, value: null };
  if (a === '' || b === '') return { ok: false };
  const parsed = deliveryDaysSchema.safeParse({ min: Number(a), max: Number(b) });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** Weekday numbers (`getUTCDay`) in the Egyptian week order the chips show: Sat Sun ... Fri. */
export const DELIVERY_WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;

/** The stored `deliveryOffDays` as the chip selection: unset/null/invalid = Friday only. */
export function offDaysFromSettings(raw: unknown): number[] {
  const parsed = deliveryOffDaysSchema.safeParse(raw);
  return parsed.success ? [...parsed.data] : [...DEFAULT_DELIVERY_OFF_DAYS];
}

/** The chip selection as the payload value: all seven off is refused (no working day). */
export function parseDeliveryOffDaysInput(
  selected: number[]
): { ok: true; value: number[] } | { ok: false } {
  const parsed = deliveryOffDaysSchema.safeParse([...new Set(selected)].sort((a, b) => a - b));
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * What to send for the chip selection. The default is not pinned: when the selection equals the
 * default AND the store has no saved value, nothing is sent (`undefined`), so a later change of
 * `DEFAULT_DELIVERY_OFF_DAYS` still reaches that store. Any other selection, and any selection
 * on a store that already saved one, is an explicit choice and is sent as is.
 */
export function offDaysForSave(
  selected: number[],
  hasSavedValue: boolean,
  hasInvalidStoredValue = false
): { ok: true; value: number[] | null | undefined } | { ok: false } {
  const parsed = parseDeliveryOffDaysInput(selected);
  if (!parsed.ok) return parsed;
  const isDefault =
    parsed.value.length === DEFAULT_DELIVERY_OFF_DAYS.length &&
    parsed.value.every((d, i) => d === DEFAULT_DELIVERY_OFF_DAYS[i]);
  if (isDefault && !hasSavedValue) {
    // A stored value the schema rejects would be spread back and fail every save of the page
    // (invoice email, zones, ...): reset it to the default (null) instead of leaving it.
    return { ok: true, value: hasInvalidStoredValue ? null : undefined };
  }
  return { ok: true, value: parsed.value };
}

/** True when the store has a valid saved `deliveryOffDays` (so the chips show a stored choice). */
/** True when `deliveryOffDays` is present but not a valid array (script write, future import). */
export function hasInvalidOffDays(raw: unknown): boolean {
  return raw !== undefined && raw !== null && !deliveryOffDaysSchema.safeParse(raw).success;
}

export function hasSavedOffDays(raw: unknown): boolean {
  return deliveryOffDaysSchema.safeParse(raw).success && raw !== undefined && raw !== null;
}

export interface CheckoutDeliveryForm {
  config: CheckoutDeliverySettings;
  /** Raw EGP string the merchant typed; empty = no minimum. */
  minimumOrderMajor: string;
  /** Raw (untrimmed) order-invoice address; empty = feature off. */
  orderInvoiceEmail: string;
  /** Store-wide delivery estimate; `null` clears it, `undefined` leaves the stored value. */
  deliveryDays?: DeliveryDays | null;
  /** Weekdays with no delivery; `[]` = every day, `null` clears to the Friday default, `undefined` leaves it. */
  deliveryOffDays?: number[] | null;
}

/**
 * ONLY this page's keys (BE:F-2). The page no longer reads the whole `settings` blob and spreads it back: that
 * read-modify-write of every key let a stale tab revert another page's save (branding, widget, ...). The server
 * merges `settings` shallowly against the live row, so a key not sent here is simply left alone.
 */
export function buildCheckoutDeliverySettings(form: CheckoutDeliveryForm): Record<string, unknown> {
  return {
    checkoutDelivery: form.config,
    minimumOrderFils: majorInputToMinor(form.minimumOrderMajor),
    // 'update' — this page only ever edits an existing store, so an emptied
    // address must send an explicit null that survives JSON.stringify and
    // overwrites the stored value on the server's shallow merge.
    orderInvoiceEmail: textFieldValue(form.orderInvoiceEmail.trim(), 'update'),
    // null is the cleared form (see orderInvoiceEmail); undefined keeps the spread-through value.
    ...(form.deliveryDays !== undefined ? { deliveryDays: form.deliveryDays } : {}),
    ...(form.deliveryOffDays !== undefined ? { deliveryOffDays: form.deliveryOffDays } : {}),
  };
}
