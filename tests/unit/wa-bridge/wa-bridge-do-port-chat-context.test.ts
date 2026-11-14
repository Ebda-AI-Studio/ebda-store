/**
 * The REAL do-port for the Chat agent context RPC (Ruling CHAT-AGENT-1..3), over a fake repo db:
 *  - searchProducts keeps the storefront rank order, drops inactive/foreign ids, applies the price ceiling per variant row;
 *  - storePolicies reports only declared facts (blank text, 0 fees and absent windows are null, not defaults);
 *  - customerProfile returns null for a key no CRM row or order carries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ranked = vi.fn(async (_s: string, _q: string, _o?: unknown) => [] as string[]);
const flags = { degraded: false };
const productFind = vi.fn(async (_a: any) => [] as any[]);
const variantFind = vi.fn(async (_a: any) => [] as any[]);
const state = {
  store: {} as any,
  zones: [] as any[],
  rates: [] as any[],
  cod: null as any,
  orders: [] as any[],
  proc: { known: false, firstName: null, preferredLocale: null, defaultAddress: null } as any,
};
const fakeDb = {
  product: { findMany: (a: any) => productFind(a) },
  productVariant: { findMany: (a: any) => variantFind(a) },
  store: {
    findUnique: async (a: any) =>
      a.select?.currency || a.select?.slug
        ? { id: 's1', slug: 'dar', domain: null, name: 'Dar', nameAr: null, currency: 'EGP' }
        : state.store,
  },
  shippingZone: { findMany: async () => state.zones },
  shippingAreaRate: { findMany: async () => state.rates },
  paymentConfig: { findFirst: async () => state.cod },
  order: { findMany: async () => state.orders },
};
vi.mock('../../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async () => ({ db: fakeDb }),
  storeMoney: vi.fn(),
  storeWriter: async () => ({ $proc: async () => state.proc }),
}));
vi.mock('../../../apps/api/src/lib/store-scoped-read', () => ({
  readInStoreContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('../../../apps/api/src/services/product-search.service', () => ({
  rankedSearchWithMode: async (s: string, q: string, o: unknown) => ({
    ids: await ranked(s, q, o),
    degraded: flags.degraded,
  }),
}));
const budget = { spent: false };
vi.mock('../../../apps/api/src/lib/search/embed-budget', () => ({
  queryBudgetSpent: () => budget.spent,
}));
vi.mock('../../../apps/api/src/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('../../../apps/api/src/lib/buyer-identity', () => ({ ANONYMOUS_BUYER: 'anon' }));
vi.mock('../../../apps/api/src/config', () => ({ config: { webUrl: 'https://web.example' } }));
vi.mock('../../../apps/api/src/lib/definer', () => ({ lookupStore: vi.fn() }));
vi.mock('../../../apps/api/src/lib/wa/link', () => ({ isWhatsAppLinked: vi.fn() }));
vi.mock('../../../apps/api/src/lib/wa/store-events-consumer', () => ({ applyCodOutcome: vi.fn() }));
vi.mock('../../../apps/api/src/services/payment-providers/payment.factory', () => ({
  PaymentService: {},
}));
vi.mock('../../../apps/api/src/services/payment-providers/instapay.service', () => ({
  InstapayService: {},
}));
vi.mock('../../../apps/api/src/services/payment-providers/webhook-url', () => ({
  paymentWebhookUrl: vi.fn(),
}));
vi.mock('../../../apps/api/src/lib/payment-line-items', () => ({ buildPaymentLineItems: vi.fn() }));
vi.mock('../../../apps/api/src/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('../../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { createDoPort, governoratesOf } from '../../../apps/api/src/lib/wa/bridge/do-port';

const prod = (id: string, price: number) => ({
  id,
  name: `P ${id}`,
  nameAr: null,
  description: null,
  price,
  slug: id,
  inventory: 5,
  trackInventory: true,
  images: [],
});
beforeEach(() => {
  ranked.mockReset();
  flags.degraded = false;
  productFind.mockReset();
  variantFind.mockReset();
  variantFind.mockResolvedValue([]);
  state.store = {};
  state.zones = [];
  state.rates = [];
  state.cod = null;
  state.orders = [];
  state.proc = { known: false, firstName: null, preferredLocale: null, defaultAddress: null };
});

describe('searchProducts', () => {
  it('keeps the storefront rank order, not the database order', async () => {
    ranked.mockResolvedValue(['p3', 'p1', 'p2']);
    productFind.mockResolvedValue([prod('p1', 100), prod('p2', 200), prod('p3', 300)]);
    const { items: rows } = await createDoPort().searchProducts('s1', 'فستان', {
      limit: 10,
      searcher: 'wa-chat:s1',
    });
    expect(rows.map(r => r.retailerId)).toEqual(['p3', 'p1', 'p2']);
    expect(ranked).toHaveBeenCalledWith('s1', 'فستان', { searcher: 'wa-chat:s1' });
  });
  it('reads only active, public, non-deleted products of THIS store', async () => {
    ranked.mockResolvedValue(['p1']);
    productFind.mockResolvedValue([prod('p1', 100)]);
    await createDoPort().searchProducts('s1', 'x', { limit: 5, searcher: 'wa-chat:s1' });
    expect(productFind.mock.calls[0]![0].where).toMatchObject({
      storeId: 's1',
      status: 'active',
      deletedAt: null,
      audience: 'public',
    });
  });
  it('an id the ranker returned but the product read dropped (draft/deleted) is skipped', async () => {
    ranked.mockResolvedValue(['gone', 'p1']);
    productFind.mockResolvedValue([prod('p1', 100)]);
    const { items: rows } = await createDoPort().searchProducts('s1', 'x', {
      limit: 5,
      searcher: 'wa-chat:s1',
    });
    expect(rows.map(r => r.retailerId)).toEqual(['p1']);
  });
  it('an empty answer once the store search budget is spent is DEGRADED, never a confident "we don\'t have it" (Ruling CHAT-AGENT-6)', async () => {
    ranked.mockResolvedValue([]);
    budget.spent = true;
    try {
      expect(
        await createDoPort().searchProducts('s1', 'gift', { limit: 5, searcher: 'wa-chat:s1' })
      ).toEqual({ items: [], degraded: true });
    } finally {
      budget.spent = false;
    }
    expect(
      await createDoPort().searchProducts('s1', 'gift', { limit: 5, searcher: 'wa-chat:s1' })
    ).toEqual({ items: [], degraded: false });
  });

  it('applies the price ceiling on the sellable row (a variant can be under budget while its product is not)', async () => {
    ranked.mockResolvedValue(['p1']);
    productFind.mockResolvedValue([prod('p1', 90000)]);
    variantFind.mockResolvedValue([
      { id: 'v-cheap', productId: 'p1', title: 'S', price: 40000, isActive: true, inventory: 3 },
      { id: 'v-dear', productId: 'p1', title: 'L', price: 90000, isActive: true, inventory: 3 },
    ]);
    const { items: rows } = await createDoPort().searchProducts('s1', 'x', {
      limit: 5,
      maxPriceMinor: 50000,
      searcher: 'wa-chat:s1',
    });
    expect(rows.map(r => r.retailerId)).toEqual(['v-cheap']);
  });
  it('honours the limit and returns [] without touching products when nothing ranks', async () => {
    ranked.mockResolvedValue([]);
    expect(
      await createDoPort().searchProducts('s1', 'x', { limit: 5, searcher: 'wa-chat:s1' })
    ).toEqual({ items: [], degraded: false });
    expect(productFind).not.toHaveBeenCalled();
    flags.degraded = true;
    expect(
      await createDoPort().searchProducts('s1', 'x', { limit: 5, searcher: 'wa-chat:s1' })
    ).toEqual({ items: [], degraded: true });
    flags.degraded = false;
    ranked.mockResolvedValue(['p1', 'p2', 'p3']);
    productFind.mockResolvedValue([prod('p1', 1), prod('p2', 2), prod('p3', 3)]);
    expect(
      (await createDoPort().searchProducts('s1', 'x', { limit: 2, searcher: 'wa-chat:s1' })).items
    ).toHaveLength(2);
  });
});

describe('storePolicies', () => {
  it('reports declared facts', async () => {
    state.store = {
      nameAr: 'دار',
      businessHours: ' Sat-Thu 10-10 ',
      address: '9 Road',
      addressAr: null,
      googleMapsUrl: 'https://maps.example/x',
      returnWindowDays: 14,
      returnFeesPaidBy: 'customer',
    };
    state.zones = [
      {
        name: 'Cairo',
        nameAr: 'القاهرة',
        areas: ['Maadi'],
        deliveryFee: 6000,
        freeShippingThreshold: 100000,
        estimatedDays: null,
        estimatedDaysMin: 1,
        estimatedDaysMax: 2,
      },
    ];
    state.cod = { fixedFee: 2500, settings: { percentBps: 150 } };
    const p = await createDoPort().storePolicies('s1');
    expect(p).toMatchObject({
      nameAr: 'دار',
      hours: 'Sat-Thu 10-10',
      returns: { windowDays: 14, feesPaidBy: 'customer' },
      cod: { fixedFeeMinor: 2500, percentBps: 150 },
      shipping: {
        zones: [{ feeMinor: 6000, freeOverMinor: 100000, etaDaysMin: 1, etaDaysMax: 2 }],
      },
      location: { address: '9 Road', mapsUrl: 'https://maps.example/x' },
    });
  });
  it('declares nothing: every fact is null/empty, never a default', async () => {
    state.store = {
      nameAr: '  ',
      businessHours: '',
      address: null,
      addressAr: null,
      googleMapsUrl: null,
      returnWindowDays: null,
      returnFeesPaidBy: 'bogus',
    };
    state.cod = { fixedFee: 0, settings: {} };
    expect(await createDoPort().storePolicies('s1')).toEqual({
      nameAr: null,
      shipping: { zones: [], governorates: [] },
      returns: { windowDays: null, feesPaidBy: null },
      cod: { fixedFeeMinor: null, percentBps: null },
      hours: null,
      location: null,
    });
  });
  it('a zero-day return window is "no returns", kept as 0', async () => {
    state.store = { returnWindowDays: 0 };
    expect((await createDoPort().storePolicies('s1')).returns.windowDays).toBe(0);
  });
});

describe('governoratesOf', () => {
  it('folds area rates to cheapest / dearest and the lowest free-shipping threshold', () => {
    const g = governoratesOf([
      {
        governorate: 'Giza',
        governorateAr: 'الجيزة',
        deliveryFee: 8000,
        freeShippingThreshold: null,
      },
      {
        governorate: 'Giza',
        governorateAr: 'الجيزة',
        deliveryFee: 6000,
        freeShippingThreshold: 90000,
      },
      {
        governorate: 'Giza',
        governorateAr: 'الجيزة',
        deliveryFee: 7000,
        freeShippingThreshold: 70000,
      },
      {
        governorate: 'Cairo',
        governorateAr: 'القاهرة',
        deliveryFee: 5000,
        freeShippingThreshold: null,
      },
    ]);
    expect(g).toEqual([
      {
        governorate: 'Giza',
        governorateAr: 'الجيزة',
        feeMinor: 6000,
        feeMaxMinor: 8000,
        freeOverMinor: 70000,
      },
      {
        governorate: 'Cairo',
        governorateAr: 'القاهرة',
        feeMinor: 5000,
        feeMaxMinor: 5000,
        freeOverMinor: null,
      },
    ]);
  });
});

describe('customerProfile', () => {
  it('null when no CRM row and no order carries the key', async () => {
    expect(await createDoPort().customerProfile('s1', 'a'.repeat(64))).toBeNull();
  });
  it('an order-only buyer (no CRM row) still gets a profile with no name and no address', async () => {
    state.orders = [
      {
        orderNumber: 'EB-1',
        status: 'delivered',
        paymentStatus: 'paid',
        total: 25000,
        walletAmount: 0,
        currency: 'EGP',
        createdAt: new Date(1_762_000_000_000),
        items: [{ productName: 'Dress', variantName: 'Red', quantity: 2 }],
        payments: [{ provider: 'cod' }],
      },
    ];
    const p = await createDoPort().customerProfile('s1', 'a'.repeat(64));
    expect(p).toMatchObject({
      firstName: null,
      defaultAddress: null,
      recentOrders: [
        {
          orderNumber: 'EB-1',
          status: 'delivered',
          totalMinor: 25000,
          items: [{ name: 'Dress - Red', quantity: 2 }],
        },
      ],
    });
  });
});
