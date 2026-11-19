/**
 * Ruling M3-9 (docs/RULINGS.md, overriding M3-7's accepted residual): the
 * CHARGE must use the SAME gate as the DISPLAY. `resolveActiveTaxRate` is
 * now the ONE resolver both `order.service.ts` (the charge) and
 * `public.routes.ts` (the public storefront payload) call — gated on
 * `Store.taxEnabled` only (issue 2166) and summing every active rate
 * (issue 2114). A single function means
 * the charge and the display cannot drift apart again — there is only one
 * place left for either to read the wrong thing.
 *
 * Production check (2026-09-26, read-only): 0 rows in `tax_rates` and
 * `taxEnabled: false` on all 3 live stores, so this gate changes nothing
 * charged today.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const storeFindUnique = vi.fn();
const taxRateFindMany = vi.fn();
const profileFindUnique = vi.fn();
const isFeatureEnabled = vi.fn();

vi.mock('@ebda/database', () => {
  const client = {
    store: { findUnique: (...args: unknown[]) => storeFindUnique(...args) },
    taxRate: { findMany: (...args: unknown[]) => taxRateFindMany(...args) },
    storeTaxProfile: { findUnique: (...args: unknown[]) => profileFindUnique(...args) },
  };
  return {
    prisma: client,
    withStore: (_storeId: string, fn: (tx: typeof client) => unknown) => fn(client),
  };
});

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args) },
}));

const { resolveActiveTaxRate, frozenTaxInvoiceFields, effectiveTaxFields } =
  await import('@api/lib/order-tax');

const VERIFIED = { status: 'verified', taxRegistrationNumber: '123456789', legalName: 'Acme LLC' };
const SELLER = { taxRegistrationNumber: '123456789', legalName: 'Acme LLC' };

describe('resolveActiveTaxRate — ONE resolver, same gate for charge and display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taxRateFindMany.mockResolvedValue([{ rate: '5.00' }]);
    profileFindUnique.mockResolvedValue(VERIFIED);
  });

  it('taxEnabled=false + an active rate row: rate is 0 (charged AND displayed)', async () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: false, taxIncludedInPrice: false });
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 0,
      includedInPrice: false,
      seller: null,
    });
  });

  // issue 2166 (owner 2026-10-01, ruling TAX-1, kept by TAX-2): VAT is a legal
  // obligation, not a plan feature. A VERIFIED store that lapsed to `free` keeps
  // collecting. Mutation-proof: re-adding the feature gate reddens it.
  it('collects VAT whatever the plan: the `tax` feature is never consulted', async () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(false); // e.g. a store on the `free` plan
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 5,
      includedInPrice: false,
      seller: SELLER,
    });
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });

  it('taxEnabled=true + verified + an active rate row: the real rate (charged AND displayed)', async () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 5,
      includedInPrice: false,
      seller: SELLER,
    });
  });

  // issue 2114 (owner 2026-10-01, ruling TAX-1): several active rates are
  // charged as their SUM. Mutation-proof: taking one row reddens it.
  it('several active rates charge their SUM (5% + 2% = 7%), exactly', async () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    taxRateFindMany.mockResolvedValue([{ rate: '5.00' }, { rate: '2.00' }]);
    expect((await resolveActiveTaxRate('store-1')).ratePercent).toBe(7);
    taxRateFindMany.mockResolvedValue([{ rate: '0.10' }, { rate: '0.20' }]);
    expect((await resolveActiveTaxRate('store-1')).ratePercent).toBe(0.3);
  });

  it('reads every active rate, not one', async () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    await resolveActiveTaxRate('store-1');
    const args = taxRateFindMany.mock.calls[0][0];
    expect(args.where).toEqual({ storeId: 'store-1', isActive: true });
    expect(args.take).toBeUndefined();
  });

  it('no active rate row at all: 0', async () => {
    taxRateFindMany.mockResolvedValue([]);
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 0,
      includedInPrice: false,
      seller: null,
    });
  });

  it('reports includedInPrice regardless of the enabled gate', async () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: false, taxIncludedInPrice: true });
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 0,
      includedInPrice: true,
      seller: null,
    });
  });
});

/**
 * THE VAT GATE (ruling TAX-2, supersedes TAX-1's "taxEnabled alone"): an
 * unregistered seller issuing a VAT invoice is tax evasion (Egypt Law 67/2016
 * Art. 68 item 8). With `taxEnabled: true` AND an active rate, every status but
 * `verified` charges 0 — the store a merchant enabled before the gate shipped
 * stops charging without its row being rewritten (ruling TAX-3).
 *
 * Mutation proof (recorded in the PR): deleting `verified &&` from the
 * `collecting` predicate in lib/order-tax.ts reddens every case below.
 */
describe('the VAT gate: taxEnabled is not enough — the profile must be VERIFIED', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taxRateFindMany.mockResolvedValue([{ rate: '14.00' }]);
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
  });

  it('no tax profile at all: 0 and no seller', async () => {
    profileFindUnique.mockResolvedValue(null);
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 0,
      includedInPrice: false,
      seller: null,
    });
  });

  for (const status of ['none', 'pending', 'rejected', 'revoked']) {
    it(`status ${status}: 0 and no seller`, async () => {
      profileFindUnique.mockResolvedValue({ ...VERIFIED, status });
      const r = await resolveActiveTaxRate('store-1');
      expect(r.ratePercent).toBe(0);
      expect(r.seller).toBeNull();
    });
  }

  it('verified but missing the TRN or legal name (a corrupted row) fails closed', async () => {
    profileFindUnique.mockResolvedValue({ ...VERIFIED, taxRegistrationNumber: null });
    expect((await resolveActiveTaxRate('store-1')).ratePercent).toBe(0);
    profileFindUnique.mockResolvedValue({ ...VERIFIED, legalName: '' });
    expect((await resolveActiveTaxRate('store-1')).ratePercent).toBe(0);
  });

  it('verified: 14% and the seller identity for the tax invoice', async () => {
    profileFindUnique.mockResolvedValue(VERIFIED);
    expect(await resolveActiveTaxRate('store-1')).toEqual({
      ratePercent: 14,
      includedInPrice: false,
      seller: SELLER,
    });
  });

  it('reads the profile of the SAME store', async () => {
    profileFindUnique.mockResolvedValue(VERIFIED);
    await resolveActiveTaxRate('store-42');
    expect(profileFindUnique.mock.calls[0][0].where).toEqual({ storeId: 'store-42' });
  });

  it('frozenTaxInvoiceFields: identity + bps only while collecting, else all null', () => {
    expect(
      frozenTaxInvoiceFields({ ratePercent: 14, includedInPrice: false, seller: SELLER })
    ).toEqual({
      sellerTaxRegistrationNumber: '123456789',
      sellerTaxLegalName: 'Acme LLC',
      taxRateBps: 1400,
    });
    expect(
      frozenTaxInvoiceFields({ ratePercent: 0, includedInPrice: false, seller: null })
    ).toEqual({ sellerTaxRegistrationNumber: null, sellerTaxLegalName: null, taxRateBps: null });
  });

  it('effectiveTaxFields: the storefront never sees the raw taxEnabled wish', () => {
    expect(effectiveTaxFields({ ratePercent: 0, includedInPrice: false, seller: null })).toEqual({
      taxRatePercent: 0,
      taxEnabled: false,
    });
    expect(effectiveTaxFields({ ratePercent: 14, includedInPrice: true, seller: SELLER })).toEqual({
      taxRatePercent: 14,
      taxEnabled: true,
    });
  });
});

/**
 * Both the charge (order.service.ts) and the display (public.routes.ts)
 * must call THIS resolver — not a second, independently-gated copy. Source
 * assertion, same reasoning as checkout-cart-tax-total-wiring.test.ts: this
 * is call-site wiring, not the resolver's own logic (covered above).
 */
describe('resolveActiveTaxRate is the ONLY resolver — both call sites use it', () => {
  const R = join(__dirname, '../..');
  const orderService = readFileSync(join(R, 'apps/api/src/services/order.service.ts'), 'utf8');
  const publicRoutes = readFileSync(join(R, 'apps/api/src/routes/public.routes.ts'), 'utf8');
  const orderTaxLib = readFileSync(join(R, 'apps/api/src/lib/order-tax.ts'), 'utf8');

  it('there is no second, ungated resolver left in order-tax.ts', () => {
    expect(orderTaxLib).not.toMatch(/resolveDisplayTaxRatePercent/);
    expect(orderTaxLib).toMatch(/export async function resolveActiveTaxRate/);
  });

  // issue 2167 / issue 2211 — the old assertion only grepped order-tax.ts, so
  // TaxService.calculateTax (a public, differently-gated resolver) survived
  // next to it. Sweep the WHOLE API for anything else that reads tax_rates to
  // compute a rate: only order-tax.ts may, plus the admin CRUD in
  // tax.service.ts (list/get/create/update/delete/toggle — no computation).
  it('no other module in apps/api computes an order tax rate', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
        return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
      });
    const offenders = walk(join(R, 'apps/api/src')).filter(f => {
      if (f.endsWith('lib/order-tax.ts')) return false;
      const src = readFileSync(f, 'utf8');
      return /calculateTax\s*\(/.test(src) || /taxRate\.findMany\([^)]*isActive:\s*true/s.test(src)
        ? !f.endsWith('services/tax.service.ts') || /calculateTax\s*\(/.test(src)
        : false;
    });
    expect(offenders.map(f => f.slice(R.length + 1))).toEqual([]);
  });

  it('order.service.ts (the charge) calls resolveActiveTaxRate at both call sites', () => {
    const occurrences = orderService.match(/resolveActiveTaxRate\(storeId\)/g) ?? [];
    expect(occurrences.length).toBe(2); // storefront checkout + the admin manual-order path
  });

  // PERF-BATCH-1: both display sites (/stores/:slugOrId + /store/resolve) read their per-store data through ONE helper,
  // `storePayloadParts`, which calls the resolver; each site spreads its result.
  it('public.routes.ts (the display) calls resolveActiveTaxRate for both call sites', () => {
    const occurrences = publicRoutes.match(/resolveActiveTaxRate\(store\.id\)/g) ?? [];
    expect(occurrences.length).toBe(1); // inside storePayloadParts
    expect(publicRoutes).toMatch(
      /async function storePayloadParts[\s\S]{0,600}resolveActiveTaxRate\(store\.id\)/
    );
    expect(publicRoutes.match(/await storePayloadParts\(store\)/g) ?? []).toHaveLength(2);
  });

  it('public.routes.ts derives taxRatePercent AND the effective taxEnabled from the same resolver (ruling TAX-2)', () => {
    const occurrences = publicRoutes.match(/\.\.\.effectiveTaxFields\(parts\.tax\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it('both order paths freeze the tax-invoice identity from the resolver (ruling TAX-2)', () => {
    const occurrences = orderService.match(/\.\.\.frozenTaxInvoiceFields\(activeTax\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
