/**
 * STRICT-RLS proof for the `ebda_app` runtime role (R-EBDA-001, SP4 Stage 1a).
 *
 * Migration `20261004000000_ebda_strict_rls` forces RLS on every tenant table
 * with ONE policy per table for `ebda_app`: `store_id = nullif(current_setting(
 * 'app.current_store_id', true), '')`. There is no `IS NULL` allowance and no
 * `app.bypass_rls` path, so a query that has not set the store (transaction-
 * locally) sees nothing and cannot write.
 *
 * Every ASSERTION here runs on a REAL `ebda_app` login (never the superuser):
 * the superuser `DATABASE_URL`/`DIRECT_URL` is used only to
 *   - give `ebda_app` a LOGIN + password for the test (ops does this per
 *     environment; the migration creates the role NOLOGIN), and
 *   - build fixtures that must exist before the app role can be asked about them.
 * The app client is bound to the code under test with `runWithRequestDb`, so
 * `prisma`, `withStore`, `withUser`, `runInTenantContext` and the SECURITY
 * DEFINER wrappers in `apps/api/src/lib/definer.ts` all talk to it.
 *
 * COVERAGE IS AUTOMATIC. The table list comes from `information_schema` at test
 * time: every table with a `store_id` / `storeId` column must have RLS ENABLED
 * and FORCED, only `ebda_app` policies, no contextless allowance, a contextless
 * SELECT that returns 0 rows and a contextless INSERT that is rejected. A new
 * tenant table that ships without a policy turns this file red, and so does any
 * table that is neither under RLS nor in the documented exception list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TextFallbackClient } from '../../packages/database/src/client';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  withStore,
  withUser,
  acrossStores,
  withOwnerTx,
  withSystemJob,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';
import {
  resolveStoreId,
  getUserState,
  findUserIdByEmail,
  ensureAdminUser,
  insertAuditLog,
  auditLogExists,
  countAiUsage,
  getEntityStoreId,
  resolveStoreFromWebhookRef,
  findOrderByIdempotencyKey,
  getOrderStoreId,
  webhookInbox,
  platformAuditLogs,
  auditRetention,
  getSmsConsentById,
  revokeUserSessionsRow,
  deleteUserAddresses,
  detachStoreAuditLogs,
  unlinkUserAuditLogs,
  planSubscriberCounts,
  storeIdsOnPlan,
} from '../../apps/api/src/lib/definer';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw'; // same as the CI role step: roles are cluster-wide, so tests must not rotate it
const PREFIX = 'rlsea-';
const uid = () => crypto.randomUUID();

/** Tables that are DELIBERATELY not under RLS, with the reason (see the migration header). */
/**
 * The GLOBAL allowlist: tables DELIBERATELY not under RLS because they hold no tenant and no
 * user data. Since R-EBDA-005 (contract migration 20261008000100) `stores` and the user-keyed
 * token tables are under RLS too, so this list is platform config and bookkeeping only.
 */
const DOCUMENTED_NON_RLS: Record<string, string> = {
  answer_engine_provider_configs: 'platform-global provider credentials (no tenant, no user)',
  _prisma_migrations: 'migration bookkeeping; not granted to ebda_app',
  plans: 'platform-global plan catalog (config; no tenant data, no store_id)',
  billing_webhook_events: 'provider-event dedupe ledger (no store_id, no tenant data)',
  billing_referrals: 'referral link between two stores (no store_id column; platform billing data)',
  billing_grants: 'append-only free-month grant ledger (no store_id column; platform billing data)',
  ci_insights:
    'platform-wide CI findings over k-anonymous cohort cells; no store_id, no identifier (Ruling CI-9)',
};

let owner: AppPrismaClient;
/**
 * The ebda_app client for THIS file is deliberately built WITHOUT the code-level tenant
 * guard (R-EBDA-003). This file proves the DATABASE layer on its own: most cases issue a
 * query that is NOT scoped in code (a contextless count, another store's id) and assert RLS
 * answers zero rows or rejects the write. Through the factory's client the guard would refuse
 * those queries before Postgres saw them, so the RLS proof would prove nothing. The guard is
 * proven on its own (and with RLS behind it) in tests/integration/tenant-guard-ebda-app.test.ts.
 * Same adapter shape as the factory (`TextFallbackClient`), so catalog `name` columns decode.
 */
const makeApp = (): AppPrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: appUrl(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}

/** Run `fn` with `prisma` & friends bound to a real ebda_app connection. */
function asApp<T>(fn: () => Promise<T>): Promise<T> {
  return runWithRequestDb(makeApp, fn);
}

/** A raw transaction on an ebda_app connection, optionally scoped like the API scopes it. */
function appTx<T>(
  scope: { storeId?: string; userId?: string },
  fn: (tx: Parameters<Parameters<AppPrismaClient['$transaction']>[0]>[0]) => Promise<T>
): Promise<T> {
  return asApp(() =>
    prisma.$transaction(
      async tx => {
        if (scope.storeId)
          await tx.$queryRaw`SELECT set_config('app.current_store_id', ${scope.storeId}, true)`;
        if (scope.userId)
          await tx.$queryRaw`SELECT set_config('app.current_user_id', ${scope.userId}, true)`;
        return fn(tx);
      },
      { maxWait: 10000, timeout: 30000 }
    )
  );
}

interface Ids {
  storeA: string;
  storeB: string;
  ownerA: string;
  ownerB: string;
  customerA: string;
  customerB: string;
  staffA: string;
  superAdmin: string;
  productB: string;
  orderB: string;
  orderItemB: string;
  paymentB: string;
  faqA: string;
  faqB: string;
  addressA: string;
  addressB: string;
  idemKeyB: string;
  txnRefB: string;
  slugA: string;
  slugB: string;
  domainB: string;
}
const ids = {} as Ids;

async function cleanup(): Promise<void> {
  await withOwnerTx(async tx => {
    const stores = `(SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
    for (const t of [
      'payments',
      'order_items',
      'orders',
      'products',
      'store_faqs',
      'customers',
      'audit_logs',
      'webhook_events',
      'ai_usage',
      'store_staff',
      'merchant_api_keys',
      'sms_marketing_consents',
      'store_page_revisions',
    ]) {
      if (t === 'payments')
        await tx.$executeRawUnsafe(
          `DELETE FROM public.payments WHERE order_id IN (SELECT id FROM public.orders WHERE store_id IN ${stores})`
        );
      else if (t === 'order_items')
        await tx.$executeRawUnsafe(
          `DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE store_id IN ${stores})`
        );
      else if (t === 'webhook_events')
        await tx.$executeRawUnsafe(
          `DELETE FROM public.webhook_events WHERE idempotency_key LIKE '${PREFIX}%'`
        );
      else if (t === 'audit_logs')
        await tx.$executeRawUnsafe(
          `DELETE FROM public.audit_logs WHERE store_id IN ${stores} OR action LIKE '${PREFIX}%'`
        );
      else await tx.$executeRawUnsafe(`DELETE FROM public.${t} WHERE store_id IN ${stores}`);
    }
    await tx.$executeRawUnsafe(`DELETE FROM public.addresses WHERE address1 LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  });
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  // ops gives ebda_app its LOGIN + password per environment; the migration creates it NOLOGIN.
  await setAppRoleLogin(owner, APP_PASSWORD);
  await cleanup();

  const mkUser = (tag: string, role: string, storeId: string | null) =>
    owner.user.create({
      data: {
        email: `${PREFIX}${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.com`,
        passwordHash: 'hashed',
        firstName: tag,
        lastName: 'T',
        role: role as never,
        storeId,
      },
    });
  const ownerA = await mkUser('ownerA', 'store_admin', null);
  const ownerB = await mkUser('ownerB', 'store_admin', null);
  const staffA = await mkUser('staffA', 'staff', null);
  const superAdmin = await mkUser('super', 'super_admin', null);
  ids.slugA = `${PREFIX}a`;
  ids.slugB = `${PREFIX}b`;
  ids.domainB = `${PREFIX}b.example.test`;
  const storeA = await owner.store.create({
    data: { slug: ids.slugA, name: 'RLS A', ownerId: ownerA.id },
  });
  const storeB = await owner.store.create({
    data: {
      slug: ids.slugB,
      name: 'RLS B',
      ownerId: ownerB.id,
      domain: ids.domainB,
      domainStatus: 'active',
    },
  });
  const customerA = await mkUser('custA', 'customer', storeA.id);
  const customerB = await mkUser('custB', 'customer', storeB.id);
  Object.assign(ids, {
    storeA: storeA.id,
    storeB: storeB.id,
    ownerA: ownerA.id,
    ownerB: ownerB.id,
    staffA: staffA.id,
    superAdmin: superAdmin.id,
    customerA: customerA.id,
    customerB: customerB.id,
  });
  await owner.storeStaff.create({ data: { storeId: storeA.id, userId: staffA.id } });

  const prodA = await owner.product.create({
    data: { storeId: storeA.id, name: 'pa', slug: `${PREFIX}pa-${Date.now()}`, price: 1000 },
  });
  const prodB = await owner.product.create({
    data: { storeId: storeB.id, name: 'pb', slug: `${PREFIX}pb-${Date.now()}`, price: 1000 },
  });
  ids.productB = prodB.id;
  ids.idemKeyB = `${PREFIX}idem-${uid()}`;
  const order = await owner.order.create({
    data: {
      storeId: storeB.id,
      orderNumber: `${PREFIX}o-${Date.now()}`,
      subtotal: 10,
      total: 10,
      shippingAddress: {},
      billingAddress: {},
      idempotencyKey: ids.idemKeyB,
    },
  });
  ids.orderB = order.id;
  ids.txnRefB = `${PREFIX}txn-${uid()}`;
  const payment = await owner.payment.create({
    data: {
      orderId: order.id,
      amount: 10,
      currency: 'EGP',
      provider: 'cod',
      status: 'pending',
      transactionId: ids.txnRefB,
    },
  });
  ids.paymentB = payment.id;
  const item = await owner.orderItem.create({
    data: {
      orderId: order.id,
      productId: prodB.id,
      productName: 'item',
      quantity: 1,
      price: 10,
      total: 10,
    },
  });
  ids.orderItemB = item.id;
  await owner.order.create({
    data: {
      storeId: storeA.id,
      orderNumber: `${PREFIX}oa-${Date.now()}`,
      subtotal: 5,
      total: 5,
      shippingAddress: {},
      billingAddress: {},
    },
  });
  ids.faqA = (
    await owner.storeFaq.create({ data: { storeId: storeA.id, question: 'q', answer: 'a' } })
  ).id;
  ids.faqB = (
    await owner.storeFaq.create({ data: { storeId: storeB.id, question: 'q', answer: 'a' } })
  ).id;
  // Visual builder revisions (migration 20261007170000_store_page_revisions):
  // real rows in both stores so the isolation assertions are not vacuous.
  for (const storeId of [storeA.id, storeB.id])
    await owner.storePageRevision.create({
      data: {
        storeId,
        pageKey: 'home',
        rev: 1,
        status: 'published',
        schemaVersion: 1,
        document: {},
        docBytes: 2,
      },
    });
  await owner.customer.create({
    data: { storeId: storeA.id, email: `${PREFIX}crm-a@test.com`, firstName: 'c', lastName: 'a' },
  });
  await owner.customer.create({
    data: { storeId: storeB.id, email: `${PREFIX}crm-b@test.com`, firstName: 'c', lastName: 'b' },
  });
  ids.addressA = (
    await owner.address.create({
      data: {
        userId: customerA.id,
        firstName: 'A',
        lastName: 'U',
        address1: `${PREFIX}addr-a`,
        city: 'c',
        state: 's',
      },
    })
  ).id;
  ids.addressB = (
    await owner.address.create({
      data: {
        userId: customerB.id,
        firstName: 'B',
        lastName: 'U',
        address1: `${PREFIX}addr-b`,
        city: 'c',
        state: 's',
      },
    })
  ).id;
  void prodA;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

// ---------------------------------------------------------------------------
// The role itself
// ---------------------------------------------------------------------------
const PLATFORM_GLOBAL_TRUE = new Set([
  'system_settings',
  'provider_verifications',
  'provider_verification_events',
]);

describe('ebda_app: the runtime role', () => {
  it('is a plain login: no superuser, no BYPASSRLS, no createdb/createrole', async () => {
    const [r] = await asApp(
      () =>
        prisma.$queryRaw<
          Array<{ u: string; su: boolean; byp: boolean; cdb: boolean; crole: boolean }>
        >`SELECT current_user::text AS u, rolsuper AS su, rolbypassrls AS byp, rolcreatedb AS cdb, rolcreaterole AS crole FROM pg_roles WHERE rolname = current_user`
    );
    expect(r).toEqual({ u: 'ebda_app', su: false, byp: false, cdb: false, crole: false });
  });

  it('cannot escalate, alter the schema or read the migration table', async () => {
    // Escalate to the REAL superuser of this database: it is `postgres` on Neon but `test` in the
    // CI/local service container, and `SET ROLE <nonexistent>` fails with "does not exist", which
    // proves nothing about privilege.
    const [{ rolname: superuser }] = await owner.$queryRawUnsafe<Array<{ rolname: string }>>(
      'SELECT rolname FROM pg_roles WHERE rolsuper ORDER BY oid LIMIT 1'
    );
    const attempts: Array<[string, string]> = [
      ['SET ROLE', `SET ROLE "${superuser}"`],
      ['DROP', 'DROP TABLE public.products'],
      ['ALTER', 'ALTER TABLE public.products DISABLE ROW LEVEL SECURITY'],
      ['migrations', 'SELECT * FROM public._prisma_migrations'],
      ['CREATE POLICY', 'CREATE POLICY x ON public.products USING (true)'],
    ];
    for (const [label, sql] of attempts) {
      await expect(
        asApp(() => prisma.$executeRawUnsafe(sql)),
        label
      ).rejects.toThrow(/permission denied|must be owner|not permitted|cannot set role/i);
    }
  });

  it('the migration itself grants no TRUNCATE (the CI job adds it for the shared test reset only)', () => {
    // Not probed on the live role: CI grants TRUNCATE for tests/setup-e2e.ts, and a probe that
    // succeeds would truncate a table.
    const sql = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../packages/database/prisma/migrations/20261004000000_ebda_strict_rls/migration.sql'
      ),
      'utf8'
    );
    const code = sql
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(/GRANT[^;]*\bTRUNCATE\b/i);
    expect(code).not.toMatch(/GRANT\s+ALL\b/i);
  });

  it('withOwnerTx / withRlsBypass REFUSE to run on it (a leftover caller fails loudly, not with zero rows)', async () => {
    await expect(asApp(() => withOwnerTx(async tx => tx.product.count()))).rejects.toThrow(
      /strict-RLS app role/
    );
  });

  it('a bypass GUC set by the client changes nothing (the policies do not read it)', async () => {
    const n = await appTx({}, async tx => {
      await tx.$queryRaw`SELECT set_config('app.bypass_rls', 'true', true)`;
      return tx.product.count();
    });
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Automatic coverage of every table
// ---------------------------------------------------------------------------
async function tenantTables(): Promise<Array<{ table: string; column: string }>> {
  return owner.$queryRaw<Array<{ table: string; column: string }>>`
    SELECT c.table_name::text AS "table", c.column_name::text AS "column"
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.column_name IN ('store_id', 'storeId')
    ORDER BY 1`;
}

describe('every table with a store_id column is under STRICT, FORCED RLS (auto-enumerated)', () => {
  it('enumerates a non-trivial set (guards the enumeration itself)', async () => {
    expect((await tenantTables()).length).toBeGreaterThanOrEqual(80);
  });

  it('includes the tables added after the enumeration was written (visual builder revisions)', async () => {
    const tables = (await tenantTables()).map(t => t.table);
    expect(tables).toContain('store_page_revisions');
    // Product 3D models (2026-10-07) — both tables carry store_id, so the
    // forced/strict/contextless assertions below cover them automatically.
    expect(tables).toEqual(expect.arrayContaining(['product_models', 'product_model_bindings']));
    // Size charts (B0 Task 9, 2026-10-16) — same automatic coverage.
    expect(tables).toContain('size_charts');
    // Storefront search log (search program P0 Task 5, 2026-10-15) — same automatic coverage.
    expect(tables).toContain('search_query_daily');
    // Merchant QR scan counters (QR-1) — same automatic coverage.
    expect(tables).toContain('qr_scan_daily');
    // Merchant outgoing webhooks (2026-10-21) — same automatic coverage.
    expect(tables).toEqual(expect.arrayContaining(['webhook_endpoints', 'webhook_deliveries']));
    const [{ n }] = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.store_page_revisions`;
    expect(Number(n)).toBeGreaterThanOrEqual(2); // not vacuously empty for the 0-row assertion below
  });

  it('store_page_revisions: a store scope sees only its own revisions (control: it does see them)', async () => {
    const seen = await appTx(
      { storeId: ids.storeA },
      tx =>
        tx.$queryRaw<Array<{ store_id: string }>>`SELECT store_id FROM public.store_page_revisions`
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every(r => r.store_id === ids.storeA)).toBe(true);
  });

  it('RLS is ENABLED and FORCED, with only ebda_app policies', async () => {
    const tables = (await tenantTables()).map(t => t.table);
    const rows = await owner.$queryRaw<
      Array<{ relname: string; on: boolean; forced: boolean; npol: number; other_roles: number }>
    >`
      SELECT c.relname::text AS relname, c.relrowsecurity AS "on", c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS npol,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                AND NOT (p.roles = ARRAY['ebda_app']::name[])) AS other_roles
      FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND c.relname = ANY(${tables}::text[])`;
    const bad = rows.filter(r => !r.on || !r.forced || r.npol < 1 || r.other_roles > 0);
    expect(bad, JSON.stringify(bad)).toEqual([]);
    expect(rows.length).toBe(tables.length);
  });

  it('no policy has a contextless allowance, a bypass GUC, or the legacy current_store_id() idiom', async () => {
    const pols = await owner.$queryRaw<
      Array<{
        tablename: string;
        policyname: string;
        qual: string | null;
        with_check: string | null;
      }>
    >`SELECT tablename::text, policyname::text, qual, with_check FROM pg_policies WHERE schemaname = 'public'`;
    const offenders: string[] = [];
    for (const p of pols) {
      for (const [label, text] of [
        ['USING', p.qual],
        ['WITH CHECK', p.with_check],
      ] as const) {
        // Platform-global, documented: `system_settings`, and the PROVIDERS-3 evidence tables (Ruling
        // PROVIDERS-3, migration 20261103000200). They carry NO tenant data and are listed in
        // GLOBAL_MODELS; the ONLY accepted shape is the literal `true` policy, so any other predicate
        // that skips the GUC still fails.
        if (PLATFORM_GLOBAL_TRUE.has(p.tablename) && text?.trim() === 'true') continue;
        if (!text) {
          offenders.push(`${p.tablename}.${p.policyname} ${label} missing`);
          continue;
        }
        if (/\bIS NULL\b/i.test(text)) offenders.push(`${p.tablename} ${label}: IS NULL`);
        if (/bypass/i.test(text)) offenders.push(`${p.tablename} ${label}: bypass`);
        if (/current_store_id\(\)|current_user_id\(\)/.test(text))
          offenders.push(`${p.tablename} ${label}: legacy function`);
        if (!/app\.current_(store|user)_id/.test(text))
          offenders.push(`${p.tablename} ${label}: does not read the GUC`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every public table is under RLS or in the documented exception list', async () => {
    const rows = await owner.$queryRaw<Array<{ relname: string; forced: boolean }>>`
      SELECT c.relname::text AS relname, (c.relrowsecurity AND c.relforcerowsecurity) AS forced
      FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace`;
    const undocumented = rows
      .filter(r => !r.forced && !(r.relname in DOCUMENTED_NON_RLS))
      .map(r => r.relname);
    expect(undocumented, 'tables with neither RLS nor a documented reason').toEqual([]);
    // and the exception list does not rot: each documented table still exists
    const existing = new Set(rows.map(r => r.relname));
    expect(Object.keys(DOCUMENTED_NON_RLS).filter(t => !existing.has(t))).toEqual([]);
  });

  it('a contextless SELECT as ebda_app returns 0 rows on every one of them (fixtures prove the tables are not vacuously empty)', async () => {
    const tables = (await tenantTables()).map(t => t.table);
    const owned = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT (SELECT count(*) FROM products) + (SELECT count(*) FROM orders) + (SELECT count(*) FROM store_faqs) + (SELECT count(*) FROM customers) AS n`
    );
    expect(Number(owned[0].n)).toBeGreaterThan(0);
    const leaks: string[] = [];
    await appTx({}, async tx => {
      for (const t of tables) {
        const [{ n }] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM public."${t}"`
        );
        if (Number(n) !== 0) leaks.push(`${t}=${n}`);
      }
    });
    expect(leaks).toEqual([]);
  });

  it('a contextless INSERT is rejected on every one of them', async () => {
    const tables = (await tenantTables()).map(t => t.table);
    const accepted: string[] = [];
    for (const t of tables) {
      try {
        await appTx({}, tx => tx.$executeRawUnsafe(`INSERT INTO public."${t}" DEFAULT VALUES`));
        accepted.push(t);
      } catch (e) {
        if (!/row-level security/i.test(String(e)))
          accepted.push(`${t} (wrong error: ${String(e).slice(0, 80)})`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('a store-scoped INSERT naming ANOTHER store is rejected on every directly-keyed table', async () => {
    const tables = (await tenantTables()).filter(
      t => t.table !== 'users' && t.table !== 'store_staff'
    );
    const accepted: string[] = [];
    for (const { table, column } of tables) {
      try {
        await appTx({ storeId: ids.storeA }, tx =>
          tx.$executeRawUnsafe(
            `INSERT INTO public."${table}" ("${column}") VALUES ('${ids.storeB}')`
          )
        );
        accepted.push(table);
      } catch (e) {
        if (!/row-level security/i.test(String(e)))
          accepted.push(`${table} (wrong error: ${String(e).slice(0, 80)})`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('child tables without store_id are covered too: contextless SELECT 0 rows, contextless INSERT rejected', async () => {
    const children = [
      'order_items',
      'payments',
      'cart_items',
      'product_images',
      'product_variants',
      'return_items',
      'wishlist_items',
      'journal_lines',
      'bundle_items',
      'customer_addresses',
    ];
    const accepted: string[] = [];
    for (const t of children) {
      const [{ n }] = await appTx({}, tx =>
        tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM public."${t}"`)
      );
      if (Number(n) !== 0) accepted.push(`${t} select=${n}`);
      try {
        await appTx({}, tx => tx.$executeRawUnsafe(`INSERT INTO public."${t}" DEFAULT VALUES`));
        accepted.push(`${t} insert`);
      } catch (e) {
        if (!/row-level security/i.test(String(e))) accepted.push(`${t} (wrong error)`);
      }
    }
    expect(accepted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant behaviour on real rows
// ---------------------------------------------------------------------------
describe('cross-tenant reads and writes under a store scope', () => {
  it('store A cannot read store B rows (direct and child tables); store B can (control)', async () => {
    expect(
      await asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.product.findUnique({ where: { id: ids.productB } })
        )
      )
    ).toBeNull();
    expect(
      await asApp(() =>
        runInTenantContext(ids.storeB, () =>
          prisma.product.findUnique({ where: { id: ids.productB } })
        )
      )
    ).toMatchObject({ id: ids.productB });
    // child via order
    expect(
      await asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.payment.findUnique({ where: { id: ids.paymentB } })
        )
      )
    ).toBeNull();
    expect(
      await asApp(() =>
        runInTenantContext(ids.storeB, () =>
          prisma.payment.findUnique({ where: { id: ids.paymentB } })
        )
      )
    ).toMatchObject({ id: ids.paymentB });
    expect(
      await asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.orderItem.findMany({ where: { id: ids.orderItemB } })
        )
      )
    ).toEqual([]);
  });

  it('a store scope sees ONLY its own rows in a table both stores populate', async () => {
    const [a, b] = await asApp(async () =>
      Promise.all([
        runInTenantContext(ids.storeA, () => prisma.order.findMany({ select: { storeId: true } })),
        runInTenantContext(ids.storeB, () => prisma.order.findMany({ select: { storeId: true } })),
      ])
    );
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.every(r => r.storeId === ids.storeA)).toBe(true);
    expect(b.every(r => r.storeId === ids.storeB)).toBe(true);
  });

  it('a cross-tenant UPDATE and DELETE match zero rows; the row survives', async () => {
    const upd = await asApp(() =>
      runInTenantContext(ids.storeA, () =>
        prisma.storeFaq.updateMany({ where: { id: ids.faqB }, data: { question: 'hacked' } })
      )
    );
    const del = await asApp(() =>
      runInTenantContext(ids.storeA, () => prisma.storeFaq.deleteMany({ where: { id: ids.faqB } }))
    );
    expect(upd.count).toBe(0);
    expect(del.count).toBe(0);
    const row = await owner.storeFaq.findUnique({ where: { id: ids.faqB } });
    expect(row?.question).toBe('q');
  });

  it('a write naming another store is rejected, and the same write in the right store succeeds', async () => {
    await expect(
      asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.storeFaq.create({ data: { storeId: ids.storeB, question: 'x', answer: 'y' } })
        )
      )
    ).rejects.toThrow(/row-level security|Unique|violates/i);
    const ok = await asApp(() =>
      runInTenantContext(ids.storeA, () =>
        prisma.storeFaq.create({ data: { storeId: ids.storeA, question: 'ok', answer: 'ok' } })
      )
    );
    expect(ok.storeId).toBe(ids.storeA);
  });

  it('an UPDATE that tries to move a row to another store is rejected (WITH CHECK)', async () => {
    await expect(
      asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.storeFaq.update({ where: { id: ids.faqA }, data: { storeId: ids.storeB } })
        )
      )
    ).rejects.toThrow();
    expect((await owner.storeFaq.findUnique({ where: { id: ids.faqA } }))?.storeId).toBe(
      ids.storeA
    );
  });

  it('acrossStores visits every store in its own scope: each callback sees only that store', async () => {
    const seen = await asApp(() =>
      acrossStores(
        async storeId => ({
          storeId,
          foreign: await prisma.order.count({ where: { storeId: { not: storeId } } }),
          own: await prisma.order.count(),
        }),
        { storeIds: [ids.storeA, ids.storeB] }
      )
    );
    expect(seen.map(s => s.storeId).sort()).toEqual([ids.storeA, ids.storeB].sort());
    for (const s of seen) {
      expect(s.value.foreign).toBe(0);
      expect(s.value.own).toBeGreaterThan(0);
    }
  });

  it('withStore joins an ambient transaction for the same store and opens its own otherwise', async () => {
    const n = await asApp(() =>
      runInTenantContext(ids.storeB, async () => {
        const inside = await withStore(ids.storeB, tx => tx.order.count());
        const other = await withStore(ids.storeA, tx => tx.order.count());
        return { inside, other };
      })
    );
    expect(n.inside).toBeGreaterThan(0);
    expect(n.other).toBeGreaterThan(0);
  });
});

describe('users / addresses / store_staff: identity-keyed policies', () => {
  it('a user sees their OWN row without any store, nobody else', async () => {
    const self = await asApp(() =>
      withUser(ids.customerA, tx => tx.user.findMany({ select: { id: true } }))
    );
    expect(self.map(u => u.id)).toEqual([ids.customerA]);
  });

  it('a store scope sees its customers, its owner and its staff, and nobody from another store', async () => {
    const seen = await asApp(() =>
      runInTenantContext(ids.storeA, () => prisma.user.findMany({ select: { id: true } }))
    );
    const got = new Set(seen.map(u => u.id));
    expect(got.has(ids.customerA)).toBe(true);
    expect(got.has(ids.ownerA)).toBe(true);
    expect(got.has(ids.staffA)).toBe(true);
    expect(got.has(ids.customerB)).toBe(false);
    expect(got.has(ids.ownerB)).toBe(false);
    expect(got.has(ids.superAdmin)).toBe(false);
  });

  it('contextless: no users at all; an insert is rejected', async () => {
    expect(await asApp(() => prisma.user.count())).toBe(0);
    await expect(
      asApp(() =>
        prisma.user.create({
          data: {
            email: `${PREFIX}nope@test.com`,
            passwordHash: 'x',
            firstName: 'n',
            lastName: 'o',
          },
        })
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('an ACTIVE super_admin principal sees the whole directory; a store admin acting as themselves does not', async () => {
    const asSuper = await asApp(() => withUser(ids.superAdmin, tx => tx.user.count()));
    const asOwner = await asApp(() => withUser(ids.ownerA, tx => tx.user.count()));
    expect(asSuper).toBe(await owner.user.count());
    expect(asOwner).toBe(1);
  });

  it('a suspended super_admin loses the platform view', async () => {
    await owner.user.update({ where: { id: ids.superAdmin }, data: { status: 'suspended' } });
    try {
      expect(await asApp(() => withUser(ids.superAdmin, tx => tx.user.count()))).toBe(1);
    } finally {
      await owner.user.update({ where: { id: ids.superAdmin }, data: { status: 'active' } });
    }
  });

  it('addresses: own rows only, by user; none contextless; none for another user', async () => {
    expect(await asApp(() => prisma.address.count())).toBe(0);
    const mine = await asApp(() => withUser(ids.customerA, tx => tx.address.findMany()));
    expect(mine.map(a => a.id)).toEqual([ids.addressA]);
    const theirs = await asApp(() =>
      withUser(ids.customerA, tx => tx.address.findUnique({ where: { id: ids.addressB } }))
    );
    expect(theirs).toBeNull();
  });

  it('store_staff: a staff member lists their own memberships; another user cannot', async () => {
    const own = await asApp(() => withUser(ids.staffA, tx => tx.storeStaff.findMany()));
    expect(own.map(m => m.storeId)).toEqual([ids.storeA]);
    expect(await asApp(() => withUser(ids.customerB, tx => tx.storeStaff.count()))).toBe(0);
    expect(await asApp(() => prisma.storeStaff.count())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The SECURITY DEFINER functions
// ---------------------------------------------------------------------------
/**
 * Pure text helpers that index EXPRESSIONS or the embedder call (search normalisation, migration
 * 20261019000100; embed doc, 20261022000100). They read no table, so they are deliberately NOT definers: they run with the
 * caller's rights, and a SET search_path clause would stop the planner inlining them. Being on
 * this list is not an exemption from checks: each must be non-definer, IMMUTABLE, LANGUAGE sql,
 * and ebda_app must be able to execute it, and it must carry NO `SET search_path` in proconfig
 * (that would stop inlining, so the index could no longer match the query). EXECUTE deliberately
 * stays granted to PUBLIC (Ruling SEARCH-15): they read no table and return only a fold of their
 * argument, so there is nothing to withhold. Any other ebda_* function must pass the definer
 * hygiene below.
 */
const PURE_IMMUTABLE_EBDA_FNS = new Set([
  'ebda_ar_norm',
  'ebda_digits', // search P2 Task 15 (migration 20261027000100): digit-only phone fold
  'ebda_product_search_doc',
  'ebda_product_name_doc',
  'ebda_product_embed_doc', // search P1 Task 9 (migration 20261022000100): the embedding input
]);

describe('SECURITY DEFINER functions: hygiene', () => {
  it('the pure immutable ebda_* helpers are invoker-rights, IMMUTABLE, sql, executable by ebda_app', async () => {
    const fns = await owner.$queryRaw<
      Array<{
        proname: string;
        secdef: boolean;
        vol: string;
        lang: string;
        app_exec: boolean;
        cfg: string[] | null;
      }>
    >`
      SELECT p.proname::text AS proname, p.prosecdef AS secdef, p.provolatile::text AS vol,
             l.lanname::text AS lang, has_function_privilege('ebda_app', p.oid, 'EXECUTE') AS app_exec,
             p.proconfig AS cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public' AND p.proname = ANY(${[...PURE_IMMUTABLE_EBDA_FNS]})`;
    // Every name exists; overloads are each checked below (the 5-argument ebda_product_embed_doc
    // was dropped by the SEARCH-T13-8 contract migration 20261029000300).
    expect([...new Set(fns.map(f => f.proname))].sort()).toEqual(
      [...PURE_IMMUTABLE_EBDA_FNS].sort()
    );
    expect(fns.filter(f => f.proname === 'ebda_product_embed_doc')).toHaveLength(1);
    for (const f of fns) {
      expect({
        fn: f.proname,
        secdef: f.secdef,
        vol: f.vol,
        lang: f.lang,
        exec: f.app_exec,
        searchPath: (f.cfg ?? []).filter(c => c.startsWith('search_path=')),
      }).toEqual({
        fn: f.proname,
        secdef: false,
        vol: 'i',
        lang: 'sql',
        exec: true,
        searchPath: [],
      });
    }
  });

  it('every ebda_* function is SECURITY DEFINER with a pinned search_path, owner-run, EXECUTE for ebda_app only', async () => {
    const fns = await owner.$queryRaw<
      Array<{
        proname: string;
        secdef: boolean;
        cfg: string[] | null;
        acl: string | null;
        app_exec: boolean;
      }>
    >`
      SELECT p.proname::text AS proname, p.prosecdef AS secdef, p.proconfig AS cfg, p.proacl::text AS acl,
             has_function_privilege('ebda_app', p.oid, 'EXECUTE') AS app_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'ebda\\_%'`;
    expect(fns.length).toBeGreaterThanOrEqual(25);
    const bad: string[] = [];
    for (const f of fns) {
      if (PURE_IMMUTABLE_EBDA_FNS.has(f.proname)) continue; // checked by the test above
      if (!f.secdef) bad.push(`${f.proname}: not SECURITY DEFINER`);
      if (!(f.cfg ?? []).some(c => /^search_path=pg_catalog, public, pg_temp$/.test(c)))
        bad.push(`${f.proname}: search_path not pinned (${(f.cfg ?? []).join(',')})`);
      if (!f.app_exec) bad.push(`${f.proname}: ebda_app cannot execute it`);
      if (/(^|,)=X\//.test(f.acl ?? '')) bad.push(`${f.proname}: EXECUTE granted to PUBLIC`);
    }
    expect(bad).toEqual([]);
  });
});

describe('SECURITY DEFINER functions: they return only what they should', () => {
  it('ebda_resolve_store_id: exact slug or domain on an ACTIVE store; nothing otherwise; slug wins', async () => {
    expect(await asApp(() => resolveStoreId({ slug: ids.slugA }))).toBe(ids.storeA);
    expect(await asApp(() => resolveStoreId({ domain: ids.domainB }))).toBe(ids.storeB);
    expect(await asApp(() => resolveStoreId({ slug: ids.slugA, domain: ids.domainB }))).toBe(
      ids.storeA
    );
    expect(await asApp(() => resolveStoreId({ slug: 'no-such-store' }))).toBeNull();
    expect(await asApp(() => resolveStoreId({ slug: ids.slugA.toUpperCase() }))).toBeNull();
    expect(await asApp(() => resolveStoreId({}))).toBeNull();
    // a domain that is not VERIFIED (domain_status != 'active') is never a storefront
    await owner.store.update({ where: { id: ids.storeB }, data: { domainStatus: 'pending' } });
    try {
      expect(await asApp(() => resolveStoreId({ domain: ids.domainB }))).toBeNull();
    } finally {
      await owner.store.update({ where: { id: ids.storeB }, data: { domainStatus: 'active' } });
    }
    await owner.store.update({ where: { id: ids.storeB }, data: { status: 'suspended' } });
    try {
      expect(await asApp(() => resolveStoreId({ domain: ids.domainB }))).toBeNull();
    } finally {
      await owner.store.update({ where: { id: ids.storeB }, data: { status: 'active' } });
    }
  });

  it('ebda_user_state / ebda_auth_find_user_id: exact id / exact email within ONE namespace, id only', async () => {
    const st = await asApp(() => getUserState(ids.customerA));
    expect(st).toMatchObject({
      id: ids.customerA,
      role: 'customer',
      status: 'active',
      storeId: ids.storeA,
    });
    expect(await asApp(() => getUserState(uid()))).toBeNull();
    const email = (await owner.user.findUniqueOrThrow({ where: { id: ids.customerA } })).email;
    expect(await asApp(() => findUserIdByEmail(email, ids.storeA))).toBe(ids.customerA);
    expect(await asApp(() => findUserIdByEmail(email, ids.storeB))).toBeNull();
    expect(await asApp(() => findUserIdByEmail(email, null))).toBeNull();
    const adminEmail = (await owner.user.findUniqueOrThrow({ where: { id: ids.ownerA } })).email;
    expect(await asApp(() => findUserIdByEmail(adminEmail, null))).toBe(ids.ownerA);
    expect(await asApp(() => findUserIdByEmail(adminEmail, ids.storeA))).toBeNull();
  });

  it('ebda_admin_user_ensure: finds-or-creates store_admin/staff in the admin namespace, refuses other roles', async () => {
    const email = `${PREFIX}ensure-${uid()}@test.com`;
    const created = await asApp(() =>
      ensureAdminUser({ email, passwordHash: 'h', firstName: 'E', lastName: 'N', role: 'staff' })
    );
    expect(created).toMatchObject({ created: true, role: 'staff', email });
    const again = await asApp(() =>
      ensureAdminUser({
        email,
        passwordHash: 'other',
        firstName: 'X',
        lastName: 'Y',
        role: 'store_admin',
      })
    );
    // an existing account is returned untouched, and its stored name is NOT disclosed: the
    // wrapper echoes what the caller supplied, and the SQL function has no PII columns at all
    expect(again).toMatchObject({ created: false, id: created.id, role: 'staff', firstName: 'X' });
    const rawCols = await asApp(
      () =>
        prisma.$queryRaw<
          Array<Record<string, unknown>>
        >`SELECT * FROM public.ebda_admin_user_ensure(${email}, 'h', 'Other', 'Name', 'staff', false)`
    );
    expect(Object.keys(rawCols[0]).sort()).toEqual(['created', 'role', 'status', 'user_id']);
    await expect(
      asApp(
        () =>
          prisma.$queryRaw`SELECT * FROM public.ebda_admin_user_ensure(${`${PREFIX}x@test.com`}, 'h', 'a', 'b', 'super_admin', false)`
      )
    ).rejects.toThrow(/not allowed/);
    await expect(
      asApp(
        () =>
          prisma.$queryRaw`SELECT * FROM public.ebda_admin_user_ensure(${`${PREFIX}y@test.com`}, 'h', 'a', 'b', 'customer', false)`
      )
    ).rejects.toThrow(/not allowed/);
    const row = await owner.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.storeId).toBeNull();
  });

  it('webhook routing: provider reference -> store, idempotency key -> order, order -> store', async () => {
    expect(await asApp(() => resolveStoreFromWebhookRef({ transactionId: ids.txnRefB }))).toBe(
      ids.storeB
    );
    expect(
      await asApp(() => resolveStoreFromWebhookRef({ transactionId: 'nope', invoiceId: 'nope' }))
    ).toBeNull();
    expect(await asApp(() => resolveStoreFromWebhookRef({}))).toBeNull();
    expect(await asApp(() => findOrderByIdempotencyKey(ids.idemKeyB))).toMatchObject({
      orderId: ids.orderB,
      storeId: ids.storeB,
      webhookProcessedAt: null,
    });
    expect(await asApp(() => findOrderByIdempotencyKey('nope'))).toBeNull();
    expect(await asApp(() => getOrderStoreId(ids.orderB))).toBe(ids.storeB);
    expect(await asApp(() => getEntityStoreId('product', ids.productB))).toBe(ids.storeB);
    expect(await asApp(() => getEntityStoreId('order', uid()))).toBeNull();
  });

  it('the webhook inbox: record is idempotent, a processed row is never overwritten, update touches only its columns', async () => {
    const key = `${PREFIX}wh-${uid()}`;
    const id1 = await asApp(() =>
      webhookInbox.record({
        provider: 'kashier',
        idempotencyKey: key,
        storeId: null,
        payload: { n: 1 },
        rawBody: 'raw1',
        signature: 's1',
      })
    );
    const id2 = await asApp(() =>
      webhookInbox.record({
        provider: 'kashier',
        idempotencyKey: key,
        storeId: ids.storeB,
        payload: { n: 2 },
        rawBody: 'raw2',
        signature: 's2',
      })
    );
    expect(id2).toBe(id1);
    let row = await asApp(() => webhookInbox.get(id1));
    expect(row).toMatchObject({
      payload: { n: 2 },
      rawBody: 'raw2',
      storeId: ids.storeB,
      status: 'received',
    });
    await asApp(() => webhookInbox.update(id1, { status: 'processing', incrementAttempts: true }));
    await asApp(() =>
      webhookInbox.update(id1, {
        status: 'processed',
        markProcessed: { resultOrderId: ids.orderB, resultStatus: 'paid' },
      })
    );
    const id3 = await asApp(() =>
      webhookInbox.record({
        provider: 'kashier',
        idempotencyKey: key,
        storeId: null,
        payload: { n: 3 },
        rawBody: 'raw3',
        signature: 's3',
      })
    );
    expect(id3).toBe(id1);
    row = await asApp(() => webhookInbox.get(id1));
    expect(row).toMatchObject({
      payload: { n: 2 },
      rawBody: 'raw2',
      status: 'processed',
      attempts: 1,
      resultStatus: 'paid',
    });
    // a contextless direct read of the table sees nothing — only the definers do
    expect(await asApp(() => prisma.webhookEvent.count())).toBe(0);
    // stuck sweep: an old 'received' row is found, with the null store intact
    const key2 = `${PREFIX}wh-${uid()}`;
    const id4 = await asApp(() =>
      webhookInbox.record({
        provider: 'kashier',
        idempotencyKey: key2,
        storeId: null,
        payload: {},
        rawBody: 'r',
        signature: 's',
      })
    );
    await owner.$executeRawUnsafe(
      // received_at is `timestamp without time zone` holding UTC (Prisma writes UTC); a bare
      // now() is the SESSION time zone, so on a non-UTC Postgres the row looked 1h in the future.
      `UPDATE webhook_events SET received_at = (now() AT TIME ZONE 'UTC') - interval '2 hours' WHERE id = '${id4}'`
    );
    const stuck = await asApp(() => webhookInbox.stuck(new Date(Date.now() - 3600_000), 50));
    expect(stuck.some(r => r.id === id4 && r.storeId === null)).toBe(true);
    expect(stuck.some(r => r.id === id1)).toBe(false);
  });

  it('audit trail: append-only insert from any scope, existence probe, detach on store delete; the viewer needs a super_admin', async () => {
    const action = `${PREFIX}act-${uid()}`;
    // a platform event with NO store, written from a contextless connection
    await asApp(() =>
      insertAuditLog({ action, userId: ids.ownerA, resourceType: 'x', resourceId: 'r1' })
    );
    // and one naming a store other than the scope it is written from
    await asApp(() =>
      runInTenantContext(ids.storeA, () =>
        insertAuditLog({ action, storeId: ids.storeB, resourceType: 'x', resourceId: 'r2' })
      )
    );
    expect(await asApp(() => auditLogExists(action, 'x', 'r1'))).toBe(true);
    expect(await asApp(() => auditLogExists(action, 'x', 'nope'))).toBe(false);
    // ebda_app cannot UPDATE/DELETE audit rows it has no scope for; the store-scoped read sees only its own
    const visibleToB = await asApp(() =>
      runInTenantContext(ids.storeB, () => prisma.auditLog.findMany({ where: { action } }))
    );
    expect(visibleToB.map(r => r.resourceId)).toEqual(['r2']);
    const del = await asApp(() =>
      runInTenantContext(ids.storeA, () => prisma.auditLog.deleteMany({ where: { action } }))
    );
    expect(del.count).toBe(0);
    // the platform viewer: refuses a non-super actor, serves the super_admin, store-less rows included
    await expect(
      asApp(() => platformAuditLogs.list({ actorUserId: ids.ownerA, limit: 10, offset: 0 }))
    ).rejects.toThrow(/not an active super_admin/);
    const page = await asApp(() =>
      platformAuditLogs.list({ actorUserId: ids.superAdmin, action, limit: 10, offset: 0 })
    );
    expect(page.total).toBe(2);
    expect(page.rows.map(r => r.resourceId).sort()).toEqual(['r1', 'r2']);
    expect(page.rows.find(r => r.resourceId === 'r1')?.storeId).toBeNull();
    expect(page.rows.find(r => r.resourceId === 'r1')?.user?.id).toBe(ids.ownerA);
    // detach (store delete path): nulls store_id, scoped to one store
    expect(
      await asApp(() => runInTenantContext(ids.storeB, () => detachStoreAuditLogs(ids.storeB)))
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await owner.auditLog.findMany({ where: { action, resourceId: 'r2' } }))[0].storeId
    ).toBeNull();
  });

  it('audit retention refuses a cutoff newer than 30 days (a stolen role cannot purge recent history)', async () => {
    await expect(asApp(() => auditRetention.purge(new Date(), 10))).rejects.toThrow(
      /at least 30 days old/
    );
    await expect(
      asApp(() => auditRetention.count(new Date(Date.now() - 86_400_000)))
    ).rejects.toThrow(/at least 30 days old/);
    expect(
      await asApp(() => auditRetention.count(new Date(Date.now() - 400 * 86_400_000)))
    ).toBeGreaterThanOrEqual(0);
  });

  it('platform AI-usage count is a single aggregate across stores', async () => {
    const since = new Date(Date.now() - 3600_000);
    const before = await asApp(() =>
      countAiUsage({ since, cachedHit: false, feature: `${PREFIX}feat` })
    );
    for (const storeId of [ids.storeA, ids.storeB]) {
      await owner.aiUsage.create({
        data: {
          storeId,
          feature: `${PREFIX}feat`,
          model: 'm',
          inputTokens: 1,
          outputTokens: 1,
          cachedHit: false,
        },
      });
    }
    expect(
      await asApp(() => countAiUsage({ since, cachedHit: false, feature: `${PREFIX}feat` }))
    ).toBe(before + 2);
    expect(
      await asApp(() => countAiUsage({ since, cachedHit: true, feature: `${PREFIX}feat` }))
    ).toBe(0);
    // while a direct read sees none (contextless) or only its own store's row
    expect(await asApp(() => prisma.aiUsage.count())).toBe(0);
    expect(
      await asApp(() =>
        runInTenantContext(ids.storeA, () =>
          prisma.aiUsage.count({ where: { feature: `${PREFIX}feat` } })
        )
      )
    ).toBe(1);
  });

  it('SMS opt-out lookup returns the one consent row and its store name, nothing else', async () => {
    const consent = await owner.smsMarketingConsent.create({
      data: {
        storeId: ids.storeB,
        customerKey: `${PREFIX}ck`,
        phone: '+96500000000',
        phoneKey: `${PREFIX}pk`,
        granted: true,
      },
    });
    expect(await asApp(() => getSmsConsentById(consent.id))).toMatchObject({
      id: consent.id,
      storeId: ids.storeB,
      granted: true,
      store: { name: 'RLS B' },
    });
    expect(await asApp(() => getSmsConsentById(uid()))).toBeNull();
  });

  it('"sign out everywhere" runs inside the caller transaction: it bumps tokenVersion and revokes keys in EVERY store, and rolls back with the transaction', async () => {
    const keyHash = `${PREFIX}${uid()}`;
    await owner.merchantApiKey.create({
      data: {
        storeId: ids.storeB,
        userId: ids.ownerB,
        name: 'k',
        keyHash,
        prefix: 'pfx',
        scopes: ['merchant:read'],
      },
    });
    const tv0 = (await owner.user.findUniqueOrThrow({ where: { id: ids.ownerB } })).tokenVersion;
    // rolled back with the caller's transaction
    await expect(
      asApp(() =>
        prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT set_config('app.current_user_id', ${ids.ownerB}, true)`;
          const rows = await tx.$queryRaw<
            Array<{ tv: number }>
          >`SELECT public.ebda_user_revoke_sessions(${ids.ownerB}) AS tv`;
          expect(rows[0].tv).toBe(tv0 + 1);
          throw new Error('abort');
        })
      )
    ).rejects.toThrow('abort');
    expect((await owner.user.findUniqueOrThrow({ where: { id: ids.ownerB } })).tokenVersion).toBe(
      tv0
    );
    expect(
      (await owner.merchantApiKey.findUniqueOrThrow({ where: { keyHash } })).revokedAt
    ).toBeNull();
    // committed
    const r = await asApp(() => withUser(ids.ownerB, () => revokeUserSessionsRow(ids.ownerB)));
    expect(r.tokenVersion).toBe(tv0 + 1);
    expect(
      (await owner.merchantApiKey.findUniqueOrThrow({ where: { keyHash } })).revokedAt
    ).not.toBeNull();
    // an id that does not exist: only a super_admin gets past the guard to learn that
    await expect(
      asApp(() => runInTenantContext(undefined, () => revokeUserSessionsRow(uid()), ids.superAdmin))
    ).rejects.toThrow(/not found/);
  });

  it('address erasure deletes by the shopper id from a MERCHANT scope (the policy alone would match zero rows)', async () => {
    const merchantScope = await asApp(() =>
      runInTenantContext(
        ids.storeB,
        async () => ({
          viaPolicy: (await prisma.address.deleteMany({ where: { userId: ids.customerB } })).count,
          viaDefiner: await deleteUserAddresses(ids.customerB),
        }),
        ids.ownerB
      )
    );
    expect(merchantScope).toEqual({ viaPolicy: 0, viaDefiner: 1 });
    expect(await owner.address.count({ where: { id: ids.addressB } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Caller guards on the mutating / cross-store definers (SQLSTATE 42501)
// ---------------------------------------------------------------------------
type Scope = { storeId?: string; userId?: string };

/** The failure carries SQLSTATE 42501 (insufficient_privilege) from a RAISE in the function. */
async function expectDenied(p: Promise<unknown>, label: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `${label}: expected a 42501 denial`).toBeDefined();
  const text = `${(err as Error).message} ${JSON.stringify((err as { meta?: unknown }).meta ?? {})} ${String((err as { cause?: unknown }).cause ?? '')}`;
  expect(text, label).toMatch(/42501|caller|insufficient/i);
}

const callDetach = (scope: Scope, storeId: string) =>
  appTx(
    scope,
    tx =>
      tx.$queryRaw<
        Array<{ n: number }>
      >`SELECT public.ebda_audit_logs_detach_store(${storeId}) AS n`
  );
const callUnlink = (scope: Scope, userId: string) =>
  appTx(
    scope,
    tx =>
      tx.$queryRaw<Array<{ n: number }>>`SELECT public.ebda_audit_logs_unlink_user(${userId}) AS n`
  );
const callRevoke = (scope: Scope, userId: string) =>
  appTx(
    scope,
    tx =>
      tx.$queryRaw<
        Array<{ n: number | null }>
      >`SELECT public.ebda_user_revoke_sessions(${userId}) AS n`
  );
const callAddrDelete = (scope: Scope, userId: string) =>
  appTx(
    scope,
    tx =>
      tx.$queryRaw<Array<{ n: number }>>`SELECT public.ebda_user_addresses_delete(${userId}) AS n`
  );

describe('definer guards: the mutating functions check WHO is calling', () => {
  // The target user and the scope that is allowed to act on it, per function. `storeB`'s customer is
  // the cross-tenant victim; every denial below is a caller that holds some OTHER legitimate scope.
  const guarded: Array<[string, (scope: Scope, userId: string) => Promise<unknown>]> = [
    ['ebda_audit_logs_unlink_user', callUnlink],
    ['ebda_user_revoke_sessions', callRevoke],
    ['ebda_user_addresses_delete', callAddrDelete],
  ];

  for (const [name, call] of guarded) {
    it(`${name}: denied with no scope, a foreign store, a foreign user or a non-super_admin; allowed for self / own store / super_admin`, async () => {
      // no scope at all
      await expectDenied(call({}, ids.customerB), `${name} contextless`);
      // a store scope for ANOTHER store (a merchant reaching into someone else's customer)
      await expectDenied(call({ storeId: ids.storeA }, ids.customerB), `${name} foreign store`);
      // a user scope for ANOTHER user (a customer acting on another customer)
      await expectDenied(call({ userId: ids.customerA }, ids.customerB), `${name} foreign user`);
      // a merchant of store A acting on store B's owner (admin namespace, no store_id)
      await expectDenied(
        call({ storeId: ids.storeA, userId: ids.ownerA }, ids.ownerB),
        `${name} foreign owner`
      );
      // a staff member / owner of store A is NOT a platform operator
      await expectDenied(call({ userId: ids.ownerA }, ids.customerB), `${name} owner as operator`);
      // the target does not even exist: denied (not "not found") unless the caller is a super_admin
      await expectDenied(call({ storeId: ids.storeA }, uid()), `${name} unknown id`);

      // allowed: the user themself ...
      await call({ userId: ids.customerB }, ids.customerB);
      // ... a merchant on its OWN customer ...
      await call({ storeId: ids.storeB }, ids.customerB);
      // ... the store's staff member and its owner (admin namespace, linked to the store) ...
      await call({ storeId: ids.storeA }, ids.staffA);
      await call({ storeId: ids.storeA }, ids.ownerA);
      // ... and an active super_admin on anybody
      await call({ userId: ids.superAdmin }, ids.customerB);
    });
  }

  it('ebda_audit_logs_detach_store: only the store the transaction is scoped to, or a super_admin', async () => {
    const action = `${PREFIX}det-${uid()}`;
    await owner.auditLog.create({
      data: { action, storeId: ids.storeA, resourceType: 'x', resourceId: 'a1' },
    });
    await expectDenied(callDetach({}, ids.storeA), 'detach contextless');
    await expectDenied(callDetach({ storeId: ids.storeB }, ids.storeA), 'detach foreign store');
    await expectDenied(callDetach({ userId: ids.ownerA }, ids.storeA), 'detach as an owner only');
    // untouched by the denials
    expect((await owner.auditLog.findMany({ where: { action } }))[0].storeId).toBe(ids.storeA);
    const [{ n }] = await callDetach({ storeId: ids.storeA }, ids.storeA);
    expect(Number(n)).toBeGreaterThanOrEqual(1);
    expect((await owner.auditLog.findMany({ where: { action } }))[0].storeId).toBeNull();
    // a super_admin may detach any store
    await owner.auditLog.create({
      data: { action, storeId: ids.storeB, resourceType: 'x', resourceId: 'b1' },
    });
    await callDetach({ userId: ids.superAdmin }, ids.storeB);
    expect(
      (await owner.auditLog.findMany({ where: { action, resourceId: 'b1' } }))[0].storeId
    ).toBeNull();
  });

  it("a denied call changes nothing (sessions of another store's customer stay valid)", async () => {
    const tv0 = (await owner.user.findUniqueOrThrow({ where: { id: ids.customerA } })).tokenVersion;
    await expectDenied(callRevoke({ storeId: ids.storeB }, ids.customerA), 'revoke foreign');
    expect(
      (await owner.user.findUniqueOrThrow({ where: { id: ids.customerA } })).tokenVersion
    ).toBe(tv0);
    const action = `${PREFIX}unl-${uid()}`;
    await owner.auditLog.create({
      data: { action, userId: ids.customerA, resourceType: 'x', resourceId: 'u1' },
    });
    await expectDenied(callUnlink({ storeId: ids.storeB }, ids.customerA), 'unlink foreign');
    expect((await owner.auditLog.findMany({ where: { action } }))[0].userId).toBe(ids.customerA);
    await callUnlink({ storeId: ids.storeA }, ids.customerA);
    expect((await owner.auditLog.findMany({ where: { action } }))[0].userId).toBeNull();
  });

  it('audit retention: only a super_admin or the audit-log-retention job (cron), never a plain caller', async () => {
    const cutoff = new Date(Date.now() - 400 * 86_400_000);
    type Db = Pick<AppPrismaClient, '$queryRaw'>;
    const queries: Array<[string, (db: Db) => Promise<unknown>]> = [
      [
        'count',
        db => db.$queryRaw`SELECT public.ebda_audit_log_retention_count(${cutoff}::timestamp)`,
      ],
      [
        'page',
        db =>
          db.$queryRaw`SELECT * FROM public.ebda_audit_log_retention_page(${cutoff}::timestamp, NULL, 5)`,
      ],
      [
        'purge',
        db => db.$queryRaw`SELECT public.ebda_audit_log_retention_purge(${cutoff}::timestamp, 5)`,
      ],
    ];
    for (const [label, q] of queries) {
      await expectDenied(
        appTx({}, tx => q(tx)),
        `retention ${label} contextless`
      );
      await expectDenied(
        appTx({ storeId: ids.storeA, userId: ids.ownerA }, tx => q(tx)),
        `retention ${label} owner`
      );
      // another job's name does not open it
      await expectDenied(
        asApp(() => withSystemJob('webhook-inbox', () => q(prisma))),
        `retention ${label} wrong job`
      );
      await appTx({ userId: ids.superAdmin }, tx => q(tx));
      await asApp(() => withSystemJob('audit-log-retention', () => q(prisma)));
    }
    // the cron path (wrapper = the job) still works end to end
    expect(await asApp(() => auditRetention.count(cutoff))).toBeGreaterThanOrEqual(0);
  });

  it('webhook inbox get / update / stuck: only a super_admin or the webhook-inbox job; record stays public ingress', async () => {
    const key = `${PREFIX}wh-guard-${uid()}`;
    const id = await asApp(() =>
      webhookInbox.record({
        provider: 'kashier',
        idempotencyKey: key,
        storeId: ids.storeB,
        payload: { secret: 'pan' },
        rawBody: 'raw',
        signature: 'sig',
      })
    );
    type Db = Pick<AppPrismaClient, '$queryRaw'>;
    const get = (tx: Db) => tx.$queryRaw`SELECT * FROM public.ebda_webhook_inbox_get(${id})`;
    const upd = (tx: Db) => tx.$queryRaw`SELECT public.ebda_webhook_inbox_update(${id}, 'failed')`;
    const stuck = (tx: Db) =>
      tx.$queryRaw`SELECT * FROM public.ebda_webhook_inbox_stuck(now()::timestamp, 5)`;
    for (const [label, q] of [
      ['get', get],
      ['update', upd],
      ['stuck', stuck],
    ] as const) {
      await expectDenied(appTx({}, q), `inbox ${label} contextless`);
      // even the store the row belongs to may not read its raw payload through the definer
      await expectDenied(appTx({ storeId: ids.storeB }, q), `inbox ${label} own store`);
    }
    expect((await owner.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe('received');
    await appTx({ userId: ids.superAdmin }, get);
    expect(await asApp(() => webhookInbox.get(id))).toMatchObject({ id, rawBody: 'raw' });
    expect(await asApp(() => webhookInbox.update(id, { status: 'failed' }))).toBe(true);
  });

  it('the plans-engine cross-store reads are super_admin only', async () => {
    await expectDenied(
      asApp(() => planSubscriberCounts()),
      'counts contextless'
    );
    await expectDenied(
      asApp(() => storeIdsOnPlan('free')),
      'ids contextless'
    );
    await expectDenied(
      asApp(() => runInTenantContext(ids.storeA, () => planSubscriberCounts(), ids.ownerA)),
      'counts as an owner'
    );
    const counts = await asApp(() =>
      runInTenantContext(undefined, () => planSubscriberCounts(), ids.superAdmin)
    );
    expect(counts instanceof Map).toBe(true);
    const free = await asApp(() =>
      runInTenantContext(undefined, () => storeIdsOnPlan('free'), ids.superAdmin)
    );
    expect(Array.isArray(free)).toBe(true);
  });

  it('withSystemJob is transaction-local: it neither leaks to the next transaction nor survives an ambient scope', async () => {
    const read = () =>
      prisma.$queryRaw<
        Array<{ j: string | null }>
      >`SELECT nullif(current_setting('app.system_job', true), '') AS j`;
    const inside = await asApp(() => withSystemJob('webhook-inbox', read));
    expect(inside[0].j).toBe('webhook-inbox');
    const after = await asApp(() => read());
    expect(after[0].j).toBeNull();
    // inside an ambient scope the job is set for the call only
    const both = await asApp(() =>
      runInTenantContext(ids.storeA, async () => {
        const during = await withSystemJob('audit-log-retention', read);
        const post = await read();
        return [during[0].j, post[0].j];
      })
    );
    expect(both).toEqual(['audit-log-retention', null]);
  });
});

describe('subscription billing under strict RLS', () => {
  it('billing_events: store-scoped, the append-only trigger still holds, webhook routing goes through definers', async () => {
    const key = `${PREFIX}bill-${uid()}`;
    const mk = (storeId: string, k: string) =>
      appTx({ storeId }, tx =>
        tx.billingEvent.create({
          data: {
            storeId,
            type: 'checkout',
            amountMinor: 100,
            provider: 'stub',
            idempotencyKey: k,
            status: 'succeeded',
          },
        })
      );
    const ev = await mk(ids.storeA, key);
    // contextless / other store: invisible and unwritable
    expect(await appTx({}, tx => tx.billingEvent.count({ where: { id: ev.id } }))).toBe(0);
    expect(
      await appTx({ storeId: ids.storeB }, tx => tx.billingEvent.count({ where: { id: ev.id } }))
    ).toBe(0);
    await expect(
      appTx({ storeId: ids.storeA }, tx =>
        tx.billingEvent.create({
          data: {
            storeId: ids.storeB,
            type: 'checkout',
            amountMinor: 1,
            provider: 'stub',
            idempotencyKey: `${key}-y`,
          },
        })
      )
    ).rejects.toThrow();
    // the trigger: a settled charge cannot become failed, and a direct delete is refused
    await expect(
      appTx({ storeId: ids.storeA }, tx =>
        tx.billingEvent.update({ where: { id: ev.id }, data: { status: 'failed' } })
      )
    ).rejects.toThrow(/succeeded charge cannot become/);
    await expect(
      appTx({ storeId: ids.storeA }, tx => tx.billingEvent.delete({ where: { id: ev.id } }))
    ).rejects.toThrow(/append-only/);
    // definers: id -> store, for ledger rows and subscriptions
    expect(await asApp(() => getEntityStoreId('billing_event', ev.id))).toBe(ids.storeA);
    expect(await asApp(() => getEntityStoreId('billing_event', uid()))).toBeNull();
    await owner
      .$executeRawUnsafe(`DELETE FROM billing_events WHERE idempotency_key LIKE '${key}%'`)
      .catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// The per-request client binding
// ---------------------------------------------------------------------------
describe('runWithRequestDb binds a client per request', () => {
  it("two concurrent requests use two clients and never see each other's scope", async () => {
    const run = (storeId: string) =>
      runWithRequestDb(makeApp, () =>
        runInTenantContext(storeId, async () => {
          await new Promise(r => setTimeout(r, 20));
          const [{ s }] = await prisma.$queryRaw<
            Array<{ s: string }>
          >`SELECT current_setting('app.current_store_id', true) AS s`;
          const orders = await prisma.order.findMany({ select: { storeId: true } });
          return { s, stores: new Set(orders.map(o => o.storeId)) };
        })
      );
    const [a, b] = await Promise.all([run(ids.storeA), run(ids.storeB)]);
    expect(a.s).toBe(ids.storeA);
    expect(b.s).toBe(ids.storeB);
    expect([...a.stores]).toEqual([ids.storeA]);
    expect([...b.stores]).toEqual([ids.storeB]);
  });

  it('the client is disconnected after the request (through waitUntil when given)', async () => {
    let released: Promise<unknown> | undefined;
    let drained = false;
    await runWithRequestDb(makeApp, async () => prisma.order.count(), {
      waitUntil: p => {
        released = p;
      },
      beforeDisconnect: async () => {
        drained = true;
      },
    });
    expect(released).toBeDefined();
    await released;
    expect(drained).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `stores` and the user-keyed tables (R-EBDA-005, contract migration
// 20261008000100_tenant_defence_contract)
// ---------------------------------------------------------------------------
describe('stores and the user-keyed token tables are under strict RLS too (R-EBDA-005)', () => {
  const USER_KEYED = [
    'refresh_tokens',
    'verification_tokens',
    'onesignal_subscriptions',
    'legal_acceptances',
    'legal_notice_deliveries',
    'passkey_credentials',
  ];

  it('every forced table outside the global allowlist has at least one policy, ebda_app only', async () => {
    const rows = await owner.$queryRaw<
      Array<{ relname: string; npol: number; other_roles: number }>
    >`
      SELECT c.relname::text AS relname,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS npol,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                AND NOT (p.roles = ARRAY['ebda_app']::name[])) AS other_roles
      FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND c.relrowsecurity AND c.relforcerowsecurity`;
    const bad = rows.filter(
      r => !(r.relname in DOCUMENTED_NON_RLS) && (r.npol < 1 || r.other_roles > 0)
    );
    expect(bad, JSON.stringify(bad)).toEqual([]);
    for (const t of ['stores', ...USER_KEYED]) {
      expect(
        rows.map(r => r.relname),
        `${t} is forced`
      ).toContain(t);
    }
  });

  it('contextless: no store row and no token row is visible (fixtures prove the tables are not empty)', async () => {
    const [{ n }] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM public.stores`
    );
    expect(Number(n)).toBeGreaterThan(0);
    await appTx({}, async tx => {
      for (const t of ['stores', ...USER_KEYED]) {
        const [{ n: seen }] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM public."${t}"`
        );
        expect(Number(seen), t).toBe(0);
      }
    });
  });

  it('a store scope sees only its own store row, and cannot touch another', async () => {
    const seen = await appTx(
      { storeId: ids.storeA },
      tx => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM public.stores`
    );
    expect(seen.map(r => r.id)).toEqual([ids.storeA]);
    const touched = await appTx(
      { storeId: ids.storeA },
      tx => tx.$executeRaw`UPDATE public.stores SET name = 'hacked' WHERE id = ${ids.storeB}`
    );
    expect(touched).toBe(0);
    expect((await owner.store.findUnique({ where: { id: ids.storeB } }))?.name).toBe('RLS B');
  });

  it("a user sees the stores they own or staff, nobody else's; an active super_admin sees all", async () => {
    const as = (userId: string) =>
      appTx(
        { userId },
        tx =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM public.stores WHERE slug LIKE ${PREFIX + '%'}`
      ).then(r => r.map(x => x.id).sort());
    expect(await as(ids.ownerA)).toEqual([ids.storeA]);
    expect(await as(ids.staffA)).toEqual([ids.storeA]);
    expect(await as(ids.customerB)).toEqual([]);
    expect(await as(ids.superAdmin)).toEqual([ids.storeA, ids.storeB].sort());
  });

  it('a store is inserted only by its owner (or a super_admin)', async () => {
    await expect(
      appTx(
        { userId: ids.ownerA },
        tx =>
          tx.$executeRaw`INSERT INTO public.stores (id, name, slug, owner_id, updated_at) VALUES (${uid()}, 'x', ${PREFIX + 'ins-' + uid().slice(0, 8)}, ${ids.ownerB}, now())`
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('a user reads only their own refresh tokens', async () => {
    const mk = (userId: string) =>
      owner.refreshToken.create({
        data: { token: `${PREFIX}rt-${uid()}`, userId, expiresAt: new Date(Date.now() + 60_000) },
      });
    await mk(ids.ownerA);
    await mk(ids.customerB);
    const mine = await appTx(
      { userId: ids.ownerA },
      tx =>
        tx.$queryRaw<
          Array<{ user_id: string }>
        >`SELECT user_id FROM public.refresh_tokens WHERE token LIKE ${PREFIX + 'rt-%'}`
    );
    expect(new Set(mine.map(r => r.user_id))).toEqual(new Set([ids.ownerA]));
    await owner.refreshToken.deleteMany({ where: { token: { startsWith: `${PREFIX}rt-` } } });
  });
});
