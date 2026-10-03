/**
 * Per-store minimum order value guard.
 *
 * Shared between the API's order-creation service (the real, hard-blocking
 * guard) and the storefront (soft UX guard: disable the checkout CTA before
 * the customer ever reaches the API). Both call sites need the identical
 * below/at/above rule, so it lives here once instead of being re-implemented
 * per surface.
 *
 * Config lives in `Store.settings.minimumOrderFils` (piastres; no dedicated DB
 * column — same JSON-settings pattern as `checkoutDelivery`). `0` or
 * `undefined`/`null` means "no minimum configured", the platform-standard
 * opt-in convention used by every other per-store settings flag.
 *
 * The check compares the ITEMS SUBTOTAL only (before shipping/tax/discounts)
 * against the configured minimum — callers must pass the raw subtotal.
 */

export interface MinimumOrderCheck {
  /** True when the store has no minimum configured, or the subtotal already
   *  meets/exceeds it. */
  met: boolean;
  /** Piastres still needed to reach the minimum. 0 when `met` is true. */
  shortfallFils: number;
}

/**
 * Evaluate the minimum-order rule for a given subtotal.
 *
 * - `minimumOrderFils` <= 0, null, or undefined → always met (no minimum).
 * - `subtotalFils >= minimumOrderFils` → met (equality passes).
 * - Otherwise → not met, with the exact piastres shortfall.
 */
export function checkMinimumOrder(
  subtotalFils: number,
  minimumOrderFils: number | null | undefined
): MinimumOrderCheck {
  if (!minimumOrderFils || minimumOrderFils <= 0) {
    return { met: true, shortfallFils: 0 };
  }
  if (subtotalFils >= minimumOrderFils) {
    return { met: true, shortfallFils: 0 };
  }
  return { met: false, shortfallFils: minimumOrderFils - subtotalFils };
}
