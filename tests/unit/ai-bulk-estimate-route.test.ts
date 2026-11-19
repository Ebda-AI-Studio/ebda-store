/**
 * GET /stores/:storeId/ai/bulk-estimate - the number shown next to Run.
 * Mounts the REAL ai router with the REAL requireStoreAccess (only its data reads are faked), so "no tenant can
 * estimate on another's store" is proven through the actual guard, and each store sees only its own rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';

type P = { storeId: string; status: string; deletedAt: Date | null; categories: number };
const db = vi.hoisted(() => ({
  products: [] as P[],
  categories: [] as { storeId: string; deletedAt: Date | null }[],
  countWheres: [] as unknown[],
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (
    req: { headers: Record<string, string>; user?: unknown },
    _s: unknown,
    next: () => void
  ) => {
    req.user = { userId: req.headers['x-user'], role: 'store_admin' };
    next();
  },
  authorize: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  writeLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  auditLog: async () => undefined,
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock('@api/services/platform/access-d1', () => ({
  onAccessD1: async () => false,
  gateRead: async () => null,
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/database')>()),
  withStore: async (id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          id,
          ownerId: id === STORE_A ? OWNER_A : OWNER_B,
          name: id,
          status: 'active',
          billingSuspendedReason: null,
        }),
      },
    }),
}));

type Where = { storeId: string; status?: string; deletedAt?: null; categories?: { none: object } };
vi.mock('@api/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/repo-factory')>()),
  storeDb: async () => ({
    store: { findUnique: async () => ({ aiFeaturesEnabled: true }) },
    product: {
      count: async ({ where }: { where: Where }) => {
        db.countWheres.push(where);
        return db.products.filter(
          p =>
            p.storeId === where.storeId &&
            (where.status === undefined || p.status === where.status) &&
            (where.deletedAt === undefined || p.deletedAt === null) &&
            (!where.categories || p.categories === 0)
        ).length;
      },
    },
    category: {
      count: async ({ where }: { where: { storeId: string; deletedAt?: null } }) => {
        db.countWheres.push(where);
        return db.categories.filter(
          c =>
            c.storeId === where.storeId && (where.deletedAt === undefined || c.deletedAt === null)
        ).length;
      },
    },
  }),
}));

import { aiRunCalls } from '@api/lib/ai-run-estimate';

async function app() {
  const { default: router } = await import('@api/routes/ai.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const a = express();
  a.use(express.json());
  a.use('/stores/:storeId/ai', router, errorHandler);
  return a;
}
const get = async (store: string, user: string, qs = '') =>
  request(await app())
    .get(`/stores/${store}/ai/bulk-estimate${qs}`)
    .set('x-user', user);

const row = (storeId: string, o: Partial<P> = {}): P => ({
  storeId,
  status: 'active',
  deletedAt: null,
  categories: 1,
  ...o,
});

beforeEach(() => {
  db.countWheres.length = 0;
  db.products = [
    // store A: 3 live (2 active, 1 draft), 1 deleted, 1 active+uncategorised
    row(STORE_A),
    row(STORE_A, { categories: 0 }),
    row(STORE_A, { status: 'draft' }),
    row(STORE_A, { deletedAt: new Date() }),
    // store B: 10 active products - must never leak into A's number
    ...Array.from({ length: 10 }, () => row(STORE_B)),
  ];
  db.categories = [
    { storeId: STORE_A, deletedAt: null },
    { storeId: STORE_A, deletedAt: new Date() },
    { storeId: STORE_B, deletedAt: null },
  ];
});

describe('bulk-estimate', () => {
  it('equals what the shared formula (the one the run uses) gives for the same rows', async () => {
    const res = await get(STORE_A, OWNER_A, '?tool=excerpt');
    expect(res.status).toBe(200);
    const live = 3;
    const active = 2;
    const cats = { all: 2, live: 1 };
    expect(res.body.data.estimates).toEqual([
      {
        tool: 'excerpt',
        estimatedCalls: aiRunCalls('excerpt', { products: active, categories: 0 }),
      },
    ]);
    expect(res.body.data.estimates[0].estimatedCalls).toBe(2);
    const all = await get(STORE_A, OWNER_A);
    const by = Object.fromEntries(
      (all.body.data.estimates as { tool: string; estimatedCalls: number }[]).map(e => [
        e.tool,
        e.estimatedCalls,
      ])
    );
    expect(by['seo']).toBe(1 + cats.live + live);
    expect(by['translate-ar']).toBe((live + cats.all + 1) * 2);
    expect(by['categorize']).toBe(1);
    expect(by['image-alt']).toBe(active * 4);
    expect(by['revert-balance']).toBe(0);
    expect(by['aeo-all']).toBe(8 + 3 + (1 + cats.live + live));
    expect(by['geo-all']).toBe(1 + live + 1);
    expect(Object.keys(by).length).toBe(19);
    expect(all.body.data.isCeiling).toBe(true);
  });

  it("counts only the path store's rows: store B's 10 products never reach store A's number", async () => {
    const res = await get(STORE_A, OWNER_A, '?tool=tags');
    expect(res.body.data.estimates[0].estimatedCalls).toBe(2);
    expect((db.countWheres as { storeId: string }[]).every(w => w.storeId === STORE_A)).toBe(true);
  });

  it("refuses another tenant's store (403) and counts nothing", async () => {
    const res = await get(STORE_B, OWNER_A, '?tool=excerpt');
    expect(res.status).toBe(403);
    expect(db.countWheres).toEqual([]);
  });

  it('refuses an unknown tool and a bad faqCount (Zod at the edge)', async () => {
    expect((await get(STORE_A, OWNER_A, '?tool=drop-table')).status).toBe(400);
    expect((await get(STORE_A, OWNER_A, '?tool=faq-aeo&faqCount=999')).status).toBe(400);
    expect(
      (await get(STORE_A, OWNER_A, '?tool=faq-aeo&faqCount=12')).body.data.estimates[0]
        .estimatedCalls
    ).toBe(12);
    expect(db.countWheres).toEqual([]);
  });
});
