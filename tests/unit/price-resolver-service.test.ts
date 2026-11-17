/**
 * PriceResolver loader (docs/plans/done/2026-10-21-b2b-wholesale.md, Task 2). The pure arithmetic is pinned in
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

vi.mock('@api/middleware/auth', () => ({
  customerUserId: (req: { user?: { role?: string; userId?: string } }) =>
    req.user?.role === 'customer' ? req.user.userId : undefined,
}));

import { PriceResolver } from '@api/services/price-resolver.service';
import {
  ANONYMOUS_BUYER,
  buyerFromRequest,
  buyerFromMerchantSelection,
  buyerFromMerchantShopperSelection,
  buyerFromCartOwner,
} from '@api/lib/buyer-identity';

const sessionBuyer = (userId = 'user-1', role = 'customer') =>
  buyerFromRequest({ user: { role, userId } } as never);
const merchantBuyer = (customerId: string) =>
  buyerFromMerchantSelection(
    { user: { role: 'store_admin', userId: 'staff-1' } } as never,
    customerId
  );

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
  m.userFindFirst.mockResolvedValue({ id: USER });
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
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    const out = await r.priceLine(P1, null, 5);
    expect(out).toMatchObject({ unitMinor: 10_000, source: 'base' });
    expect(m.userFindFirst).not.toHaveBeenCalled();
    expect(m.customerFindFirst).not.toHaveBeenCalled();
  });

  it('forBuyer takes a BuyerIdentity: a bare id string, a phone or an email is not an identity (type-level; runtime kind check)', async () => {
    // @ts-expect-error a string is not a BuyerIdentity
    await expect(PriceResolver.forBuyer(STORE, USER)).resolves.toBeDefined();
    expect(m.userFindFirst).not.toHaveBeenCalled(); // an unbranded string has no kind, so it resolves as anonymous
    expect(m.customerFindFirst).not.toHaveBeenCalled();
  });

  it('the session user lookup is pinned to this store, role customer, active, not deleted', async () => {
    approvedWholesaler();
    await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(m.userFindFirst).toHaveBeenCalledTimes(1);
    expect(m.userFindFirst.mock.calls[0]![0].where).toEqual({
      id: USER,
      storeId: STORE,
      role: 'customer',
      status: 'active',
      deletedAt: null,
    });
  });

  it('C1: the group comes from customers.user_id = the session user, in this store: NO email, NO phone', async () => {
    approvedWholesaler();
    await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    const where = m.customerFindFirst.mock.calls[0]![0].where;
    expect(where).toEqual({ storeId: STORE, userId: USER, groupId: { not: null } });
    expect(JSON.stringify(m.customerFindFirst.mock.calls[0]![0])).not.toMatch(/phone|email/i);
    expect(JSON.stringify(m.userFindFirst.mock.calls[0]![0])).not.toMatch(/phone|email/i);
  });

  it('an unlinked user (no customers.user_id row) is charged retail, even if a CRM row with the same email exists', async () => {
    m.userFindFirst.mockResolvedValue({ id: USER });
    m.customerFindFirst.mockResolvedValue(null); // the user_id join finds nothing; there is no email fallback to find the CRM row
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 10_000, source: 'base' });
    expect(m.customerFindFirst).toHaveBeenCalledTimes(1);
  });

  it('an unknown / foreign-store / non-customer / deleted user resolves to NO group (the pinned where finds no row)', async () => {
    m.userFindFirst.mockResolvedValue(null);
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(m.customerFindFirst).not.toHaveBeenCalled();
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it("a merchant-selected Customer id prices as that row's group, in this store, with no user lookup (Ruling B2B-2d)", async () => {
    m.customerFindFirst.mockResolvedValue({ group: group() });
    const r = await PriceResolver.forBuyer(STORE, merchantBuyer('cust-9'));
    expect(m.userFindFirst).not.toHaveBeenCalled();
    expect(m.customerFindFirst.mock.calls[0]![0].where).toEqual({
      id: 'cust-9',
      storeId: STORE,
      groupId: { not: null },
    });
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 8_000, source: 'group' });
  });

  it('an authenticated non-member (no customer row / no group) is charged retail', async () => {
    approvedWholesaler(null);
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('an approved wholesaler gets the group price', async () => {
    approvedWholesaler();
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 1)).toMatchObject({
      unitMinor: 8_000,
      source: 'group',
      listMinor: 10_000,
    });
  });

  it('a group that belongs to ANOTHER store resolves to retail (cross-store id)', async () => {
    approvedWholesaler(group({ storeId: OTHER_STORE }));
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('a group with an unknown pricingMode fails closed to retail', async () => {
    approvedWholesaler(group({ pricingMode: 'free_for_all' }));
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('RF10: an inactive group is retail, but PUBLIC tiers still apply', async () => {
    approvedWholesaler(group({ isActive: false }));
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000), tierRow(2, 5_000, { groupId: GROUP })]);
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 9_000, source: 'tier' });
  });

  it('a group tier row for another group (a loader bug upstream) is ignored by the pure function', async () => {
    approvedWholesaler();
    m.tierFindMany.mockResolvedValue([tierRow(2, 1_000, { groupId: 'someone-elses-group' })]);
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 8_000, source: 'group' });
  });
});

describe('merchant shopper selection and cart owner identities', () => {
  const merchantReq = (role: string) => ({ user: { role, userId: 'staff-1' } }) as never;

  it('a merchant picking a REGISTERED shopper prices through customers.user_id of that shopper, in this store', async () => {
    m.userFindFirst.mockResolvedValue({ id: 'shopper-7' });
    m.customerFindFirst.mockResolvedValue({ group: group() });
    const r = await PriceResolver.forBuyer(
      STORE,
      buyerFromMerchantShopperSelection(merchantReq('staff'), 'shopper-7')
    );
    // the same account tests as a session (design review M-5): this store, customer role, active, not deleted
    expect(m.userFindFirst.mock.calls[0]![0].where).toEqual({
      id: 'shopper-7',
      storeId: STORE,
      role: 'customer',
      status: 'active',
      deletedAt: null,
    });
    expect(m.customerFindFirst.mock.calls[0]![0].where).toEqual({
      storeId: STORE,
      groupId: { not: null },
      userId: 'shopper-7',
    });
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 8_000, source: 'group' });
  });

  it('M-5: a merchant-picked shopper who is suspended / deleted / foreign (no user row) is NOT priced as a group member', async () => {
    m.userFindFirst.mockResolvedValue(null);
    m.customerFindFirst.mockResolvedValue({ group: group() });
    const r = await PriceResolver.forBuyer(
      STORE,
      buyerFromMerchantShopperSelection(merchantReq('staff'), 'dead-1')
    );
    expect(m.customerFindFirst).not.toHaveBeenCalled();
    expect(await r.priceLine(P1, null, 1)).toMatchObject({ unitMinor: 10_000, source: 'base' });
  });

  it('only a merchant session can mint a merchant selection (a customer token throws)', () => {
    expect(() => buyerFromMerchantShopperSelection(merchantReq('customer'), 'x')).toThrow(
      /merchant session/
    );
    expect(() => buyerFromMerchantSelection(merchantReq('customer'), 'x')).toThrow(
      /merchant session/
    );
    expect(() => buyerFromMerchantShopperSelection({} as never, 'x')).toThrow(/merchant session/);
  });

  it('a stored cart owner id is a session identity; a missing one is anonymous', () => {
    expect(buyerFromCartOwner(null)).toBe(ANONYMOUS_BUYER);
    expect(buyerFromCartOwner(undefined)).toBe(ANONYMOUS_BUYER);
    expect(buyerFromCartOwner('u-1')).toMatchObject({ kind: 'session', userId: 'u-1' });
  });
});

describe('RF13 plan gate: feature off => retail, tiers / group / MOQ all ignored', () => {
  it('B2B-1b: wholesale off drops tiers and the group, but MOQ is STILL reported (restrictions survive a downgrade)', async () => {
    m.featureOn.mockResolvedValue(false);
    approvedWholesaler();
    m.tierFindMany.mockResolvedValue([tierRow(2, 5_000)]);
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    const out = await r.priceLine({ ...P1, moq: 6 }, null, 3);
    expect(out).toMatchObject({
      unitMinor: 10_000,
      source: 'base',
      tierMinQty: null,
      belowMoq: true,
      moqRequired: 6,
    });
    expect(m.featureOn).toHaveBeenCalledWith(STORE, 'b2b.wholesale');
  });

  it('wholesale on: the same fixture gets the tier and the MOQ flag', async () => {
    approvedWholesaler();
    m.tierFindMany.mockResolvedValue([tierRow(2, 5_000)]);
    const r = await PriceResolver.forBuyer(STORE, sessionBuyer(USER));
    expect(await r.priceLine({ ...P1, moq: 6 }, null, 3)).toMatchObject({
      unitMinor: 5_000,
      source: 'tier',
      belowMoq: true,
      moqRequired: 6,
    });
  });

  it('nothing to gate (guest, no tiers): the feature service is not even consulted', async () => {
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    await r.priceLine(P1, null, 2);
    expect(m.featureOn).not.toHaveBeenCalled();
  });

  it('the feature is read at most once per resolver instance (per request)', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000)]);
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    await r.priceLine(P1, null, 2);
    await r.priceLine(P1, null, 3);
    expect(m.featureOn).toHaveBeenCalledTimes(1);
  });

  it('an injected UNCACHED entitlement reader is used instead of the cached feature service (order / payment-link creation)', async () => {
    m.featureOn.mockResolvedValue(true); // the cache says ON ...
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000)]);
    const uncached = vi.fn().mockResolvedValue(false); // ... the database says OFF (a just-made downgrade)
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER, {
      uncachedEntitlement: uncached,
    });
    expect(await r.priceLine(P1, null, 5)).toMatchObject({ unitMinor: 10_000, source: 'base' });
    expect(uncached).toHaveBeenCalledWith(STORE);
    expect(m.featureOn).not.toHaveBeenCalled();
  });

  it('a failing feature read PROPAGATES: never silently priced as retail or as wholesale', async () => {
    m.featureOn.mockRejectedValue(new Error('feature read failed'));
    m.tierFindMany.mockResolvedValue([tierRow(2, 9_000)]);
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    await expect(r.priceLine(P1, null, 2)).rejects.toThrow('feature read failed');
  });
});

describe('RF4 / Ruling B2B-4: quantities are summed across cart lines', () => {
  it('product-level tier: 6 of V1 + 6 of V2 prices BOTH lines at the 10+ tier', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(10, 8_000)]);
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    const out = await r.priceCart([
      { key: 'a', product: P1, variant: V1, qty: 6 },
      { key: 'b', product: P1, variant: V2, qty: 6 },
    ]);
    expect(out.get('a')!.unitMinor).toBe(8_000);
    expect(out.get('b')!.unitMinor).toBe(8_000);
  });

  it('variant-level tier: the same cart does NOT reach a variant tier from 10, 10 of one variant does', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(10, 8_000, { variantId: 'v1' })]);
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    const split = await r.priceCart([
      { key: 'a', product: P1, variant: V1, qty: 6 },
      { key: 'b', product: P1, variant: V2, qty: 6 },
    ]);
    expect(split.get('a')!.unitMinor).toBe(10_000);
    const whole = await (
      await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER)
    ).priceCart([
      { key: 'a', product: P1, variant: V1, qty: 6 },
      { key: 'n', product: P1, variant: V1, qty: 4 }, // a personalisation-note line of the same variant
    ]);
    expect(whole.get('a')!.unitMinor).toBe(8_000);
    expect(whole.get('n')!.unitMinor).toBe(8_000);
  });

  it('MOQ is judged on the product total across variants', async () => {
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    const p = { ...P1, moq: 6 };
    const out = await r.priceCart([
      { key: 'a', product: p, variant: V1, qty: 3 },
      { key: 'b', product: p, variant: V2, qty: 3 },
    ]);
    expect(out.get('a')!.belowMoq).toBe(false);
    expect(out.get('b')!.belowMoq).toBe(false);
  });

  it('variant price overrides the product price as the base (variant.price ?? product.price), 0 stays 0', async () => {
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    const out = await r.priceCart([
      { key: 'a', product: P1, variant: { id: 'v1', price: 4_500 }, qty: 1 },
      { key: 'b', product: P1, variant: { id: 'v2', price: 0 }, qty: 1 },
      { key: 'c', product: P1, variant: null, qty: 1 },
    ]);
    expect(out.get('a')!.unitMinor).toBe(4_500);
    expect(out.get('b')!.unitMinor).toBe(0);
    expect(out.get('c')!.unitMinor).toBe(10_000);
  });

  it('C2(c): a product-level tier does not touch a variant with its own price; a plain variant still gets it', async () => {
    m.tierFindMany.mockResolvedValue([tierRow(10, 8_000)]);
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    const out = await r.priceCart([
      { key: 'xl', product: P1, variant: { id: 'xl', price: 12_000 }, qty: 5 },
      { key: 'plain', product: P1, variant: { id: 'plain', price: null }, qty: 5 },
    ]);
    expect(out.get('xl')!.unitMinor).toBe(12_000);
    expect(out.get('plain')!.unitMinor).toBe(8_000);
  });

  it('ONE tier query serves the whole cart and is scoped to the store; a second call for the same products is memoised', async () => {
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
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
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    await expect(
      r.priceCart([
        { key: 'a', product: P1, qty: 1 },
        { key: 'a', product: P1, qty: 2 },
      ])
    ).rejects.toThrow(/duplicate line key/);
  });

  it('an empty cart prices to an empty map without querying', async () => {
    const r = await PriceResolver.forBuyer(STORE, ANONYMOUS_BUYER);
    expect((await r.priceCart([])).size).toBe(0);
  });

  it('forBuyer refuses a missing storeId', async () => {
    await expect(PriceResolver.forBuyer('', ANONYMOUS_BUYER)).rejects.toThrow(/storeId/);
  });
});
