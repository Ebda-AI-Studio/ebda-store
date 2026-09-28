import { prisma } from '@force/database';
import { featureService } from '../services/feature.service';

/**
 * `computeOrderTax` now lives in `@force/shared` so the storefront checkout
 * and cart summaries can import the SAME formula and never drift from what
 * this API actually charges (ruling M3-6, docs/RULINGS.md). Re-exported here
 * so the existing `@api/lib/order-tax` import path (order.service.ts, this
 * file's own test) keeps working unchanged.
 */
export { computeOrderTax } from '@force/shared';

/**
 * The store's active tax rate as a percentage (e.g. 5 for 5%) and whether
 * its listed prices already include it — the two facts `computeOrderTax`
 * needs. ONE resolver for both the CHARGE (order creation) and the DISPLAY
 * (the public storefront payload), so they cannot drift apart again
 * (overriding ruling M3-7's accepted residual — see M3-9, docs/RULINGS.md,
 * 2026-09-26: production has 0 rows in `tax_rates` and `taxEnabled: false`
 * on all 3 live stores, so gating the charge the same way as the display
 * changes nothing charged today).
 *
 * Gated on BOTH `Store.taxEnabled` and the `tax` feature — the same two
 * gates `TaxService.calculateTax` already applies
 * (apps/api/src/services/tax.service.ts:201-207) — so a merchant who flips
 * "Enable tax" off (which only PATCHes `taxEnabled`; existing `TaxRate`
 * rows keep `isActive: true`) is neither shown a VAT line NOR charged one.
 *
 * Deterministically ordered (`priority desc, createdAt asc, id asc`,
 * `take: 1`) so a store with more than one active rate charges — and
 * shows — the SAME row every call, rather than whatever order Postgres
 * happens to return with no ORDER BY.
 *
 * Returns `{ ratePercent: 0, includedInPrice: false }` when disabled OR
 * there is no active tax rate — identical to before for every store with
 * tax off.
 */
export interface ActiveTaxRate {
  ratePercent: number;
  includedInPrice: boolean;
}

export async function resolveActiveTaxRate(storeId: string): Promise<ActiveTaxRate> {
  const [store, taxFeatureEnabled, rates] = await Promise.all([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { taxEnabled: true, taxIncludedInPrice: true },
    }),
    featureService.isFeatureEnabled(storeId, 'tax'),
    prisma.taxRate.findMany({
      where: { storeId, isActive: true },
      select: { rate: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 1,
    }),
  ]);

  const enabled = !!store?.taxEnabled && taxFeatureEnabled;

  return {
    ratePercent: enabled && rates.length > 0 ? Number(rates[0].rate) : 0,
    includedInPrice: !!store?.taxIncludedInPrice,
  };
}
