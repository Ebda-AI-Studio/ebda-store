/**
 * B2B wholesale tables: strict RLS + FORCE, ebda_app grants, constraints, FK cascades
 * (docs/plans/done/2026-10-21-b2b-wholesale.md, Task 1; migrations 20261028000100 / 20261028000200).
 *
 * rls-ebda-app.test.ts already walks EVERY store_id table from information_schema (RLS enabled + forced, only ebda_app
 * policies, contextless SELECT = 0 rows, contextless INSERT rejected), so a new table that ships without a policy is
 * red there. This file adds what that generic walk cannot: two-store isolation with REAL rows in `product_price_tiers`
 * and `wholesale_applications` (so "0 rows" is not vacuous), the CHECK / unique-index rules, the FK delete rules, and the
 * plans-row entitlement. Assertions run as a real `ebda_app` login; fixtures are written with the owner connection.
 * Retry-safe: every fixture is keyed on a per-run suffix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TextFallbackClient } from '../../packages/database/src/client';
import { createPrismaClient, runWithRequestDb, prisma, type AppPrismaClient } from '@ebda/database';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const RUN = `b2brls-${crypto.randomBytes(4).toString('hex')}`;

let owner: AppPrismaClient;
const makeApp = (): AppPrismaClient => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: u.toString(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;
};
function appTx<T>(
  storeId: string | undefined,
  fn: (tx: Parameters<Parameters<AppPrismaClient['$transaction']>[0]>[0]) => Promise<T>
): Promise<T> {
  return runWithRequestDb(makeApp, () =>
    prisma.$transaction(async tx => {
      if (storeId) await tx.$queryRaw`SELECT set_config('app.current_store_id', ${storeId}, true)`;
      return fn(tx);
    })
  );
}

const ids = {} as Record<string, string>;
const q = <T = unknown>(sql: string, ...p: unknown[]) => owner.$queryRawUnsafe<T[]>(sql, ...p);
const exec = (sql: string, ...p: unknown[]) => owner.$executeRawUnsafe(sql, ...p);

async function cleanup() {
  await exec(`DELETE FROM public.stores WHERE slug LIKE '${RUN}%'`);
  await exec(`DELETE FROM public.users WHERE email LIKE '${RUN}%'`);
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  await cleanup();
  const mk = (tag: string, role: string, storeId: string | null) =>
    owner.user.create({
      data: {
        email: `${RUN}-${tag}@test.com`,
        passwordHash: 'x',
        firstName: tag,
        lastName: 'T',
        role: role as never,
        storeId,
      },
    });
  const oA = await mk('ownerA', 'store_admin', null);
  const oB = await mk('ownerB', 'store_admin', null);
  const sA = await owner.store.create({ data: { slug: `${RUN}-a`, name: 'A', ownerId: oA.id } });
  const sB = await owner.store.create({ data: { slug: `${RUN}-b`, name: 'B', ownerId: oB.id } });
  const uA = await mk('custA', 'customer', sA.id);
  const uB = await mk('custB', 'customer', sB.id);
  const pA = await owner.product.create({
    data: { storeId: sA.id, name: 'pa', slug: `${RUN}-pa`, price: 1000 },
  });
  const pB = await owner.product.create({
    data: { storeId: sB.id, name: 'pb', slug: `${RUN}-pb`, price: 1000 },
  });
  const vA = await owner.productVariant.create({
    data: { productId: pA.id, title: 'v', price: 900 },
  });
  const gA = await owner.customerGroup.create({ data: { storeId: sA.id, name: 'Wholesale' } });
  const gB = await owner.customerGroup.create({ data: { storeId: sB.id, name: 'Wholesale' } });
  const tA = await owner.productPriceTier.create({
    data: { storeId: sA.id, productId: pA.id, minQty: 10, priceMinor: 800 },
  });
  const tB = await owner.productPriceTier.create({
    data: { storeId: sB.id, productId: pB.id, minQty: 10, priceMinor: 800 },
  });
  const aA = await owner.wholesaleApplication.create({
    data: { storeId: sA.id, userId: uA.id, businessName: 'Biz A', phone: '+201000000001' },
  });
  const aB = await owner.wholesaleApplication.create({
    data: { storeId: sB.id, userId: uB.id, businessName: 'Biz B', phone: '+201000000002' },
  });
  Object.assign(ids, {
    sA: sA.id,
    sB: sB.id,
    uA: uA.id,
    uB: uB.id,
    pA: pA.id,
    pB: pB.id,
    vA: vA.id,
    gA: gA.id,
    gB: gB.id,
    tA: tA.id,
    tB: tB.id,
    aA: aA.id,
    aB: aB.id,
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('RLS on the new tables (as a real ebda_app login)', () => {
  it.each(['product_price_tiers', 'wholesale_applications'])(
    '%s: ENABLED + FORCED, one policy, ebda_app only, full CRUD grant',
    async t => {
      const [c] = await q<{ en: boolean; fo: boolean }>(
        `SELECT relrowsecurity AS en, relforcerowsecurity AS fo FROM pg_class WHERE oid = 'public.${t}'::regclass`
      );
      expect(c).toEqual({ en: true, fo: true });
      const pols = await q<{ polname: string; roles: string; cmd: string }>(
        `SELECT polname, (SELECT string_agg(rolname::text, ',' ORDER BY rolname) FROM pg_roles WHERE oid = ANY(polroles)) AS roles, polcmd AS cmd
         FROM pg_policy WHERE polrelid = 'public.${t}'::regclass`
      );
      expect(pols).toHaveLength(1);
      expect(pols[0]).toMatchObject({
        polname: 'ebda_tenant_isolation',
        roles: 'ebda_app',
        cmd: '*',
      });
      const grants = await q<{ p: string }>(
        `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_name = '${t}' AND grantee = 'ebda_app'`
      );
      expect(grants.map(g => g.p).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  );

  it('store A sees only its own tiers and applications; store B only its own', async () => {
    const a = await appTx(ids.sA!, async tx => ({
      tiers: await tx.productPriceTier.findMany({
        where: { id: { in: [ids.tA!, ids.tB!] } },
        select: { id: true },
      }),
      apps: await tx.wholesaleApplication.findMany({
        where: { id: { in: [ids.aA!, ids.aB!] } },
        select: { id: true },
      }),
    }));
    expect(a.tiers.map(r => r.id)).toEqual([ids.tA]);
    expect(a.apps.map(r => r.id)).toEqual([ids.aA]);
    const b = await appTx(ids.sB!, async tx => ({
      tiers: await tx.productPriceTier.findMany({
        where: { id: { in: [ids.tA!, ids.tB!] } },
        select: { id: true },
      }),
      apps: await tx.wholesaleApplication.findMany({
        where: { id: { in: [ids.aA!, ids.aB!] } },
        select: { id: true },
      }),
    }));
    expect(b.tiers.map(r => r.id)).toEqual([ids.tB]);
    expect(b.apps.map(r => r.id)).toEqual([ids.aB]);
  });

  it('a contextless ebda_app query sees nothing and cannot insert', async () => {
    const seen = await appTx(undefined, async tx => ({
      tiers: await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM public.product_price_tiers WHERE id = '${ids.tA}'`
      ),
      apps: await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM public.wholesale_applications WHERE id = '${ids.aA}'`
      ),
    }));
    expect(Number(seen.tiers[0]!.n)).toBe(0);
    expect(Number(seen.apps[0]!.n)).toBe(0);
    await expect(
      appTx(undefined, tx =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.product_price_tiers (id, store_id, product_id, min_qty, price_minor, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sA}', '${ids.pA}', 5, 100, now())`
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it("store A cannot write a row into store B, nor update / delete B's rows", async () => {
    await expect(
      appTx(ids.sA!, tx =>
        tx.$executeRawUnsafe(
          `INSERT INTO public.wholesale_applications (id, store_id, user_id, business_name, phone, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sB}', '${ids.uB}', 'x', '1', now())`
        )
      )
    ).rejects.toThrow(/row-level security/i);
    const touched = await appTx(ids.sA!, async tx => [
      await tx.$executeRawUnsafe(
        `UPDATE public.product_price_tiers SET price_minor = 1 WHERE id = '${ids.tB}'`
      ),
      await tx.$executeRawUnsafe(`DELETE FROM public.product_price_tiers WHERE id = '${ids.tB}'`),
      await tx.$executeRawUnsafe(
        `UPDATE public.wholesale_applications SET status = 'approved' WHERE id = '${ids.aB}'`
      ),
      await tx.$executeRawUnsafe(
        `DELETE FROM public.wholesale_applications WHERE id = '${ids.aB}'`
      ),
    ]);
    expect(touched).toEqual([0, 0, 0, 0]);
    const [still] = await q<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM public.product_price_tiers WHERE id = '${ids.tB}' AND price_minor = 800`
    );
    expect(Number(still!.n)).toBe(1);
  });

  it('store A cannot move its own row into store B by UPDATE (WITH CHECK)', async () => {
    await expect(
      appTx(ids.sA!, tx =>
        tx.$executeRawUnsafe(
          `UPDATE public.product_price_tiers SET store_id = '${ids.sB}' WHERE id = '${ids.tA}'`
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('constraints', () => {
  const rejects = (sql: string, re: RegExp) => expect(exec(sql)).rejects.toThrow(re);
  const tierInsert = (cols: string) =>
    `INSERT INTO public.product_price_tiers (id, store_id, product_id, ${cols.split('|')[0]}, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sA}', '${ids.pA}', ${cols.split('|')[1]}, now())`;

  it('tier min_qty >= 2 and price_minor >= 0', async () => {
    await rejects(tierInsert('min_qty, price_minor|1, 100'), /product_price_tiers_min_qty_chk/);
    await rejects(tierInsert('min_qty, price_minor|5, -1'), /product_price_tiers_price_minor_chk/);
  });

  it('one tier per (product, variant|all, group|all, min_qty): NULL scopes collide, distinct scopes do not', async () => {
    // tA is (pA, NULL, NULL, 10): the same scope collides even though both NULLs are "distinct" to a plain UNIQUE.
    await rejects(
      tierInsert('min_qty, price_minor|10, 700'),
      /product_price_tiers_scope_min_qty_key/
    );
    // Different scopes at the same minQty are fine.
    await exec(
      `INSERT INTO public.product_price_tiers (id, store_id, product_id, variant_id, min_qty, price_minor, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sA}', '${ids.pA}', '${ids.vA}', 10, 700, now())`
    );
    await exec(
      `INSERT INTO public.product_price_tiers (id, store_id, product_id, group_id, min_qty, price_minor, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sA}', '${ids.pA}', '${ids.gA}', 10, 600, now())`
    );
    await rejects(
      `INSERT INTO public.product_price_tiers (id, store_id, product_id, group_id, min_qty, price_minor, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sA}', '${ids.pA}', '${ids.gA}', 10, 500, now())`,
      /product_price_tiers_scope_min_qty_key/
    );
  });

  it('at most one PENDING application per (store, user); a decided one does not block a new one', async () => {
    const ins = (status: string) =>
      `INSERT INTO public.wholesale_applications (id, store_id, user_id, business_name, phone, status, updated_at) VALUES ('${crypto.randomUUID()}', '${ids.sA}', '${ids.uA}', 'again', '1', '${status}', now())`;
    await rejects(ins('pending'), /wholesale_applications_one_pending_key/); // aA is pending
    await exec(
      `UPDATE public.wholesale_applications SET status = 'rejected' WHERE id = '${ids.aA}'`
    );
    await exec(ins('pending'));
    await rejects(ins('pending'), /wholesale_applications_one_pending_key/);
    await exec(ins('approved'));
    await exec(ins('revoked'));
  });

  it('application status is an enum', async () => {
    await rejects(
      `UPDATE public.wholesale_applications SET status = 'maybe' WHERE id = '${ids.aB}'`,
      /wholesale_applications_status_chk/
    );
  });

  it('group pricing mode / discount, product moq / audience, order-item price_source are range-checked', async () => {
    await rejects(
      `UPDATE public.customer_groups SET discount_bps = 9001 WHERE id = '${ids.gA}'`,
      /customer_groups_discount_bps_chk/
    );
    await rejects(
      `UPDATE public.customer_groups SET discount_bps = -1 WHERE id = '${ids.gA}'`,
      /customer_groups_discount_bps_chk/
    );
    await rejects(
      `UPDATE public.customer_groups SET pricing_mode = 'free' WHERE id = '${ids.gA}'`,
      /customer_groups_pricing_mode_chk/
    );
    await exec(
      `UPDATE public.customer_groups SET pricing_mode = 'percent_off', discount_bps = 9000 WHERE id = '${ids.gA}'`
    );
    await rejects(`UPDATE public.products SET moq = 1 WHERE id = '${ids.pA}'`, /products_moq_chk/);
    await exec(`UPDATE public.products SET moq = 2 WHERE id = '${ids.pA}'`);
    await exec(`UPDATE public.products SET moq = NULL WHERE id = '${ids.pA}'`);
    await rejects(
      `UPDATE public.products SET audience = 'secret' WHERE id = '${ids.pA}'`,
      /products_audience_chk/
    );
    await exec(`UPDATE public.products SET audience = 'wholesale_only' WHERE id = '${ids.pA}'`);
    // order_items needs an order to insert into; assert the constraint exists and is VALIDATED instead.
    const checks = await q<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname IN
         ('order_items_price_source_chk','customer_groups_pricing_mode_chk','customer_groups_discount_bps_chk','products_moq_chk','products_audience_chk')`
    );
    expect(checks.map(c => c.conname).sort()).toEqual([
      'customer_groups_discount_bps_chk',
      'customer_groups_pricing_mode_chk',
      'order_items_price_source_chk',
      'products_audience_chk',
      'products_moq_chk',
    ]);
    for (const c of checks) expect(c.convalidated, c.conname).toBe(true);
  });

  it('defaults: existing and new rows read as retail (none / 0 / public / NULL snapshots)', async () => {
    const [g] = await q<Record<string, unknown>>(
      `SELECT pricing_mode, discount_bps, requires_approval, is_wholesale FROM public.customer_groups WHERE id = '${ids.gB}'`
    );
    expect(g).toEqual({
      pricing_mode: 'none',
      discount_bps: 0,
      requires_approval: false,
      is_wholesale: false,
    });
    const [p] = await q<Record<string, unknown>>(
      `SELECT moq, audience FROM public.products WHERE id = '${ids.pB}'`
    );
    expect(p).toEqual({ moq: null, audience: 'public' });
  });

  it('plans rows carry the entitlement: true for business + comped, false for every other plan', async () => {
    const rows = await q<{ code: string; w: string | null }>(
      `SELECT code, limits->>'wholesalePricing' AS w FROM public.plans`
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(r.w, r.code).toBe(r.code === 'business' || r.code === 'comped' ? 'true' : 'false');
  });
});

describe('FK delete rules (Task 1 step 5): nothing references the new tables, parents cascade or null out', () => {
  it('no foreign key points AT product_price_tiers or wholesale_applications', async () => {
    const refs = await q<{ child: string }>(
      `SELECT conrelid::regclass::text AS child FROM pg_constraint
        WHERE contype = 'f' AND confrelid IN ('public.product_price_tiers'::regclass, 'public.wholesale_applications'::regclass)`
    );
    expect(refs).toEqual([]);
  });

  it('every FK of the new tables has the intended delete rule (c = CASCADE, n = SET NULL; never NO ACTION)', async () => {
    const rows = await q<{ name: string; del: string }>(
      `SELECT conname AS name, confdeltype AS del FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN ('public.product_price_tiers'::regclass, 'public.wholesale_applications'::regclass)`
    );
    const want: Record<string, string> = {
      product_price_tiers_store_id_fkey: 'c',
      product_price_tiers_product_id_fkey: 'c',
      product_price_tiers_variant_id_fkey: 'c',
      product_price_tiers_group_id_fkey: 'c',
      product_price_tiers_store_product_fkey: 'c',
      product_price_tiers_product_variant_fkey: 'c',
      product_price_tiers_store_group_fkey: 'c',
      wholesale_applications_store_id_fkey: 'c',
      wholesale_applications_user_id_fkey: 'c',
      wholesale_applications_group_id_fkey: 'n',
      wholesale_applications_store_user_fkey: 'c',
      wholesale_applications_store_group_fkey: 'n',
    };
    expect(Object.fromEntries(rows.map(r => [r.name, r.del]))).toEqual(want);
  });

  it('deleting a group removes its tiers and NULLs (not deletes) application history; deleting a variant / product / user cleans up', async () => {
    const g = await owner.customerGroup.create({ data: { storeId: ids.sA!, name: `${RUN}-tmp` } });
    const prod = await owner.product.create({
      data: { storeId: ids.sA!, name: 't', slug: `${RUN}-t`, price: 500 },
    });
    const vr = await owner.productVariant.create({ data: { productId: prod.id, title: 'tv' } });
    const usr = await owner.user.create({
      data: {
        email: `${RUN}-tmpu@test.com`,
        passwordHash: 'x',
        firstName: 't',
        lastName: 't',
        role: 'customer',
        storeId: ids.sA!,
      },
    });
    const mkTier = (o: Record<string, unknown>) =>
      owner.productPriceTier.create({
        data: { storeId: ids.sA!, productId: prod.id, priceMinor: 100, ...o } as never,
      });
    const tg = await mkTier({ groupId: g.id, minQty: 2 });
    const tv = await mkTier({ variantId: vr.id, minQty: 3 });
    const tp = await mkTier({ minQty: 4 });
    const app = await owner.wholesaleApplication.create({
      data: {
        storeId: ids.sA!,
        userId: usr.id,
        businessName: 'x',
        phone: '1',
        status: 'approved',
        groupId: g.id,
      },
    });

    await owner.customerGroup.delete({ where: { id: g.id } });
    expect(await owner.productPriceTier.findUnique({ where: { id: tg.id } })).toBeNull();
    expect(
      (await owner.wholesaleApplication.findUnique({ where: { id: app.id } }))?.groupId
    ).toBeNull();

    await owner.productVariant.delete({ where: { id: vr.id } });
    expect(await owner.productPriceTier.findUnique({ where: { id: tv.id } })).toBeNull();

    await owner.user.delete({ where: { id: usr.id } });
    expect(await owner.wholesaleApplication.findUnique({ where: { id: app.id } })).toBeNull();

    await owner.product.delete({ where: { id: prod.id } });
    expect(await owner.productPriceTier.findUnique({ where: { id: tp.id } })).toBeNull();
  });

  it('deleting a store removes its tiers and applications', async () => {
    const o = await owner.user.create({
      data: {
        email: `${RUN}-ownerC@test.com`,
        passwordHash: 'x',
        firstName: 'c',
        lastName: 'c',
        role: 'store_admin',
      },
    });
    const s = await owner.store.create({ data: { slug: `${RUN}-c`, name: 'C', ownerId: o.id } });
    const cu = await owner.user.create({
      data: {
        email: `${RUN}-custC@test.com`,
        passwordHash: 'x',
        firstName: 'c',
        lastName: 'c',
        role: 'customer',
        storeId: s.id,
      },
    });
    const p = await owner.product.create({
      data: { storeId: s.id, name: 'c', slug: `${RUN}-pc`, price: 100 },
    });
    await owner.productPriceTier.create({
      data: { storeId: s.id, productId: p.id, minQty: 2, priceMinor: 50 },
    });
    await owner.wholesaleApplication.create({
      data: { storeId: s.id, userId: cu.id, businessName: 'c', phone: '1' },
    });
    await owner.store.delete({ where: { id: s.id } }).catch(async () => {
      // A store with a customer user may be protected by other FKs elsewhere; remove the user first, then retry.
      await owner.user.delete({ where: { id: cu.id } });
      await owner.store.delete({ where: { id: s.id } });
    });
    const [t] = await q<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM public.product_price_tiers WHERE store_id = '${s.id}'`
    );
    const [a] = await q<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM public.wholesale_applications WHERE store_id = '${s.id}'`
    );
    expect([Number(t!.n), Number(a!.n)]).toEqual([0, 0]);
  });
});

describe('C3 ownership composite FKs and C1 customers.user_id (design review, migration 20261028000300)', () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      const m = e as {
        code?: string;
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
        message?: string;
      };
      return m.meta?.driverAdapterError?.cause?.originalCode ?? m.code ?? m.message ?? 'error';
    }
  };
  const FK = '23503';
  const UNIQUE = '23505';

  it('pre-flight: no existing row violates any composite FK or the user link (expected 0 each)', async () => {
    const counts = await q<{ n: bigint }>(
      `SELECT (SELECT count(*) FROM product_price_tiers t JOIN products p ON p.id = t.product_id WHERE p.store_id <> t.store_id)::bigint AS n
       UNION ALL SELECT count(*)::bigint FROM product_price_tiers t JOIN product_variants v ON v.id = t.variant_id WHERE v.product_id <> t.product_id
       UNION ALL SELECT count(*)::bigint FROM product_price_tiers t JOIN customer_groups g ON g.id = t.group_id WHERE g.store_id <> t.store_id
       UNION ALL SELECT count(*)::bigint FROM customers c JOIN customer_groups g ON g.id = c.group_id WHERE g.store_id <> c.store_id
       UNION ALL SELECT count(*)::bigint FROM wholesale_applications a JOIN users u ON u.id = a.user_id WHERE u.store_id IS DISTINCT FROM a.store_id`
    );
    expect(counts.map(c => Number(c.n))).toEqual([0, 0, 0, 0, 0]);
  });

  it("a tier cannot reference another store's product, another product's variant, or another store's group (as owner, RLS off)", async () => {
    const other = await owner.product.create({
      data: { storeId: ids.sA!, name: 'o', slug: `${RUN}-o`, price: 100 },
    });
    const otherVariant = await owner.productVariant.create({
      data: { productId: other.id, title: 'ov' },
    });
    const base = { priceMinor: 50 };
    expect(
      await code(
        owner.productPriceTier.create({
          data: { ...base, storeId: ids.sA!, productId: ids.pB!, minQty: 31 },
        })
      )
    ).toBe(FK);
    expect(
      await code(
        owner.productPriceTier.create({
          data: {
            ...base,
            storeId: ids.sA!,
            productId: ids.pA!,
            variantId: otherVariant.id,
            minQty: 32,
          },
        })
      )
    ).toBe(FK);
    expect(
      await code(
        owner.productPriceTier.create({
          data: { ...base, storeId: ids.sA!, productId: ids.pA!, groupId: ids.gB!, minQty: 33 },
        })
      )
    ).toBe(FK);
    // the legitimate shapes still work
    await owner.productPriceTier.create({
      data: {
        ...base,
        storeId: ids.sA!,
        productId: other.id,
        variantId: otherVariant.id,
        minQty: 34,
      },
    });
  });

  it("an application cannot reference another store's user or group", async () => {
    expect(
      await code(
        owner.wholesaleApplication.create({
          data: {
            storeId: ids.sA!,
            userId: ids.uB!,
            businessName: 'x',
            phone: '1',
            status: 'rejected',
          },
        })
      )
    ).toBe(FK);
    expect(
      await code(
        owner.wholesaleApplication.create({
          data: {
            storeId: ids.sA!,
            userId: ids.uA!,
            businessName: 'x',
            phone: '1',
            status: 'rejected',
            groupId: ids.gB!,
          },
        })
      )
    ).toBe(FK);
  });

  it("a customer cannot reference another store's group or user", async () => {
    expect(
      await code(
        owner.customer.create({
          data: {
            storeId: ids.sA!,
            email: `${RUN}-cg@test.com`,
            firstName: 'x',
            lastName: 'y',
            groupId: ids.gB!,
          },
        })
      )
    ).toBe(FK);
    expect(
      await code(
        owner.customer.create({
          data: {
            storeId: ids.sA!,
            email: `${RUN}-cu@test.com`,
            firstName: 'x',
            lastName: 'y',
            userId: ids.uB!,
          },
        })
      )
    ).toBe(FK);
  });

  it('customers.user_id is unique per store (one CRM row per user); many NULLs are fine', async () => {
    const mk = (tag: string, userId: string | null) =>
      owner.customer.create({
        data: {
          storeId: ids.sA!,
          email: `${RUN}-u${tag}@test.com`,
          firstName: 'x',
          lastName: 'y',
          userId,
        },
      });
    await mk('1', ids.uA!);
    expect(await code(mk('2', ids.uA!))).toBe(UNIQUE);
    await mk('3', null);
    await mk('4', null);
  });

  it('the composite SET NULL clauses name only the dependent column (store_id is never nulled)', async () => {
    const defs = await q<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('customers_store_id_user_id_fkey','customers_store_group_fkey','wholesale_applications_store_group_fkey')`
    );
    expect(defs).toHaveLength(3);
    for (const d of defs)
      expect(d.def, d.name).toMatch(/ON DELETE SET NULL \((user_id|group_id)\)/);
  });

  it('deleting a group NULLs customers.group_id but keeps store_id (no tenant escape)', async () => {
    const g = await owner.customerGroup.create({ data: { storeId: ids.sA!, name: `${RUN}-del` } });
    const c = await owner.customer.create({
      data: {
        storeId: ids.sA!,
        email: `${RUN}-dg@test.com`,
        firstName: 'x',
        lastName: 'y',
        groupId: g.id,
      },
    });
    await owner.customerGroup.delete({ where: { id: g.id } });
    expect(await owner.customer.findUnique({ where: { id: c.id } })).toMatchObject({
      groupId: null,
      storeId: ids.sA!,
    });
  });

  it('the migration backfill links ONLY an unambiguous verified same-store customer-role email match', async () => {
    const fs = await import('node:fs');
    const sql = fs.readFileSync(
      'packages/database/prisma/migrations/20261028000300_b2b_identity_link_ownership_fks/migration.sql',
      'utf8'
    );
    const backfill = sql.slice(sql.indexOf('WITH ranked AS'), sql.indexOf('-- ── C3'));
    const mkU = (tag: string, o: Record<string, unknown>) =>
      owner.user.create({
        data: {
          email: `${RUN}-bf${tag}@test.com`,
          passwordHash: 'x',
          firstName: tag,
          lastName: 'T',
          role: 'customer',
          storeId: ids.sA!,
          ...o,
        } as never,
      });
    const verified = await mkU('v', { emailVerified: true });
    const unverified = await mkU('u', { emailVerified: false });
    const crmV = await owner.customer.create({
      data: {
        storeId: ids.sA!,
        email: verified.email.toUpperCase(),
        firstName: 'v',
        lastName: 'T',
      },
    });
    const crmU = await owner.customer.create({
      data: { storeId: ids.sA!, email: unverified.email, firstName: 'u', lastName: 'T' },
    });
    await owner.$executeRawUnsafe(backfill);
    expect((await owner.customer.findUnique({ where: { id: crmV.id } }))?.userId).toBe(verified.id);
    expect((await owner.customer.findUnique({ where: { id: crmU.id } }))?.userId).toBeNull();
  });
});
