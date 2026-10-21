/**
 * Planner / index tests must run as the strict-RLS role `ebda_app`, never as the owner.
 *
 * Why (Task 14, Ruling SEARCH-T14-1): the tenant policy is a security barrier, and a user
 * predicate whose functions are not LEAKPROOF (`ILIKE`, `btrim`, `regexp_replace`, ...) may not be
 * an index condition under it. As the owner (BYPASSRLS) every such index "works"; as `ebda_app`
 * (production) the same statement was a store-wide scan. An owner-only planner test therefore
 * proves nothing about production. `tests/unit/planner-tests-run-as-app-role.test.ts` fails CI for
 * any test that EXPLAINs or toggles planner settings without importing this helper.
 *
 * Evidence is the index's own scan counter (`pg_stat_user_indexes.idx_scan`), read after running
 * the production statements as `ebda_app` under a store scope: a scan that bypasses the index
 * leaves it unchanged, and (unlike an EXPLAIN) it also sees statements nested inside a function.
 *
 *   const planner = createAppPlanner();
 *   const before = await planner.idxScans('products_search_doc_trgm_idx');
 *   await planner.inStore(storeId, () => searchProductIds(storeId, 'abc', { scope: 'storefront' }));
 *   await planner.expectScansAbove('products_search_doc_trgm_idx', before);
 */
import { expect } from 'vitest';
import { prisma, createPrismaClient, runWithRequestDb, runInTenantContext } from '@ebda/database';

export function appDatabaseUrl(): string {
  const u = new URL(process.env.DIRECT_URL || process.env.DATABASE_URL || '');
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}

export function createAppPlanner() {
  // ONE connection: the stats flush must happen in the session that ran the statements.
  const app = createPrismaClient({ connectionString: appDatabaseUrl(), max: 1 });
  const asApp = <T>(fn: () => Promise<T>) => runWithRequestDb(() => app, fn);
  const inStore = <T>(storeId: string, fn: () => Promise<T>) =>
    asApp(() => runInTenantContext(storeId, fn));

  /** idx_scan of an index, read by the OWNER (it sees every backend's flushed counters). */
  async function idxScans(name: string): Promise<number> {
    await prisma.$queryRaw`SELECT pg_stat_clear_snapshot()`;
    const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT idx_scan AS n FROM pg_stat_user_indexes WHERE indexrelname = ${name}`;
    if (r.length === 0) throw new Error(`no such index: ${name}`);
    return Number(r[0].n);
  }
  async function flush() {
    await asApp(() => app.$queryRaw`SELECT pg_stat_force_next_flush()`);
  }
  /** Counters flush asynchronously (later under load): poll up to 5 s instead of one sleep. */
  async function expectScansAbove(name: string, before: number) {
    let now = before;
    for (let i = 0; i < 50 && now <= before; i++) {
      await flush();
      now = await idxScans(name);
      if (now <= before) await new Promise(r => setTimeout(r, 100));
    }
    expect(now, `index ${name} was not scanned as ebda_app`).toBeGreaterThan(before);
  }
  return { app, asApp, inStore, idxScans, flush, expectScansAbove, close: () => app.$disconnect() };
}
