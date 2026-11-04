import { withStore } from '@ebda/database';
import { storeRepo, type StoreReads } from './repo-factory';

/**
 * `computeOrderTax` now lives in `@ebda/shared` so the storefront checkout
 * and cart summaries can import the SAME formula and never drift from what
 * this API actually charges (ruling M3-6, docs/RULINGS.md). Re-exported here
 * so the existing `@api/lib/order-tax` import path (order.service.ts, this
 * file's own test) keeps working unchanged.
 */
export { computeOrderTax } from '@ebda/shared';

/**
 * The store's tax rate as a percentage (e.g. 14 for 14%) and whether its listed
 * prices already include it — the two facts `computeOrderTax` needs. ONE
 * resolver for both the CHARGE (order creation, public checkout and admin
 * orders) and the DISPLAY (the public storefront payloads), so they cannot
 * drift apart (ruling M3-9). Every place a tax line can be produced reads it.
 *
 * THE VAT GATE (ruling TAX-2, supersedes TAX-1's "taxEnabled alone"): VAT is
 * charged only when the merchant wants it (`Store.taxEnabled`) AND its VAT
 * registration is VERIFIED by a super-admin (`StoreTaxProfile.status =
 * 'verified'`). An unregistered seller issuing a VAT invoice is tax evasion
 * (Egypt Law 67/2016 Art. 68 item 8). Fail closed: no profile, or any status
 * other than `verified` (none / pending / rejected / revoked), yields 0 — a
 * store that had `taxEnabled = true` before the gate shipped stops charging
 * without its row being rewritten (ruling TAX-3).
 *
 * Still NOT plan-gated (ruling TAX-1a stands): a verified merchant whose
 * subscription lapsed keeps collecting the VAT it owes.
 *
 * What it charges: the SUM of every ACTIVE rate (ruling TAX-1) — 5% + 2%
 * charges and shows 7%. It does not read `country`/`state`, `priority`,
 * `isCompound` or `defaultTaxRate` (ruling TAX-1a).
 *
 * `seller` is the verified identity the order freezes for its tax invoice
 * (seller TRN + legal name); `null` whenever `ratePercent` is 0.
 */
export interface ActiveTaxRate {
  ratePercent: number;
  includedInPrice: boolean;
  seller: { taxRegistrationNumber: string; legalName: string } | null;
}

export async function resolveActiveTaxRate(storeId: string): Promise<ActiveTaxRate> {
  // The public storefront payloads call this before any store scope exists;
  // order creation calls it inside one. withStore serves both (and reuses an
  // existing scope for the same store).
  // The three reads are the same on both backends; a store on its Durable Object reads its own tables (TaxRate and
  // StoreTaxProfile are store-do models) and never opens a Postgres transaction (NEON-ZERO-1 N-5).
  const read = (db: StoreReads) =>
    Promise.all([
      db.store.findUnique({
        where: { id: storeId },
        select: { taxEnabled: true, taxIncludedInPrice: true },
      }),
      db.taxRate.findMany({
        where: { storeId, isActive: true },
        select: { rate: true },
      }),
      db.storeTaxProfile.findUnique({
        where: { storeId },
        select: { status: true, taxRegistrationNumber: true, legalName: true },
      }),
    ]);
  const repo = await storeRepo(storeId);
  const [store, rates, profile] =
    repo.backend === 'do'
      ? await read(repo.db)
      : await withStore(storeId, tx => read(tx as unknown as StoreReads));

  // Rates are Decimal(5,2)-shaped percentages; sum in hundredths so 0.1 + 0.2
  // is exactly 0.3, never 0.30000000000000004.
  const sumHundredths = rates.reduce((n, r) => n + Math.round(Number(r.rate) * 100), 0);

  const verified =
    profile?.status === 'verified' && !!profile.taxRegistrationNumber && !!profile.legalName;
  const collecting = !!store?.taxEnabled && verified && sumHundredths > 0;

  return {
    ratePercent: collecting ? sumHundredths / 100 : 0,
    includedInPrice: !!store?.taxIncludedInPrice,
    seller: collecting
      ? { taxRegistrationNumber: profile!.taxRegistrationNumber!, legalName: profile!.legalName! }
      : null,
  };
}

/**
 * The tax-invoice identity an order freezes at creation (ruling TAX-2): set
 * ONLY when the order was priced under a verified profile, so a later revoke or
 * TRN change never rewrites a past invoice, and an unverified store's invoice
 * carries no VAT wording at all. Spread into `order.create({ data })`.
 */
export function frozenTaxInvoiceFields(activeTax: ActiveTaxRate): {
  sellerTaxRegistrationNumber: string | null;
  sellerTaxLegalName: string | null;
  taxRateBps: number | null;
} {
  if (!activeTax.seller || activeTax.ratePercent <= 0) {
    return { sellerTaxRegistrationNumber: null, sellerTaxLegalName: null, taxRateBps: null };
  }
  return {
    sellerTaxRegistrationNumber: activeTax.seller.taxRegistrationNumber,
    sellerTaxLegalName: activeTax.seller.legalName,
    taxRateBps: Math.round(activeTax.ratePercent * 100),
  };
}

/**
 * The tax facts a public storefront payload carries: the gated rate and the
 * EFFECTIVE `taxEnabled` (true only while VAT is actually being charged), so
 * the merchant's raw wish never reaches a storefront render path (ruling TAX-2).
 */
export function effectiveTaxFields(activeTax: ActiveTaxRate): {
  taxRatePercent: number;
  taxEnabled: boolean;
} {
  return { taxRatePercent: activeTax.ratePercent, taxEnabled: activeTax.ratePercent > 0 };
}
