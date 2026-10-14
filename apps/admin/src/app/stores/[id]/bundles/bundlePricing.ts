/**
 * Pure bundle-editor math + response parsing (Task 9: admin UI for
 * apps/api/src/routes/bundle.routes.ts, Task 4).
 *
 * Kept dependency-free of React/Next so it can be unit-tested the same way
 * `areaRateValidation.ts` is tested for the shipping area-rate editor — see
 * `apps/admin/src/app/stores/[id]/shipping/_components/__tests__/
 * AreaRateEditor.getIncompleteNewRows.test.ts` for the sibling convention
 * this file follows.
 */
import type { BundleLine } from '@ebda/shared';

import { roundToMinor } from '@ebda/shared';
/**
 * Availability sentinel for "every component is untracked" — mirrors
 * `UNTRACKED_AVAILABILITY_CAP` in `apps/api/src/services/bundle.service.ts`
 * EXACTLY (same value, same reasoning: a plain finite integer far above any
 * real stock level, safe to multiply by a bundle quantity, never
 * `Number.MAX_SAFE_INTEGER`/`Infinity`). Not importable from there — the
 * admin app (Next.js) cannot depend on apps/api's source — so this is a
 * deliberate, small, byte-for-byte port kept in sync by convention/review,
 * not an independent constant. This value never reaches a write; it is a
 * PREVIEW the merchant sees while editing. The server (`resolveBundle`) is
 * authoritative for every read/write of the real `available` count.
 */
export const UNTRACKED_AVAILABILITY_CAP = 1_000_000;

export interface ClientAvailabilityItem {
  quantity: number;
  trackInventory: boolean;
  availableStock: number;
}

/**
 * Client-side port of `bundleAvailability` in
 * `apps/api/src/services/bundle.service.ts`: how many whole bundles the
 * component stock can make right now — `min(floor(availableStock/quantity))`
 * over components that track inventory. An empty bundle is 0 (not
 * Infinity — `Math.min()` of nothing IS Infinity, which would render a
 * contentless bundle as infinitely purchasable). A bundle whose components
 * are ALL untracked returns `UNTRACKED_AVAILABILITY_CAP` — untracked is not
 * the same thing as no stock.
 */
export function computeAvailability(items: ClientAvailabilityItem[]): number {
  if (items.length === 0) return 0;

  let min = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (!item.trackInventory) continue;
    min = Math.min(min, Math.floor(item.availableStock / item.quantity));
  }

  return min === Number.POSITIVE_INFINITY ? UNTRACKED_AVAILABILITY_CAP : Math.max(0, min);
}

/** sum(unitPrice * quantity) across the bundle's component lines, in piastres. */
export function computeComponentSum(lines: Array<{ unitPrice: number; quantity: number }>): number {
  return lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
}

/** Converts the picker's line rows into the `BundleLine[]` shape the
 *  `@ebda/shared` pricing/allocation functions take (keyed positionally —
 *  the key only needs to be unique within one preview computation). */
export function toBundleLines(items: Array<{ unitPrice: number; quantity: number }>): BundleLine[] {
  return items.map((it, i) => ({ key: String(i), unitPrice: it.unitPrice, quantity: it.quantity }));
}

/**
 * `percentage` pricingValue is basis points — 12.5% is stored as 1250 (see
 * bundle.routes.ts's createSchema comment). The admin form lets the
 * merchant type a plain percent (12.5); this converts it to the wire value.
 * Rounds to the nearest basis point (0.01%).
 */
export function percentToBasisPoints(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.round(percent * 100);
}

/** Inverse of {@link percentToBasisPoints}, for prefilling the edit form. */
export function basisPointsToPercent(bps: number): number {
  return bps / 100;
}

/** Parses the merchant's EGP input (e.g. "11.999") into integer piastres, the
 *  wire unit every money field in this API uses. Non-numeric/empty input is
 *  treated as 0 piastres rather than NaN, matching promotions/page.tsx's
 *  `parseFloat(...) || 0` convention for the same kind of field. */
export function majorToMinor(major: string): number {
  const n = parseFloat(major);
  return Number.isFinite(n) ? roundToMinor(n) : 0;
}

/**
 * Extracts the variant array from a `GET /stores/:id/products/:productId/
 * variants` response body.
 *
 * `VariantService.getProductVariants` (apps/api/src/services/
 * variant.service.ts) returns `variants` as a SIBLING of `product` and
 * `options` — `{ product: {...}, options: [...], variants: [...] }` — NOT
 * nested inside `product`. Fix round 1 found this picker (and, pre-
 * existing and out of this branch's scope, `orders/new/page.tsx`) reading
 * `data.product.variants`, which is always `undefined` against the real
 * endpoint: every product with variants showed an empty "choose a variant"
 * panel with zero buttons, so a variant-pinned bundle component could
 * never be added, and on edit a variant-pinned line's `availableStock`
 * silently defaulted to 0. Routing BOTH call sites (`BundleItemPicker.tsx`
 * and `page.tsx`'s edit-hydration) through this ONE function means that
 * regression is one unit test against a realistic payload, not two
 * independent chances to get the same path wrong again.
 */
export function extractVariantOptions<T extends { id: string }>(
  data: { variants?: T[] } | null | undefined
): T[] {
  return data?.variants ?? [];
}

/**
 * Which zero-price warning the editor should show, if any.
 *
 * Extracted rather than written inline in `page.tsx` for the reason Ruling
 * P2-c records: a predicate that only exists inside JSX can only be
 * "tested" by grepping the source, which is blind to an arithmetic
 * regression. `page.tsx` renders whichever key this returns.
 *
 *  - `'discountAboveComponentSum'` — a `fixed` (piastres-off) discount worth the
 *    whole component total. `computeBundlePrice` clamps at 0, so the preview
 *    shows a free box rather than a negative one and the merchant has no
 *    reason to expect the save to be refused; the server answers
 *    `422 PRICE_ABOVE_COMPONENT_SUM` (`assertPriceWithinComponentSum` in
 *    bundle.routes.ts).
 *  - `'zeroPriceWillNotSell'` — any OTHER way to reach a 0 price over
 *    components that cost something (a literal `fixed_price: 0`, or a 100%
 *    `percentage`). Both are values the save path deliberately still
 *    ACCEPTS, but `isPurchasable` (bundle.service.ts) refuses to sell a
 *    0-priced box whose components are not themselves free — so without this
 *    the bundle would save cleanly and then never appear on the storefront,
 *    with nothing anywhere saying why.
 *  - `null` — nothing to say: no components yet (a merchant mid-edit is not
 *    misconfigured), free components (a kit of free items is honestly worth
 *    0 and DOES sell), or a real price.
 *
 * Advisory only: `componentSum` here is the merchant's own preview, which
 * can be stale. The server's is authoritative at save time.
 */
export function zeroPriceWarning(input: {
  pricingType: 'fixed_price' | 'percentage' | 'fixed';
  componentSum: number;
  pricingValueFils: number;
  derivedPrice: number;
  itemCount: number;
}): 'discountAboveComponentSum' | 'zeroPriceWillNotSell' | null {
  const { pricingType, componentSum, pricingValueFils, derivedPrice, itemCount } = input;
  if (itemCount === 0 || componentSum <= 0) return null;
  if (pricingType === 'fixed' && pricingValueFils >= componentSum) {
    return 'discountAboveComponentSum';
  }
  return derivedPrice === 0 ? 'zeroPriceWillNotSell' : null;
}
