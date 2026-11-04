/**
 * GET /stores/:storeId/search?q= (search program P2, Task 18): the admin ⌘K palette's record lookup.
 *
 * The real router behind the real `tenantContext`, on the strict-RLS `ebda_app` client bound per
 * request (the way the API runs), with only the auth chain stubbed. Fixtures are per run; the second
 * store carries the same names and phone, to prove no record crosses a store.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: req.header('x-test-role') ?? 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));

const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { tenantContext } = await import('../../apps/api/src/middleware/tenant-context');
const { default: adminSearchRoutes } =
  await import('../../apps/api/src/routes/admin-search.routes');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/stores/:storeId', tenantContext);
  app.use('/api/v1/stores', adminSearchRoutes);
  app.use(errorHandler);
  return app;
}

const tag = `as${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
const ids = { owner: '', ownerB: '', A: '', B: '', reg: `${tag}-reg`, regB: `${tag}-regb` };
let app: Express;

describe.skipIf(!hasDb)('GET /stores/:storeId/search (admin palette)', () => {
  beforeAll(async () => {
    app = buildApp();
    const mk = async (n: string) =>
      (
        await prisma.user.create({
          data: {
            email: `${tag}${n}@x.test`,
            passwordHash: 'x',
            firstName: 'As',
            lastName: n,
            role: 'store_admin',
          },
        })
      ).id;
    ids.owner = await mk('a');
    ids.ownerB = await mk('b');
    ids.A = (
      await prisma.store.create({
        data: { name: `${tag}a`, slug: `${tag}a`, ownerId: ids.owner },
      })
    ).id;
    ids.B = (
      await prisma.store.create({
        data: { name: `${tag}b`, slug: `${tag}b`, ownerId: ids.ownerB },
      })
    ).id;
    for (const [s, suffix] of [
      [ids.A, 'a'],
      [ids.B, 'b'],
    ] as const) {
      await prisma.$executeRaw`
        INSERT INTO public.products (id, store_id, name, name_ar, slug, price, status, updated_at)
        VALUES (${`${tag}-p${suffix}`}, ${s}, ${`Sneakers ${tag}${suffix}`}, 'أحذية رياضية', ${`${tag}-p${suffix}`}, 100, 'active', now())`;
    }
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at) VALUES
        (${ids.reg}, ${ids.A}, ${`reg.${tag}@x.test`}, 'x', 'أحمد', 'علي', '+201012345678', 'customer', now()),
        (${ids.regB}, ${ids.B}, ${`regb.${tag}@x.test`}, 'x', 'أحمد', 'علي', '+201012345678', 'customer', now())`;
    const guest = JSON.stringify({
      firstName: 'منى',
      lastName: 'سالم',
      email: `Mona.${tag}@X.test`,
      phone: '0112 345 6789',
    });
    await prisma.$executeRaw`
      INSERT INTO public.orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at) VALUES
        (${`${tag}-o1`}, ${ids.A}, ${`EB-${tag}-1`}, 1000, 1500, '{}', '{}', ${ids.reg}, now()),
        (${`${tag}-g1`}, ${ids.A}, ${`EB-${tag}-g1`}, 1000, 2500, ${guest}::jsonb, '{}', NULL, now()),
        (${`${tag}-ob`}, ${ids.B}, ${`EB-${tag}-ob`}, 1000, 900, '{}', '{}', ${ids.regB}, now())`;
  }, 60_000);

  afterAll(async () => {
    for (const s of [ids.A, ids.B]) {
      if (!s) continue;
      await prisma.$executeRaw`DELETE FROM public.orders WHERE store_id = ${s}`;
      await prisma.$executeRaw`DELETE FROM public.products WHERE store_id = ${s}`;
      await prisma.$executeRaw`DELETE FROM public.users WHERE store_id = ${s}`;
      await prisma.store.delete({ where: { id: s } }).catch(() => undefined);
    }
    for (const u of [ids.owner, ids.ownerB])
      if (u) await prisma.user.delete({ where: { id: u } }).catch(() => undefined);
  }, 60_000);

  // The term rides in the X-Search-Query header, never the URL (Ruling SEARCH-P2-9).
  const search = (q: string, role = 'store_admin', store = ids.A) =>
    request(app)
      .get(`/api/v1/stores/${store}/search`)
      .set('x-test-role', role)
      .set(
        ...(q ? (['X-Search-Query', encodeURIComponent(q)] as const) : (['x-none', '1'] as const))
      );

  it('a product is found by its Arabic name folded (احذيه finds أحذية), and only this store’s', async () => {
    const res = await search('احذيه');
    expect(res.status).toBe(200);
    expect(res.body.data.products.map((p: { id: string }) => p.id)).toEqual([`${tag}-pa`]);
  });

  it('a phone in any form finds the customer and their order, never the other store’s', async () => {
    for (const q of ['0101 234 5678', '+201012345678', '٠١٠١٢٣٤٥٦٧٨']) {
      const res = await search(q);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.customers).toEqual([
        { key: ids.reg, name: 'أحمد علي', phone: '+201012345678', isGuest: false },
      ]);
      expect(d.orders.map((o: { id: string }) => o.id)).toEqual([`${tag}-o1`]);
      expect(d.orders[0]).toMatchObject({ orderNumber: `EB-${tag}-1`, total: 1500 });
    }
  });

  it('a guest customer is listed under the Customers-page key (lowercased email)', async () => {
    const res = await search('منى');
    expect(res.body.data.customers).toEqual([
      { key: `mona.${tag}@x.test`, name: 'منى سالم', phone: '0112 345 6789', isGuest: true },
    ]);
    expect(res.body.data.orders.map((o: { id: string }) => o.id)).toEqual([`${tag}-g1`]);
    const byPhone = await search('01123456789');
    expect(byPhone.body.data.customers.map((c: { key: string }) => c.key)).toEqual([
      `mona.${tag}@x.test`,
    ]);
  });

  it('one character answers products only (word-start); empty or metacharacters: three empty lists', async () => {
    const one = await search('ا');
    expect(one.status).toBe(200);
    expect(one.body.data.products.map((p: { id: string }) => p.id)).toContain(`${tag}-pa`);
    expect(one.body.data.customers).toEqual([]);
    expect(one.body.data.orders).toEqual([]);
    for (const q of ['', '%']) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ products: [], orders: [], customers: [] });
    }
  });

  it('the other store never leaks: its product and customer are only found in its own scope', async () => {
    const own = await search(`Sneakers ${tag}b`, 'store_admin', ids.B);
    expect(own.body.data.products.map((p: { id: string }) => p.id)).toEqual([`${tag}-pb`]);
    const cross = await search(`Sneakers ${tag}b`, 'store_admin', ids.A);
    expect(cross.body.data.products).toEqual([]);
    const cust = await search('أحمد', 'store_admin', ids.B);
    expect(cust.body.data.customers.map((c: { key: string }) => c.key)).toEqual([ids.regB]);
  });

  it('a role without a kind’s permission gets an empty list for it, not an error', async () => {
    const res = await search('أحمد', 'nobody');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ products: [], orders: [], customers: [] });
  });

  it('an erased (soft-deleted) customer and a deleted guest order are not listed (review M1/M2)', async () => {
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at, deleted_at)
      VALUES (${`${tag}-del`}, ${ids.A}, ${`del.${tag}@x.test`}, 'x', 'ملغي', 'ملغي', '+201555000111', 'customer', now(), now())`;
    await prisma.$executeRaw`
      INSERT INTO public.orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at, deleted_at)
      VALUES (${`${tag}-gdel`}, ${ids.A}, ${`EB-${tag}-gd`}, 1, 1, ${JSON.stringify({ firstName: 'ملغي', phone: '+201555000222' })}::jsonb, '{}', NULL, now(), now()),
             (${`${tag}-odel`}, ${ids.A}, ${`EB-${tag}-od`}, 1, 1, '{}', '{}', ${`${tag}-del`}, now(), NULL)`;
    const res = await search('ملغي');
    expect(res.body.data.customers).toEqual([]);
    expect(res.body.data.orders).toEqual([]);
  });
});
