/**
 * INFRA-CF-1 R6a (Ruling CF-R6A-1): the admin command palette (GET /stores/:storeId/search) answers the same on a Durable
 * Object store as on Postgres. The REAL router runs twice over the same fixtures, once on Postgres (unchanged code) and once
 * with the DO money client over the real DO schema on SQLite (products, registered customers and guest-order contacts
 * mirrored into it); the response bodies must be equal for Arabic spellings (folded), phones in every form, an e-mail, an
 * order number, a one-letter term, an empty term and a term nobody matches.
 */
import crypto from 'crypto';
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import {
  answerMoneyOp,
  decodeRpc,
  encodeRpc,
  ensureMoneyOpsSchema,
  createDoClient,
  createPrismaLite,
  ensureIdempotencySchema,
  runReads,
  runWrites,
  ensureSearchIndex,
} from '@ebda-src/repo';
import { makeMoneyClient, withRepo } from '../../apps/api/src/lib/repo-factory';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import { META, insertSqlite, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';
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

const tag = `ac${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
// `mig`: a MIGRATED registered customer (Ruling CF-FIX-1): the order carries the platform users.id, the DO CRM row has its OWN id
// and links to the user through customers.user_id.
const ids = { owner: '', store: '', reg: `${tag}-reg`, mig: `${tag}-mig`, migRow: `${tag}-migrow` };
let sqlite = openSqlite();
let doRepo: any;

function buildDoRepo(storeId: string) {
  const sql = nodeSqlRunner(sqlite);
  ensureIdempotencySchema(sql);
  const sync = nodeSyncSql(sqlite);
  ensureMoneyOpsSchema(sync);
  ensureSearchIndex(sync);
  const lite = createPrismaLite(META as never, sql, 'store-do', { storeId }) as never;
  const c = createDoClient(
    q => runReads(lite, q),
    m => runWrites(lite, sql, m)
  ) as never;
  const money = makeMoneyClient(async (op, args, key) => {
    const r = answerMoneyOp(sync, storeId, op, encodeRpc(args), key);
    if (!r.ok) throw new AppError(r.status, r.code, r.message);
    return decodeRpc(r.json);
  });
  return { storeId, backend: 'do' as const, db: c, writer: c, money };
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const run = () =>
      new Promise<void>(resolve => {
        res.once('finish', resolve);
        res.once('close', resolve);
        next();
      });
    asApp(() => (req.header('x-test-backend') === 'do' ? withRepo(doRepo, run) : run())).catch(
      next
    );
  });
  app.use('/api/v1/stores/:storeId', tenantContext);
  app.use('/api/v1/stores', adminSearchRoutes);
  app.use(errorHandler);
  return app;
}

describe.skipIf(!hasDb)('admin palette search: Postgres vs the store DO', () => {
  let app: Express;
  beforeAll(async () => {
    app = buildApp();
    ids.owner = (
      await prisma.user.create({
        data: {
          email: `${tag}@x.test`,
          passwordHash: 'x',
          firstName: 'Ac',
          lastName: 'Owner',
          role: 'store_admin',
        },
      })
    ).id;
    ids.store = (
      await prisma.store.create({ data: { name: tag, slug: tag, ownerId: ids.owner } })
    ).id;
    const S = ids.store;
    for (const [suffix, name, nameAr, sku] of [
      ['1', `Running Sneakers ${tag}`, 'أحذية رياضية', 'SN-1'],
      ['2', `Leather Belt ${tag}`, 'حزام جلد', 'BLT-2'],
      ['3', `Ahmed Mug ${tag}`, 'كوب أحمد', 'MUG-3'],
    ] as const)
      await prisma.$executeRaw`
        INSERT INTO public.products (id, store_id, name, name_ar, slug, price, status, sku, updated_at)
        VALUES (${`${tag}-p${suffix}`}, ${S}, ${name}, ${nameAr}, ${`${tag}-p${suffix}`}, 100, 'active', ${sku}, now())`;
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at)
      VALUES (${ids.reg}, ${S}, ${`reg.${tag}@x.test`}, 'x', 'أحمد', 'علي', '+201012345678', 'customer', now())`;
    await prisma.$executeRaw`
      INSERT INTO public.users (id, store_id, email, password_hash, first_name, last_name, phone, role, updated_at)
      VALUES (${ids.mig}, ${S}, ${`mig.${tag}@x.test`}, 'x', 'خالد', 'منصور', '+201234567890', 'customer', now())`;
    const guest = JSON.stringify({
      firstName: 'منى',
      lastName: 'سالم',
      email: `Mona.${tag}@X.test`,
      phone: '0112 345 6789',
    });
    await prisma.$executeRaw`
      INSERT INTO public.orders (id, store_id, order_number, subtotal, total, shipping_address, billing_address, customer_id, updated_at) VALUES
        (${`${tag}-o1`}, ${S}, ${`EB-${tag}-1`}, 1000, 1500, '{}', '{}', ${ids.reg}, now()),
        (${`${tag}-o2`}, ${S}, ${`EB-${tag}-2`}, 1000, 1700, '{}', '{}', ${ids.mig}, now()),
        (${`${tag}-g1`}, ${S}, ${`EB-${tag}-g1`}, 1000, 2500, ${guest}::jsonb, '{}', NULL, now())`;
    // the DO side: the same products, the registered customer as a `customers` row with the SAME id, the same orders
    insertSqlite(
      sqlite,
      'Product',
      (await prisma.product.findMany({ where: { storeId: S } })) as never
    );
    insertSqlite(sqlite, 'Customer', [
      {
        id: ids.reg,
        storeId: S,
        email: `reg.${tag}@x.test`,
        firstName: 'أحمد',
        lastName: 'علي',
        phone: '+201012345678',
        totalOrders: 1,
        totalSpent: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: ids.migRow,
        userId: ids.mig,
        storeId: S,
        email: `mig.${tag}@x.test`,
        firstName: 'خالد',
        lastName: 'منصور',
        phone: '+201234567890',
        totalOrders: 1,
        totalSpent: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    insertSqlite(
      sqlite,
      'Order',
      (await prisma.order.findMany({ where: { storeId: S } })) as never
    );
    doRepo = buildDoRepo(S);
  }, 90_000);

  afterAll(async () => {
    if (ids.store) {
      await prisma.$executeRaw`DELETE FROM public.orders WHERE store_id = ${ids.store}`;
      await prisma.$executeRaw`DELETE FROM public.products WHERE store_id = ${ids.store}`;
      await prisma.$executeRaw`DELETE FROM public.users WHERE store_id = ${ids.store}`;
      await prisma.store.delete({ where: { id: ids.store } }).catch(() => undefined);
    }
    if (ids.owner) await prisma.user.delete({ where: { id: ids.owner } }).catch(() => undefined);
  }, 60_000);

  const ask = (backend: 'pg' | 'do', q: string, role = 'store_admin') =>
    request(app)
      .get(`/api/v1/stores/${ids.store}/search`)
      .set('x-test-role', role)
      .set('x-test-backend', backend)
      .set(
        ...(q ? (['X-Search-Query', encodeURIComponent(q)] as const) : (['x-none', '1'] as const))
      );

  const terms: Array<[string, string]> = [
    ['an Arabic product, hamza-folded', 'احذيه'],
    ['an English product word', 'sneakers'],
    ['a SKU', 'BLT-2'],
    ['a one-letter term', 'ا'],
    ['a name that is a customer AND a product word', 'أحمد'],
    ['a phone, local form', '0101 234 5678'],
    ['a phone, +20', '+201012345678'],
    ['a phone, Arabic-Indic digits', '٠١٠١٢٣٤٥٦٧٨'],
    ['a migrated customer (order.customer_id is a users.id), by name', 'خالد'],
    ['a migrated customer, by phone', '01234567890'],
    ['a guest by name', 'منى'],
    ['a guest by phone', '01123456789'],
    ['a guest by e-mail', `mona.${tag}@x.test`],
    ['an order number', `EB-${tag}-1`],
    ['nothing', 'zzzzqqq'],
    ['empty', ''],
    ['a LIKE metacharacter', '%'],
  ];
  for (const [label, q] of terms)
    it(`${label}: the DO answers exactly what Postgres answers`, async () => {
      const pg = await ask('pg', q);
      const dd = await ask('do', q);
      expect(dd.status).toBe(pg.status);
      expect(dd.body).toEqual(pg.body);
    });

  it('the fixtures are not vacuous: the term kinds really find something on both backends', async () => {
    for (const backend of ['pg', 'do'] as const) {
      const p = (await ask(backend, 'احذيه')).body.data;
      expect(p.products.map((x: { id: string }) => x.id)).toEqual([`${tag}-p1`]);
      const c = (await ask(backend, '0101 234 5678')).body.data;
      expect(c.customers).toEqual([
        { key: ids.reg, name: 'أحمد علي', phone: '+201012345678', isGuest: false },
      ]);
      expect(c.orders.map((x: { id: string }) => x.id)).toEqual([`${tag}-o1`]);
      const m = (await ask(backend, 'خالد')).body.data;
      expect(m.customers).toEqual([
        { key: ids.mig, name: 'خالد منصور', phone: '+201234567890', isGuest: false },
      ]);
      expect(m.orders).toEqual([
        expect.objectContaining({ id: `${tag}-o2`, customerName: 'خالد منصور' }),
      ]);
      const g = (await ask(backend, 'منى')).body.data;
      expect(g.customers.map((x: { key: string }) => x.key)).toEqual([`mona.${tag}@x.test`]);
    }
  });

  it('a role without a kind’s permission gets an empty list for it on the DO too', async () => {
    const res = await ask('do', 'أحمد', 'nobody');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ products: [], orders: [], customers: [] });
  });
});
