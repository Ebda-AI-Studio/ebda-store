/**
 * Promotion resolver — unit tests.
 *
 * Mirrors the promotion.service.test.ts mock style (vi.hoisted prisma mock).
 * Covers the DB-facing orchestration: resolveBestPromotion (highest-discount
 * eligible promo wins, ineligible ones filtered, ties broken by priority
 * ordering) and resolveCustomerContext (identity resolution + first-order).
 * The pure targeting math (matchesTargeting/computeDiscount) is exercised
 * for real — only Prisma is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockLoadBuyerGroup } = vi.hoisted(() => ({
  mockLoadBuyerGroup: vi.fn(),
  mockPrisma: {
    promotion: { findMany: vi.fn() },
    customer: { findFirst: vi.fn() },
    order: { count: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@ebda/database', () => ({
  prisma: mockPrisma,
}));
// Group membership is decided by the SHARED buyer-group loader (session / merchant selection only); its own queries are
// pinned in tests/unit/price-resolver-service.test.ts and tests/integration/b2b-promo-identity.test.ts.
vi.mock('../../apps/api/src/services/price-resolver.service', () => ({
  loadBuyerGroup: mockLoadBuyerGroup,
}));

import {
  resolveBestPromotion,
  resolveCustomerContext,
} from '../../apps/api/src/services/promotion-resolver';
import type { TargetingCtx } from '../../apps/api/src/services/promotion-targeting';
import { ANONYMOUS_BUYER, type BuyerIdentity } from '../../apps/api/src/lib/buyer-identity';

const sessionBuyer = (userId: string) => ({ kind: 'session', userId }) as unknown as BuyerIdentity;

const STORE = 'store-1';

// base=10000 piastres cart; percentage discounts compute against the whole cart
// (no scope set) so value maps 1:1 to a predictable piastres amount.
const CTX: TargetingCtx = {
  customerGroupId: 'g1',
  isFirstOrder: true,
  cartItems: [{ productId: 'p1', categoryIds: ['c1'], quantity: 2, lineTotal: 10000 }],
};

// Full Targeting + Promotion shape (all facets empty = "everyone, whole cart").
function promo(overrides: Record<string, unknown>) {
  return {
    id: 'promo',
    priority: 0,
    type: 'percentage',
    value: 10,
    maxDiscount: null,
    customerGroupId: null,
    firstOrderOnly: false,
    minOrderAmount: null,
    minQuantity: null,
    scopeProductIds: [],
    scopeCategoryIds: [],
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveBestPromotion', () => {
  it('returns null when no active promotions exist', async () => {
    mockPrisma.promotion.findMany.mockResolvedValue([]);
    expect(await resolveBestPromotion(STORE, CTX)).toBeNull();
  });

  it('picks the eligible promotion with the largest discount', async () => {
    // findMany returns priority-desc; A has higher priority but a smaller
    // discount, B a larger one — the larger discount must win.
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'A', priority: 10, value: 10 }), // 1000 piastres
      promo({ id: 'B', priority: 5, value: 20 }), // 2000 piastres
    ]);
    const best = await resolveBestPromotion(STORE, CTX);
    expect(best).toEqual({ promotionId: 'B', discount: 2000 });
  });

  it('breaks ties by priority order (first eligible with max discount stands)', async () => {
    // Equal discounts; A comes first (higher priority) so it holds — the
    // strict > comparison never lets a later equal-discount promo replace it.
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'A', priority: 10, value: 15 }), // 1500 piastres
      promo({ id: 'B', priority: 5, value: 15 }), // 1500 piastres
    ]);
    const best = await resolveBestPromotion(STORE, CTX);
    expect(best).toEqual({ promotionId: 'A', discount: 1500 });
  });

  it('filters out ineligible promotions (customer-group mismatch)', async () => {
    // Big discount but wrong group → skipped; small eligible one wins.
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'BIG', priority: 10, value: 50, customerGroupId: 'g2' }), // ineligible
      promo({ id: 'OK', priority: 1, value: 10 }), // 1000 piastres, eligible
    ]);
    const best = await resolveBestPromotion(STORE, CTX);
    expect(best).toEqual({ promotionId: 'OK', discount: 1000 });
  });

  it('skips promotions whose computed discount is zero', async () => {
    mockPrisma.promotion.findMany.mockResolvedValue([
      promo({ id: 'ZERO', priority: 10, value: 0 }),
    ]);
    expect(await resolveBestPromotion(STORE, CTX)).toBeNull();
  });
});

describe('resolveCustomerContext', () => {
  beforeEach(() => {
    mockLoadBuyerGroup.mockResolvedValue(null);
  });

  it('treats an anonymous checkout (no identity) as a first order with no group', async () => {
    const ctx = await resolveCustomerContext(STORE, { phone: null, email: null });
    expect(ctx).toEqual({ customerGroupId: null, isFirstOrder: true });
    expect(mockPrisma.order.count).not.toHaveBeenCalled();
  });

  it('GUEST: a typed phone / email never confers a group (the VIP-phone exploit), and the lookup is anonymous', async () => {
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.customer.findFirst.mockResolvedValue({ groupId: 'vip' }); // would have matched the VIP row before
    const ctx = await resolveCustomerContext(
      STORE,
      { phone: '+96550000000', email: 'vip@x.com' },
      ANONYMOUS_BUYER
    );
    expect(ctx).toEqual({ customerGroupId: null, isFirstOrder: true });
    expect(mockLoadBuyerGroup).toHaveBeenCalledWith(STORE, ANONYMOUS_BUYER);
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('SESSION / merchant pick: the group is whatever the shared buyer-group loader returns', async () => {
    mockLoadBuyerGroup.mockResolvedValue({ id: 'vip' });
    mockPrisma.order.count.mockResolvedValue(3);
    const buyer = sessionBuyer('user-1');
    const ctx = await resolveCustomerContext(STORE, { phone: 'ignored', email: 'ignored' }, buyer);
    expect(ctx).toEqual({ customerGroupId: 'vip', isFirstOrder: false });
    expect(mockLoadBuyerGroup).toHaveBeenCalledWith(STORE, buyer);
  });

  it('guest first-order status still comes from the typed identity (not-first when a prior order exists)', async () => {
    mockPrisma.order.count.mockResolvedValue(2);
    const ctx = await resolveCustomerContext(STORE, { phone: null, email: 'a@b.com' });
    expect(ctx).toEqual({ customerGroupId: null, isFirstOrder: false });
  });

  // Fix B regression: a registered customer must be keyed by the reliable customerId, not the mutable shipping phone/email.
  it('with customerId: first-order is decided by the customerId order count, not shipping fields', async () => {
    mockPrisma.order.count.mockResolvedValue(0);
    const ctx = await resolveCustomerContext(STORE, {
      phone: '+96550000000',
      email: 'shipping@test.com',
      customerId: 'cust-1',
    });
    expect(ctx.isFirstOrder).toBe(true);
    expect(mockPrisma.order.count).toHaveBeenCalledWith({
      where: {
        storeId: STORE,
        customerId: 'cust-1',
        deletedAt: null,
        status: { not: 'cancelled' },
      },
    });
    expect(mockPrisma.order.count).toHaveBeenCalledTimes(1);
  });

  it('a session buyer without an explicit customerId still keys first-order on the session user', async () => {
    mockPrisma.order.count.mockResolvedValue(1);
    const ctx = await resolveCustomerContext(STORE, {}, sessionBuyer('user-9'));
    expect(ctx.isFirstOrder).toBe(false);
    expect(mockPrisma.order.count).toHaveBeenCalledWith({
      where: {
        storeId: STORE,
        customerId: 'user-9',
        deletedAt: null,
        status: { not: 'cancelled' },
      },
    });
  });
});
