/**
 * The real DO port's `recommend` / `orderSeedIds`: what reaches a shopper is re-read from THIS store (storeId, active, public,
 * in stock) whatever the recommendation engine (cached, bounded-stale) returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type P = {
  id: string;
  storeId: string;
  status: string;
  deletedAt: Date | null;
  audience: string;
  name: string;
  price: number;
  inventory: number;
  trackInventory: boolean;
  slug: string;
};
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const prod = (id: string, over: Partial<P> = {}): P => ({
  id,
  storeId: A,
  status: 'active',
  deletedAt: null,
  audience: 'public',
  name: `P ${id}`,
  price: 10000,
  inventory: 5,
  trackInventory: true,
  slug: id,
  ...over,
});
let products: P[] = [];
let variants: Array<{
  id: string;
  productId: string;
  price: number | null;
  inventory: number;
  isActive: boolean;
  allowBackorder: boolean;
  title: string;
  position: number;
  imageUrl: null;
}> = [];
let engine: Record<
  string,
  {
    crossSell: Array<{ id: string }>;
    upsell: Array<{ id: string }>;
    alsoLike: Array<{ id: string }>;
  }
> = {};
const orders = [
  {
    storeId: A,
    orderNumber: 'EB-1',
    buyerKey: 'k'.repeat(64),
    deletedAt: null,
    items: [{ productId: 'p1', variantId: null }],
  },
];

const match = (p: any, w: any): boolean =>
  Object.entries(w).every(([k, v]) =>
    v && typeof v === 'object' && 'in' in (v as any)
      ? (v as any).in.includes(p[k])
      : v === undefined
        ? true
        : p[k] === v
  );
const fakeDb = {
  store: {
    findUnique: async () => ({
      id: A,
      slug: 'dar',
      domain: null,
      name: 'Dar',
      nameAr: null,
      currency: 'EGP',
    }),
  },
  product: { findMany: async ({ where }: any) => products.filter(p => match(p, where)) },
  productVariant: {
    findMany: async ({ where }: any) =>
      variants.filter(
        v =>
          (where.id ? where.id.in.includes(v.id) : where.productId.in.includes(v.productId)) &&
          (!where.product ||
            products.find(p => p.id === v.productId)?.storeId === where.product.storeId)
      ),
  },
  order: { findFirst: async ({ where }: any) => orders.find(o => match(o, where)) ?? null },
};
vi.mock('../../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async () => ({ db: fakeDb }),
  storeMoney: vi.fn(),
  storeWriter: vi.fn(),
}));
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
vi.mock('../../../apps/api/src/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('../../../apps/api/src/lib/inngest/client', () => ({ inngest: {} }));
vi.mock('../../../apps/api/src/lib/buyer-identity', () => ({ ANONYMOUS_BUYER: 'x' }));
vi.mock('../../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../apps/api/src/config', () => ({ config: { webUrl: 'https://ebda.app' } }));
vi.mock('../../../apps/api/src/services/recommendation.service.js', () => ({
  recommendationService: {
    getProductRecommendations: async (_s: string, id: string) =>
      engine[id] ?? { crossSell: [], upsell: [], alsoLike: [] },
  },
}));

import { createDoPort } from '../../../apps/api/src/lib/wa/bridge/do-port';

beforeEach(() => {
  products = [
    prod('p1'),
    prod('p2'),
    prod('p3', { inventory: 0 }),
    prod('p4', { status: 'draft' }),
    prod('p5', { audience: 'b2b' }),
    prod('p6', { storeId: B }),
    prod('p7', { price: 90000 }),
    prod('p8', { deletedAt: new Date() }),
  ];
  variants = [];
  engine = {
    p1: {
      crossSell: [{ id: 'p2' }, { id: 'p3' }, { id: 'p4' }, { id: 'p5' }, { id: 'p6' }],
      upsell: [{ id: 'p7' }, { id: 'p8' }],
      alsoLike: [{ id: 'p1' }],
    },
  };
});

describe('DO port recommend', () => {
  it('drops out-of-stock, inactive (draft/deleted), non-public and other-store products, and the seed itself', async () => {
    const rows = await createDoPort().recommend(A, {
      seedIds: ['p1'],
      mode: 'complement',
      limit: 8,
    });
    expect(rows.map(r => r.productId)).toEqual(['p2', 'p7']);
    expect(rows.every(r => r.availability === 'in_stock')).toBe(true);
  });
  it('prices come from the store row, not the engine list', async () => {
    const rows = await createDoPort().recommend(A, {
      seedIds: ['p1'],
      mode: 'complement',
      limit: 8,
    });
    expect(rows.find(r => r.productId === 'p2')?.priceMinor).toBe(10000);
  });
  it('maxPriceMinor and limit are honoured', async () => {
    expect(
      (
        await createDoPort().recommend(A, {
          seedIds: ['p1'],
          mode: 'complement',
          limit: 8,
          maxPriceMinor: 50000,
        })
      ).map(r => r.productId)
    ).toEqual(['p2']);
    expect(
      await createDoPort().recommend(A, { seedIds: ['p1'], mode: 'complement', limit: 1 })
    ).toHaveLength(1);
  });
  it('a seed from ANOTHER store resolves to nothing (cross-store leak)', async () => {
    engine.p6 = { crossSell: [{ id: 'p2' }], upsell: [], alsoLike: [] };
    expect(
      await createDoPort().recommend(A, { seedIds: ['p6'], mode: 'complement', limit: 8 })
    ).toEqual([]);
  });
  it('a variant seed maps to its product; only the in-stock variant of a recommended product is offered', async () => {
    variants = [
      {
        id: 'v-p1',
        productId: 'p1',
        price: null,
        inventory: 1,
        isActive: true,
        allowBackorder: false,
        title: 'S',
        position: 0,
        imageUrl: null,
      },
      {
        id: 'v-p2a',
        productId: 'p2',
        price: 12000,
        inventory: 0,
        isActive: true,
        allowBackorder: false,
        title: 'S',
        position: 0,
        imageUrl: null,
      },
      {
        id: 'v-p2b',
        productId: 'p2',
        price: 13000,
        inventory: 3,
        isActive: true,
        allowBackorder: false,
        title: 'M',
        position: 1,
        imageUrl: null,
      },
    ];
    const rows = await createDoPort().recommend(A, {
      seedIds: ['v-p1'],
      mode: 'complement',
      limit: 8,
    });
    expect(rows.find(r => r.productId === 'p2')).toMatchObject({
      retailerId: 'v-p2b',
      priceMinor: 13000,
    });
  });
  it('orderSeedIds answers only for the buyer who owns the order', async () => {
    expect(await createDoPort().orderSeedIds(A, 'EB-1', 'k'.repeat(64))).toEqual(['p1']);
    expect(await createDoPort().orderSeedIds(A, 'EB-1', 'z'.repeat(64))).toBeNull();
    expect(await createDoPort().orderSeedIds(B, 'EB-1', 'k'.repeat(64))).toBeNull();
  });
});
