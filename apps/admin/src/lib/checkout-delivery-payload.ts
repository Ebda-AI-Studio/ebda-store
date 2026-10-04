import type { CheckoutDeliverySettings } from '@force/shared';
import { textFieldValue } from './form-text';

import { roundToMinor } from '@force/shared';
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
 * For `orderInvoiceEmail` that was a live data-exposure bug, not a cosmetic
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

export interface CheckoutDeliveryForm {
  /** The store's current `settings` JSON, spread through untouched. */
  existingSettings: Record<string, unknown>;
  config: CheckoutDeliverySettings;
  /** Raw EGP string the merchant typed; empty = no minimum. */
  minimumOrderMajor: string;
  /** Raw (untrimmed) order-invoice address; empty = feature off. */
  orderInvoiceEmail: string;
}

export function buildCheckoutDeliverySettings(form: CheckoutDeliveryForm): Record<string, unknown> {
  return {
    ...form.existingSettings,
    checkoutDelivery: form.config,
    minimumOrderFils: majorInputToMinor(form.minimumOrderMajor),
    // 'update' — this page only ever edits an existing store, so an emptied
    // address must send an explicit null that survives JSON.stringify and
    // overwrites the stored value on the server's shallow merge.
    orderInvoiceEmail: textFieldValue(form.orderInvoiceEmail.trim(), 'update'),
  };
}
