/**
 * The code-level tenant guard (R-EBDA-003) on a REAL `ebda_app` login, through the factory's
 * client — the layer tests/integration/rls-ebda-app.test.ts deliberately leaves out.
 *
 * What this file proves:
 *   - the ONE factory installs the guard on every app client (a contextless or cross-store
 *     query is refused with `TenantScopeViolation`, not answered with RLS's empty set);
 *   - a refused write never reaches Postgres (the row does not exist afterwards);
 *   - the ambient scope is the one `runInTenantContext` / `withUser` / `withStore` /
 *     `scopeTransaction` / `runInStoreScope` establish, including a LAZY Prisma promise
 *     returned out of the callback unawaited;
 *   - the named hatches: `withOwnerTx` (only on a role that bypasses RLS), `asPlatformOperator`
 *     (only an active super_admin; opens Store/User, never a tenant table), the owner-role
 *     client (refuses `ebda_app`);
 *   - the raw-SQL policy (R-EBDA-004): contextless SQL naming a tenant table is refused, a
 *     SECURITY DEFINER call is not;
 *   - both layers together: a query the guard accepts is still filtered by RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  runInStoreScope,
  withStore,
  withUser,
  withOwnerTx,
  withMoneyTx,
  scopeTransaction,
  asPlatformOperator,
  currentStoreId,
  storeDirectory,
  prisma,
  TenantScopeViolation,
  type AppPrismaClient,
} from '@ebda/database';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = 'tgea-';

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}

/** Run `fn` with `prisma` & friends bound to a GUARDED client on a real ebda_app login. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 2 }), fn);

/** Same, but the guarded APP client on the OWNER connection (proves the guard is not RLS). */
const asAppOnOwnerRole = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: OWNER_URL, max: 2 }), fn);

let owner: AppPrismaClient;
const ids = {} as {
  storeA: string;
  storeB: string;
  ownerA: string;
  superAdmin: string;
  productA: string;
  productB: string;
};

const refused = async (p: Promise<unknown>, why?: RegExp) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err, 'expected a TenantScopeViolation').toBeInstanceOf(TenantScopeViolation);
  if (why) expect(String((err as Error).message)).toMatch(why);
};

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe(
    `DELETE FROM public.products WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM public.store_faqs WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`
  );
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  await cleanup();
  const run = crypto.randomUUID().slice(0, 8);
  const mkUser = (tag: string, role: string) =>
    owner.user.create({
      data: {
        email: `${PREFIX}${tag}-${run}@test.com`,
        passwordHash: 'x',
        firstName: tag,
        lastName: 'T',
        role: role as never,
      },
    });
  const ownerA = await mkUser('ownerA', 'store_admin');
  const ownerB = await mkUser('ownerB', 'store_admin');
  const superAdmin = await mkUser('super', 'super_admin');
  const storeA = await owner.store.create({
    data: { slug: `${PREFIX}a-${run}`, name: 'TG A', ownerId: ownerA.id },
  });
  const storeB = await owner.store.create({
    data: { slug: `${PREFIX}b-${run}`, name: 'TG B', ownerId: ownerB.id },
  });
  const mkProduct = (storeId: string, tag: string) =>
    owner.product.create({
      data: { storeId, name: tag, slug: `${PREFIX}${tag}-${run}`, price: 1000 },
    });
  Object.assign(ids, {
    storeA: storeA.id,
    storeB: storeB.id,
    ownerA: ownerA.id,
    superAdmin: superAdmin.id,
    productA: (await mkProduct(storeA.id, 'pa')).id,
    productB: (await mkProduct(storeB.id, 'pb')).id,
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the factory installs the guard on every app client', () => {
  it('contextless: a tenant query is REFUSED (not answered with an empty set)', async () => {
    await refused(
      asApp(() => prisma.product.findMany()),
      /no ambient store/
    );
  });

  it('the guard is not RLS: on an RLS-BYPASSING role the same query is still refused', async () => {
    await refused(asAppOnOwnerRole(() => prisma.product.findMany({ select: { id: true } })));
    await refused(
      asAppOnOwnerRole(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.product.findUnique({ where: { id: ids.productB, storeId: ids.storeB } })
        )
      ),
      /cross-store/
    );
  });

  it('a properly scoped query passes and returns the row', async () => {
    const p = await asApp(() =>
      runInTenantContext(ids.storeA, () =>
        prisma.product.findUnique({ where: { id: ids.productA, storeId: ids.storeA } })
      )
    );
    expect(p?.id).toBe(ids.productA);
  });

  it('cross-store and unscoped reads/writes are refused inside a store scope', async () => {
    await asApp(() =>
      runInTenantContext(ids.storeA, async () => {
        await refused(
          prisma.product.findUnique({ where: { id: ids.productB, storeId: ids.storeB } }),
          /cross-store/
        );
        await refused(prisma.product.findUnique({ where: { id: ids.productB } }), /not scoped/);
        await refused(
          prisma.product.updateMany({ where: { id: ids.productB }, data: { name: 'x' } })
        );
        await refused(prisma.product.deleteMany({ where: { storeId: ids.storeB } }), /cross-store/);
      })
    );
  });

  it('a refused write never reaches Postgres', async () => {
    const before = await owner.storeFaq.count({ where: { storeId: ids.storeB } });
    await asApp(() =>
      runInTenantContext(ids.storeA, async () => {
        await refused(
          prisma.storeFaq.create({ data: { storeId: ids.storeB, question: 'q', answer: 'a' } }),
          /another store/
        );
        await refused(prisma.storeFaq.create({ data: { question: 'q', answer: 'a' } as never }));
      })
    );
    expect(await owner.storeFaq.count({ where: { storeId: ids.storeB } })).toBe(before);
  });

  it('a nested write into another store is refused', async () => {
    await refused(
      asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.product.update({
            where: { id: ids.productA, storeId: ids.storeA },
            data: {
              inventoryHistory: {
                create: { storeId: ids.storeB, change: 1, reason: 'x' } as never,
              },
            },
          })
        )
      ),
      /nested/
    );
  });
});

describe('both layers together', () => {
  it("a query the guard accepts is still filtered by RLS (store A asking for B's row by A's key)", async () => {
    const p = await asApp(() =>
      runInTenantContext(ids.storeA, () =>
        prisma.product.findFirst({ where: { id: ids.productB, storeId: ids.storeA } })
      )
    );
    expect(p).toBeNull();
  });
});

describe('the ambient scope', () => {
  it('a LAZY promise returned out of withUser / withStore / runInTenantContext is evaluated in scope', async () => {
    const me = await asApp(() =>
      withUser(ids.ownerA, tx => tx.user.findUnique({ where: { id: ids.ownerA } }))
    );
    expect(me?.id).toBe(ids.ownerA);
    const p = await asApp(() =>
      withStore(ids.storeA, tx => tx.product.findFirst({ where: { storeId: ids.storeA } }))
    );
    expect(p?.id).toBe(ids.productA);
    const n = await asApp(() =>
      runInTenantContext(ids.storeA, () => prisma.product.count({ where: { storeId: ids.storeA } }))
    );
    expect(n).toBe(1);
  });

  it('runInStoreScope: each query runs in its own scoped transaction and passes', async () => {
    const n = await asApp(() =>
      runInStoreScope(ids.storeA, () => prisma.product.count({ where: { storeId: ids.storeA } }))
    );
    expect(n).toBe(1);
  });

  it('scopeTransaction binds a caller-opened transaction (sets the GUCs AND the guard scope)', async () => {
    const n = await asApp(() =>
      withMoneyTx(prisma, tx =>
        scopeTransaction(tx, { storeId: ids.storeA }, t =>
          t.product.count({ where: { storeId: ids.storeA } })
        )
      )
    );
    expect(n).toBe(1);
    await refused(
      asApp(() => withMoneyTx(prisma, tx => tx.product.count({ where: { storeId: ids.storeA } })))
    );
  });

  it('currentStoreId() is the ambient store, and throws outside one', async () => {
    expect(await asApp(() => withStore(ids.storeA, async () => currentStoreId()))).toBe(ids.storeA);
    expect(() => currentStoreId()).toThrow(/no ambient store/);
  });
});

describe('named hatches', () => {
  it('withOwnerTx opens the guard only on a role that bypasses RLS, and refuses ebda_app', async () => {
    await expect(asApp(() => withOwnerTx(tx => tx.product.count()))).rejects.toThrow(
      /strict-RLS app role/
    );
    const n = await asAppOnOwnerRole(() =>
      withOwnerTx(tx => tx.product.count({ where: { slug: { startsWith: PREFIX } } }))
    );
    expect(n).toBe(2);
  });

  it('asPlatformOperator: an active super_admin reads the store directory rows; a store admin is refused', async () => {
    const stores = await asApp(() =>
      asPlatformOperator(ids.superAdmin, () =>
        prisma.store.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
      )
    );
    expect(stores.map(s => s.id).sort()).toEqual([ids.storeA, ids.storeB].sort());
    await expect(
      asApp(() => asPlatformOperator(ids.ownerA, () => prisma.store.findMany()))
    ).rejects.toThrow(/not an active super_admin/);
  });

  it('asPlatformOperator never opens a store-scoped tenant table', async () => {
    await refused(asApp(() => asPlatformOperator(ids.superAdmin, () => prisma.product.findMany())));
  });

  it('the owner-role client refuses a role that does not bypass RLS', async () => {
    const c = createPrismaClient({ connectionString: appUrl(), max: 1, role: 'owner' });
    try {
      await expect(c.product.count()).rejects.toThrow(/does not bypass RLS/);
    } finally {
      await c.$disconnect();
    }
  });
});

describe('Store (tenant root) and the directory', () => {
  it('Store by the ambient id passes; by another id, or contextless by slug, is refused', async () => {
    const s = await asApp(() =>
      withStore(ids.storeA, tx => tx.store.findUnique({ where: { id: ids.storeA } }))
    );
    expect(s?.id).toBe(ids.storeA);
    await refused(
      asApp(() => withStore(ids.storeA, tx => tx.store.findUnique({ where: { id: ids.storeB } })))
    );
    await refused(asApp(() => prisma.store.findFirst({ where: { slug: `${PREFIX}a` } })));
  });

  it('the store directory is readable with no scope (definer) and lists both stores', async () => {
    const dir = await asApp(() => storeDirectory(s => s.slug.startsWith(PREFIX)));
    expect(dir.map(s => s.id).sort()).toEqual([ids.storeA, ids.storeB].sort());
  });
});

describe('raw SQL (R-EBDA-004)', () => {
  it('contextless SQL naming a tenant table is refused; a definer call and SELECT 1 are not', async () => {
    await refused(asApp(() => prisma.$queryRawUnsafe('SELECT count(*) FROM public.products')));
    await refused(
      asApp(() => prisma.$queryRaw`SELECT id FROM stores`),
      /stores/
    );
    const one = await asApp(() => prisma.$queryRaw<Array<{ x: number }>>`SELECT 1 AS x`);
    expect(one[0].x).toBe(1);
    const dir = await asApp(
      () => prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM public.ebda_store_directory()`
    );
    expect(dir.length).toBeGreaterThanOrEqual(2);
  });

  it('inside a store scope raw SQL is allowed (RLS is that layer) and RLS filters it', async () => {
    const rows = await asApp(() =>
      runInTenantContext(
        ids.storeA,
        () => prisma.$queryRaw<Array<{ store_id: string }>>`SELECT store_id FROM public.products`
      )
    );
    expect(new Set(rows.map(r => r.store_id))).toEqual(new Set([ids.storeA]));
  });
});

describe('pre-scope store definers', () => {
  it('the public store page past the end is empty, with the total (no NULL id leaks out)', async () => {
    const { publicStorePage } = await import('../../apps/api/src/lib/definer');
    const first = await asApp(() => publicStorePage(0, 100));
    expect(first.total).toBeGreaterThan(0);
    expect(first.ids.every(id => typeof id === 'string')).toBe(true);
    const past = await asApp(() => publicStorePage(first.total + 50, 10));
    expect(past).toEqual({ ids: [], total: first.total });
  });
});
