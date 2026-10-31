/**
 * Ruling CF-JOBS-4B: ReviewService reads and writes the store's own backend. For a store on its Durable Object every call lands
 * on the DO tables (in-memory stand-ins) and Postgres THROWS if reached; the buyer shown to the admin is the platform user,
 * attached after the read. The review a shopper creates is the row the moderation job later finds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const S = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => {
  const match = (r: Row, w: Row): boolean =>
    Object.entries(w ?? {}).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some(x => match(r, x));
      if (k === 'product') return true; // the visibility relation filter is the DO engine's job
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('gte' in v) return r[k] >= v.gte;
        if ('some' in v) return true;
      }
      return r[k] === v;
    });
  return {
    match,
    reviews: [] as Row[],
    seq: 0,
    boom: (what: string): object =>
      new Proxy(
        {},
        {
          get: (_t, p) => {
            throw new Error(`Postgres touched: ${what}.${String(p)}`);
          },
        }
      ),
  };
});
vi.mock('@ebda/database', () => ({
  prisma: h.boom('prisma'),
  Prisma: {},
  withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      user: {
        findMany: async () => [
          {
            id: 'u1',
            firstName: 'Mona',
            lastName: 'A',
            email: 'm@example.com',
            phone: null,
            language: 'ar',
          },
        ],
      },
    }),
}));
vi.mock('@api/lib/repo-factory', () => {
  const db = {
    review: {
      findMany: async (a: { where: Row; skip?: number; take?: number }) =>
        h.reviews
          .filter(r => h.match(r, a.where))
          .slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? 1000)),
      findFirst: async (a: { where: Row }) => h.reviews.find(r => h.match(r, a.where)) ?? null,
      count: async (a: { where: Row }) => h.reviews.filter(r => h.match(r, a.where)).length,
      aggregate: async (a: { where: Row }) => {
        const rows = h.reviews.filter(r => h.match(r, a.where));
        return {
          _avg: {
            rating: rows.length ? rows.reduce((n, r) => n + r.rating, 0) / rows.length : null,
          },
          _count: rows.length,
        };
      },
      groupBy: async (a: { where: Row }) => {
        const m = new Map<number, number>();
        for (const r of h.reviews.filter(x => h.match(x, a.where)))
          m.set(r.rating, (m.get(r.rating) ?? 0) + 1);
        return [...m].map(([rating, _count]) => ({ rating, _count }));
      },
    },
    product: { findFirst: async () => ({ id: 'p1', name: 'Lamp' }) },
    order: { findFirst: async () => ({ id: 'o1' }) },
  };
  const writer = {
    review: {
      create: async (a: { data: Row }) => {
        const row = { id: `r${++h.seq}`, createdAt: new Date(), ...a.data };
        h.reviews.push(row);
        return row;
      },
      update: async (a: { where: Row; data: Row }) => {
        const r = h.reviews.find(x => x.id === a.where.id)!;
        for (const [k, v] of Object.entries(a.data)) if (v !== undefined) r[k] = v;
        return r;
      },
      delete: async (a: { where: Row }) => {
        h.reviews.splice(
          h.reviews.findIndex(x => x.id === a.where.id),
          1
        );
      },
    },
  };
  return { storeRepo: async () => ({ backend: 'do', db, writer }), storeDb: async () => db };
});
vi.mock('@api/services/socket.service', () => ({
  socketService: { newReviewNotification: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ReviewService } from '@api/services/review.service';

beforeEach(() => {
  h.reviews.length = 0;
  h.seq = 0;
});

describe('ReviewService on a DO store', () => {
  const body = 'Great lamp, bright light and solid brass build.';

  it('create -> pending row on the DO; a second create for the same order+product is a 409', async () => {
    const r = await ReviewService.create(S, 'u1', {
      productId: 'p1',
      orderId: 'o1',
      rating: 5,
      body,
    } as never);
    expect(r).toMatchObject({ status: 'pending', storeId: S, verifiedPurchase: true });
    await expect(
      ReviewService.create(S, 'u1', { productId: 'p1', orderId: 'o1', rating: 5, body } as never)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(h.reviews).toHaveLength(1);
  });

  it('approve / reject / delete act on the DO row; an unknown id is a 404 from the DO', async () => {
    const r = await ReviewService.create(S, 'u1', {
      productId: 'p1',
      orderId: 'o1',
      rating: 4,
      body,
    } as never);
    await ReviewService.approve(S, r.id);
    expect(h.reviews[0].status).toBe('published');
    await ReviewService.reject(S, r.id, 'spammy');
    expect(h.reviews[0]).toMatchObject({ status: 'rejected', rejectionReason: 'spammy' });
    await expect(ReviewService.approve(S, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await ReviewService.delete(S, r.id);
    expect(h.reviews).toHaveLength(0);
  });

  it('public list shows only published reviews with stats; the viewer also sees their own pending one', async () => {
    h.reviews.push(
      {
        id: 'a',
        storeId: S,
        productId: 'p1',
        status: 'published',
        rating: 5,
        customerId: 'u2',
        createdAt: new Date(),
      },
      {
        id: 'b',
        storeId: S,
        productId: 'p1',
        status: 'pending',
        rating: 1,
        customerId: 'u1',
        createdAt: new Date(),
      }
    );
    const pub = await ReviewService.listByProduct(S, 'p1');
    expect(pub.reviews.map(x => x.id)).toEqual(['a']);
    expect(pub.stats).toMatchObject({ averageRating: 5, totalReviews: 1 });
    const mine = await ReviewService.listByProduct(S, 'p1', { viewerCustomerId: 'u1' });
    expect(mine.reviews.map(x => x.id).sort()).toEqual(['a', 'b']);
  });

  it('the admin list attaches the platform buyer to a DO review', async () => {
    h.reviews.push({
      id: 'a',
      storeId: S,
      productId: 'p1',
      status: 'pending',
      rating: 3,
      customerId: 'u1',
      createdAt: new Date(),
    });
    const out = await ReviewService.listForStore(S);
    expect(out.reviews[0]).toMatchObject({
      customer: { id: 'u1', email: 'm@example.com', firstName: 'Mona' },
    });
  });
});
