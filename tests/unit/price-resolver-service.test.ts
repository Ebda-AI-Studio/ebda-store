/**
 * PriceResolver loader (docs/plans/2026-10-21-b2b-wholesale.md, Task 2). The pure arithmetic is pinned in
 * packages/shared/src/__tests__/price-resolver.test.ts; this file pins what the LOADER decides: who the buyer is
 * (Ruling B2B-2: authenticated user id only), whether wholesale pricing is on at all (Review Focus 13), and the
 * quantity scoping across cart lines (Ruling B2B-4). Prisma and the feature service are mocked, so every assertion is
 * about the QUERIES the loader issues and the price it returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  customerFindFirst: vi.fn(),
  tierFindMany: vi.fn(),
  featureOn: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    user: { findFirst: m.userFindFirst },
    customer: { findFirst: m.customerFindFirst },
    productPriceTier: { findMany: m.tierFindMany },
  },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureOn },
}));

import { PriceResolver } from '@api/services/price-resolver.service';

const STORE = 'store-a';
const OTHER_STORE = 'store-b';
const USER = 'user-1';
const GROUP = 'group-w';
const P1 = { id: 'p1', price: 10_000 };
const V1 = { id: 'v1', price: null };
const V2 = { id: 'v2', price: null };

const group = (o: Record<string, unknown> = {}) => ({
  id: GROUP,
  storeId: STORE,
  pricingMode: 'percent_off',
  discountBps: 2_000,
  isActive: true,
  ...o,
});
/** Wire the mocks: a verified customer user whose Customer row sits in `grp`. */
function approvedWholesaler(grp: ReturnType<typeof group> | null = group()) {
  m.userFindFirst.mockResolvedValue({ email: 'Buyer@Example.com' });
  m.customerFindFirst.mockResolvedValue(grp ? { group: grp } : null);
}
const tierRow = (minQty: number, priceMinor: number, o: Record<string, unknown> = {}) => ({
  productId: 'p1',
  variantId: null,
  groupId: null,
  minQty,
  priceMinor,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.featureOn.mockResolvedValue(true);
  m.tierFindMany.mockResolvedValue([]);
  m.userFindFirst.mockResolvedValue(null);
  m.customerFindFirst.mockResolvedValue(null);
});

describe('RF2 / Ruling B2B-2: the buyer is the authenticated user id, never a typed identity', () => {
  it('a guest (null user id) never touches the user or customer tables and is charged retail', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    const out = await r.priceLine(P1, null, 5);
    expect(out).toMatchObject({ unitMinor: 10_000, source: 'base' });
    expect(m.userFindFirst).not.toHaveBeenCalled();
    expect(m.customerFindFirst).not.toHaveBeenCalled();
  });

  it('forBuyer takes exactly (storeId, userId): there is no overload that accepts a phone or an email', () => {
    expect(PriceResolver.forBuyer.length).toBe(2);
  });

  it('the user lookup is pinned to this store, role customer, active, not deleted, EMAIL VERIFIED', async () => {
    approvedWholesaler();
    await PriceResolver.forBuyer(STORE, USER);
    expect(m.userFindFirst).toHaveBeenCalledTimes(1);
    expect(m.userFindFirst.mock.calls[0]![0].where).toEqual({
      id: USER,
      storeId: STORE,
      role: 'customer',
      status: 'active',
      deletedAt: null,
      emailVerified: true,
    });
  });

  it('an unverified / foreign-store / non-customer / deleted user resolves to NO group (the pinned where finds no row)', async () => {
    m.userFindFirst.mockResolvedValue(null);
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(m.customerFindFirst).not.toHaveBeenCalled();
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it("the customer row is matched on the user's OWN account email (case-insensitive), in this store, never on a phone", async () => {
    approvedWholesaler();
    await PriceResolver.forBuyer(STORE, USER);
    const where = m.customerFindFirst.mock.calls[0]![0].where;
    expect(where).toEqual({
      storeId: STORE,
      email: { equals: 'Buyer@Example.com', mode: 'insensitive' },
      groupId: { not: null },
    });
    expect(JSON.stringify(where)).not.toMatch(/phone/i);
  });

  it('a user row without an email never reaches the customer lookup (an empty email must not match every customer)', async () => {
    m.userFindFirst.mockResolvedValue({ email: '' });
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(m.customerFindFirst).not.toHaveBeenCalled();
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ source: 'base' });
  });

  it('when two customer rows differ only by email case the OLDEST row decides (deterministic)', async () => {
    approvedWholesaler();
    await PriceResolver.forBuyer(STORE, USER);
    expect(m.customerFindFirst.mock.calls[0]![0].orderBy).toEqual({ createdAt: 'asc' });
  });

  it('an authenticated non-member (no customer row / no group) is charged retail', async () => {
    approvedWholesaler(null);
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('an approved wholesaler gets the group price', async () => {
    approvedWholesaler();
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine(P1, null, 1)).toMatchObject({
      unitMinor: 8_000,
      source: 'group',
      listMinor: 10_000,
    });
  });

  it('a group that belongs to ANOTHER store resolves to retail (cross-store id)', async () => {
    approvedWholesaler(group({ storeId: OTHER_STORE }));
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('a group with an unknown pricingMode fails closed to retail', async () => {
    approvedWholesaler(group({ pricingMode: 'free_for_all' }));
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('RF10: an inactive group is retail, but PUBLIC tiers still apply', async () => {
    approvedWholesaler(group({ isActive: false }));
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000), tierRow(2, 5_000, { groupId: GROUP })]);
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 9_000, source: 'tier' });
  });

  it('a group tier row for another group (a loader bug upstream) is ignored by the pure function', async () => {
    approvedWholesaler();
    m.tierFindMany.mockResolvedValue([tierRow(2, 1_000, { groupId: 'someone-elses-group' })]);
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 8_000, source: 'group' });
  });
});

describe('RF13 plan gate: feature off => retail, tiers / group / MOQ all ignored', () => {
  it('wholesale off: a wholesaler with tiers and a group pays retail and no MOQ is reported', async () => {
    m.featureOn.mockResolvedValue(false);
    approvedWholesaler();
    m.tierFindMany.mockResolvedValue([tierRow(2, 5_000)]);
    const r = await PriceResolver.forBuyer(STORE, USER);
    const out = await r.priceLine({ ...P1, moq: 6 }, null, 3);
    expect(out).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
      tierMinQty: null,
      belowMoq: false,
      moqRequired: null,
    });
    expect(m.featureOn).toHaveBeenCalledWith(STORE, 'b2b.wholesale');
  });

  it('wholesale on: the same fixture gets the tier and the MOQ flag', async () => {
    approvedWholesaler();
    m.tierFindMany.mockResolvedValue([tierRow(2, 5_000)]);
    const r = await PriceResolver.forBuyer(STORE, USER);
    expect(await r.priceLine({ ...P1, moq: 6 }, null, 3)).toMatchObject({
      unitMinor: 5_000,
      source: 'tier',
      belowMoq: true,
      moqRequired: 6,
    });
  });

  it('nothing to gate (guest, no tiers, no MOQ): the feature service is not even consulted', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    await r.priceLine(P1, null, 2);
    expect(m.featureOn).not.toHaveBeenCalled();
  });

  it('the feature is read at most once per resolver instance (per request)', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000)]);
    const r = await PriceResolver.forBuyer(STORE, null);
    await r.priceLine(P1, null, 2);
    await r.priceLine(P1, null, 3);
    expect(m.featureOn).toHaveBeenCalledTimes(1);
  });

  it('a failing feature read PROPAGATES: never silently priced as retail or as wholesale', async () => {
    m.featureOn.mockRejectedValue(new Error('feature read failed'));
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000)]);
    const r = await PriceResolver.forBuyer(STORE, null);
    await expect(r.priceLine(P1, null, 2)).rejects.toThrow('feature read failed');
  });
});

describe('RF4 / Ruling B2B-4: quantities are summed across cart lines', () => {
  it('product-level tier: 6 of V1 + 6 of V2 prices BOTH lines at the 10+ tier', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(10, 8_000)]);
    const r = await PriceResolver.forBuyer(STORE, null);
    const out = await r.priceCart([
      { key: 'a', product: P1, variant: V1, qty: 6 },
      { key: 'b', product: P1, variant: V2, qty: 6 },
    ]);
    expect(out.get('a')!.unitMinor).toBe(8_000);
    expect(out.get('b')!.unitMinor).toBe(8_000);
  });

  it('variant-level tier: the same cart does NOT reach a variant tier from 10, 10 of one variant does', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(10, 8_000, { variantId: 'v1' })]);
    const r = await PriceResolver.forBuyer(STORE, null);
    const split = await r.priceCart([
      { key: 'a', product: P1, variant: V1, qty: 6 },
      { key: 'b', product: P1, variant: V2, qty: 6 },
    ]);
    expect(split.get('a')!.unitMinor).toBe(10_000);
    const whole = await (
      await PriceResolver.forBuyer(STORE, null)
    ).priceCart([
      { key: 'a', product: P1, variant: V1, qty: 6 },
      { key: 'n', product: P1, variant: V1, qty: 4 }, // a personalisation-note line of the same variant
    ]);
    expect(whole.get('a')!.unitMinor).toBe(8_000);
    expect(whole.get('n')!.unitMinor).toBe(8_000);
  });

  it('MOQ is judged on the product total across variants', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    const p = { ...P1, moq: 6 };
    const out = await r.priceCart([
      { key: 'a', product: p, variant: V1, qty: 3 },
      { key: 'b', product: p, variant: V2, qty: 3 },
    ]);
    expect(out.get('a')!.belowMoq).toBe(false);
    expect(out.get('b')!.belowMoq).toBe(false);
  });

  it('variant price overrides the product price as the base (variant.price ?? product.price), 0 stays 0', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    const out = await r.priceCart([
      { key: 'a', product: P1, variant: { id: 'v1', price: 4_500 }, qty: 1 },
      { key: 'b', product: P1, variant: { id: 'v2', price: 0 }, qty: 1 },
      { key: 'c', product: P1, variant: null, qty: 1 },
    ]);
    expect(out.get('a')!.unitMinor).toBe(4_500);
    expect(out.get('b')!.unitMinor).toBe(0);
    expect(out.get('c')!.unitMinor).toBe(10_000);
  });

  it('ONE tier query serves the whole cart and is scoped to the store; a second call for the same products is memoised', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    const lines = [
      { key: 'a', product: P1, variant: V1, qty: 1 },
      { key: 'b', product: { id: 'p2', price: 500 }, variant: null, qty: 1 },
    ];
    await r.priceCart(lines);
    await r.priceCart(lines);
    expect(m.tierFindMany).toHaveBeenCalledTimes(1);
    const arg = m.tierFindMany.mock.calls[0]![0];
    expect(arg.where.storeId).toBe(STORE);
    expect(arg.where.productId.in.sort()).toEqual(['p1', 'p2']);
  });

  it('duplicate line keys are refused (a Map would silently drop a line)', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    await expect(
      r.priceCart([
        { key: 'a', product: P1, qty: 1 },
        { key: 'a', product: P1, qty: 2 },
      ])
    ).rejects.toThrow(/duplicate line key/);
  });

  it('an empty cart prices to an empty map without querying', async () => {
    const r = await PriceResolver.forBuyer(STORE, null);
    expect((await r.priceCart([])).size).toBe(0);
  });

  it('forBuyer refuses a missing storeId', async () => {
    await expect(PriceResolver.forBuyer('', null)).rejects.toThrow(/storeId/);
  });
});
