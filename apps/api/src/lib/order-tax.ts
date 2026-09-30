import { prisma } from '@force/database';

/**
 * `computeOrderTax` now lives in `@force/shared` so the storefront checkout
 * and cart summaries can import the SAME formula and never drift from what
 * this API actually charges (ruling M3-6, docs/RULINGS.md). Re-exported here
 * so the existing `@api/lib/order-tax` import path (order.service.ts, this
 * file's own test) keeps working unchanged.
 */
export { computeOrderTax } from '@force/shared';

/**
 * The store's tax rate as a percentage (e.g. 5 for 5%) and whether its listed
 * prices already include it — the two facts `computeOrderTax` needs. ONE
 * resolver for both the CHARGE (order creation) and the DISPLAY (the public
 * storefront payload), so they cannot drift apart (ruling M3-9).
 *
 * Gated on `Store.taxEnabled` ONLY (owner decision 2026-10-01, issue 2166,
 * ruling TAX-1). VAT collection is a legal obligation, not a billing feature:
 * the plan-derived `tax` feature used to gate the charge too, and `free` (the
 * lapsed-payment grace plan) does not carry it, so a merchant whose
 * subscription lapsed silently stopped collecting VAT. The `tax` feature still
 * gates the admin tax PAGES; it can no longer switch collection off. A
 * merchant who flips "Enable tax" off (`taxEnabled: false`) is neither shown
 * a VAT line nor charged one.
 *
 * What it charges: the SUM of every ACTIVE rate (owner decision 2026-10-01,
 * issue 2114, ruling TAX-1) — 5% + 2% charges and shows 7%, matching what the
 * admin tax page lets a merchant configure. It does not read
 * `country`/`state`, `isCompound` or `TaxSettings.defaultTaxRate`: every
 * active rate applies additively to the taxable amount.
 *
 * Returns `{ ratePercent: 0, includedInPrice }` when disabled OR there is no
 * active tax rate — identical to before for every store with tax off.
 */
export interface ActiveTaxRate {
  ratePercent: number;
  includedInPrice: boolean;
}

export async function resolveActiveTaxRate(storeId: string): Promise<ActiveTaxRate> {
  const [store, rates] = await Promise.all([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { taxEnabled: true, taxIncludedInPrice: true },
    }),
    prisma.taxRate.findMany({
      where: { storeId, isActive: true },
      select: { rate: true },
    }),
  ]);

  // Rates are Decimal(5,2)-shaped percentages; sum in hundredths so 0.1 + 0.2
  // is exactly 0.3, never 0.30000000000000004.
  const sumHundredths = rates.reduce((n, r) => n + Math.round(Number(r.rate) * 100), 0);

  return {
    ratePercent: store?.taxEnabled ? sumHundredths / 100 : 0,
    includedInPrice: !!store?.taxIncludedInPrice,
  };
}
