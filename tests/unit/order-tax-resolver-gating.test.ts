/**
 * Ruling M3-9 (docs/RULINGS.md, overriding M3-7's accepted residual): the
 * CHARGE must use the SAME gate as the DISPLAY. `resolveActiveTaxRate` is
 * now the ONE resolver both `order.service.ts` (the charge) and
 * `public.routes.ts` (the public storefront payload) call — gated on BOTH
 * `Store.taxEnabled` and the `tax` feature, the same two gates
 * `TaxService.calculateTax` already applies
 * (apps/api/src/services/tax.service.ts:201-207). A single function means
 * the charge and the display cannot drift apart again — there is only one
 * place left for either to read the wrong thing.
 *
 * Production check (2026-09-26, read-only): 0 rows in `tax_rates` and
 * `taxEnabled: false` on all 3 live stores, so this gate changes nothing
 * charged today.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const storeFindUnique = vi.fn();
const taxRateFindMany = vi.fn();
const isFeatureEnabled = vi.fn();

vi.mock('@force/database', () => ({
  prisma: {
    store: { findUnique: (...args: unknown[]) => storeFindUnique(...args) },
    taxRate: { findMany: (...args: unknown[]) => taxRateFindMany(...args) },
  },
}));

vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args) },
}));

const { resolveActiveTaxRate } = await import('@api/lib/order-tax');

describe('resolveActiveTaxRate — ONE resolver, same gate for charge and display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taxRateFindMany.mockResolvedValue([{ rate: '5.00' }]);
  });

  it('taxEnabled=false + an active rate row: rate is 0 (charged AND displayed)', () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: false, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(true);
    return resolveActiveTaxRate('store-1').then(result => {
      expect(result).toEqual({ ratePercent: 0, includedInPrice: false });
    });
  });

  it('the `tax` feature off + an active rate row: rate is 0, even with taxEnabled true', () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(false);
    return resolveActiveTaxRate('store-1').then(result => {
      expect(result).toEqual({ ratePercent: 0, includedInPrice: false });
    });
  });

  it('taxEnabled=true + the `tax` feature on + an active rate row: the real rate (charged AND displayed)', () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(true);
    return resolveActiveTaxRate('store-1').then(result => {
      expect(result).toEqual({ ratePercent: 5, includedInPrice: false });
    });
  });

  it('no active rate row at all: 0 regardless of the gates', () => {
    taxRateFindMany.mockResolvedValue([]);
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(true);
    return resolveActiveTaxRate('store-1').then(result => {
      expect(result).toEqual({ ratePercent: 0, includedInPrice: false });
    });
  });

  it('reports includedInPrice regardless of the enabled gate (a disabled store still needs the flag it just zeroed to make sense of)', () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: false, taxIncludedInPrice: true });
    isFeatureEnabled.mockResolvedValue(true);
    return resolveActiveTaxRate('store-1').then(result => {
      expect(result).toEqual({ ratePercent: 0, includedInPrice: true });
    });
  });

  it('resolves with a deterministic ORDER BY, not an unordered pick', () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(true);
    return resolveActiveTaxRate('store-1').then(() => {
      expect(taxRateFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: 'store-1', isActive: true },
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
          take: 1,
        })
      );
    });
  });

  it('checks the `tax` feature key specifically', () => {
    storeFindUnique.mockResolvedValue({ taxEnabled: true, taxIncludedInPrice: false });
    isFeatureEnabled.mockResolvedValue(true);
    return resolveActiveTaxRate('store-1').then(() => {
      expect(isFeatureEnabled).toHaveBeenCalledWith('store-1', 'tax');
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

  it('order.service.ts (the charge) calls resolveActiveTaxRate at both call sites', () => {
    const occurrences = orderService.match(/resolveActiveTaxRate\(storeId\)/g) ?? [];
    expect(occurrences.length).toBe(2); // storefront checkout + the admin manual-order path
  });

  it('public.routes.ts (the display) calls resolveActiveTaxRate at both call sites', () => {
    const occurrences = publicRoutes.match(/resolveActiveTaxRate\(store\.id\)/g) ?? [];
    expect(occurrences.length).toBe(2); // /stores/:slugOrId + /store/resolve
  });

  it('public.routes.ts reads .ratePercent off the same shape order.service.ts reads .ratePercent/.includedInPrice from', () => {
    expect(publicRoutes).toMatch(/\(await resolveActiveTaxRate\(store\.id\)\)\.ratePercent/);
  });
});
