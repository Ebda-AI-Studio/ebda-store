/**
 * Issue 2354: `assertStrictTablesVisible` against a REAL Postgres, under an
 * owner AND a non-owner role — the ANALYZE + pg_class path the unit tests mock.
 *
 * The case that motivated it: after the force_app cutover the connection role
 * does not own the STRICT tables, so the guard's ANALYZE is skipped with a
 * WARNING and a never-populated table keeps `reltuples = -1` forever. The guard
 * used to read that as UNKNOWN and refuse every week. It now proves the bypass
 * positively (`app.bypass_rls = 'true'` inside the collection's own runner).
 *
 * Uses a throwaway table with the same policy shape as the STRICT tables
 * (store match OR the bypass GUC, FORCE RLS) and a throwaway NOLOGIN role, so
 * no real table is analyzed or touched. Per-call names (retry-safe).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { assertStrictTablesVisible, type R2CatalogDb } from '@api/lib/r2-references';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('R2 strict-visibility guard on a real Postgres (issue 2354)', () => {
  const pc = new PrismaClient();
  const sfx = crypto.randomBytes(4).toString('hex');
  const table = `r2probe_${sfx}`;
  const role = `r2probe_role_${sfx}`;
  // The table OWNER is a plain role too: the test DB connects as a superuser,
  // and a superuser bypasses RLS entirely, so it cannot stand in for either.
  const owner = `r2probe_owner_${sfx}`;

  type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
  const inTx = <T>(asRole: string | null, bypass: boolean, fn: (tx: Tx) => Promise<T>) =>
    pc.$transaction(async tx => {
      if (asRole) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${asRole}`);
      if (bypass) await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'true'`);
      return fn(tx);
    });
  const runner =
    (asRole: string | null, bypass: boolean) =>
    <T>(fn: (db: never) => Promise<T>) =>
      inTx(asRole, bypass, tx => fn(tx as never));
  const catalogAs = (asRole: string | null): R2CatalogDb =>
    ({
      $executeRawUnsafe: (sql: string, ...v: unknown[]) =>
        inTx(asRole, false, tx => tx.$executeRawUnsafe(sql, ...v)),
      $queryRawUnsafe: (sql: string, ...v: unknown[]) =>
        inTx(asRole, false, tx => tx.$queryRawUnsafe(sql, ...v)),
    }) as unknown as R2CatalogDb;
  const reltuples = async () =>
    Number(
      (
        await pc.$queryRawUnsafe<Array<{ r: number }>>(
          `SELECT reltuples::float8 AS r FROM pg_class WHERE oid = $1::regclass`,
          `public.${table}`
        )
      )[0].r
    );

  beforeAll(async () => {
    await pc.$executeRawUnsafe(
      `CREATE TABLE public.${table} (id text PRIMARY KEY, store_id text NOT NULL)`
    );
    await pc.$executeRawUnsafe(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    await pc.$executeRawUnsafe(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    await pc.$executeRawUnsafe(
      `CREATE POLICY ${table}_iso ON public.${table} USING (store_id = current_setting('app.current_store_id', true) OR current_setting('app.bypass_rls', true) = 'true')`
    );
    await pc.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
    await pc.$executeRawUnsafe(`CREATE ROLE ${owner} NOLOGIN`);
    await pc.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${owner}`);
    await pc.$executeRawUnsafe(`ALTER TABLE public.${table} OWNER TO ${owner}`);
    await pc.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pc.$executeRawUnsafe(`GRANT SELECT ON public.${table} TO ${role}`);
  });

  afterAll(async () => {
    await pc.$executeRawUnsafe(`DROP TABLE IF EXISTS public.${table}`);
    await pc.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => undefined);
    await pc.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${owner}`).catch(() => undefined);
    await pc.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    await pc.$executeRawUnsafe(`DROP ROLE IF EXISTS ${owner}`);
    await pc.$disconnect();
  });

  it('non-owner, never-analyzed empty table: ANALYZE is skipped and reltuples stays -1', async () => {
    await expect(assertStrictTablesVisible(runner(role, true), catalogAs(role), [table])).resolves.toBeUndefined();
    // The branch under test really executed: the non-owner ANALYZE did not mint an estimate.
    expect(await reltuples()).toBe(-1);
  });

  it('non-owner, unknown estimate, bypass NOT proven: refuses', async () => {
    await expect(
      assertStrictTablesVisible(runner(role, false), catalogAs(role), [table])
    ).rejects.toThrow(/did not prove app\.bypass_rls/);
  });

  it('a populated table: visible under the bypass, refused when RLS filters it', async () => {
    await inTx(null, true, tx =>
      tx.$executeRawUnsafe(`INSERT INTO public.${table} (id, store_id) VALUES ('a', 's1')`)
    );
    await expect(
      assertStrictTablesVisible(runner(role, true), catalogAs(role), [table])
    ).resolves.toBeUndefined();
    await expect(
      assertStrictTablesVisible(runner(role, false), catalogAs(role), [table])
    ).rejects.toThrow(/REFUSING/);
  });

  it('owner path: ANALYZE mints the estimate, and a filtered read is refused on it', async () => {
    await expect(
      assertStrictTablesVisible(runner(owner, false), catalogAs(owner), [table])
    ).rejects.toThrow(/catalog says it has rows \(reltuples 1/);
    expect(await reltuples()).toBe(1);
  });
});
