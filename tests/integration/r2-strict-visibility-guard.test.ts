/**
 * Issue 2354: `assertStrictTablesVisible` against a REAL Postgres, under an
 * owner AND a non-owner role — the ANALYZE + pg_class path the unit tests mock.
 *
 * The case that motivated it: the collection role does not own the STRICT tables,
 * so the guard's ANALYZE is skipped with a WARNING and a never-populated table
 * keeps `reltuples = -1` forever. The guard used to read that as UNKNOWN and
 * refuse every week. It now proves the bypass positively, inside the collection's
 * own runner: the role bypasses RLS BY ITSELF (`rolsuper OR rolbypassrls`; Ebda has
 * no `app.bypass_rls` flag, the policies are strict).
 *
 * Uses a throwaway table with the strict policy shape (store match only, FORCE RLS)
 * and throwaway NOLOGIN roles (a plain one, a BYPASSRLS one and an owner), so no
 * real table is analyzed or touched. Per-call names (retry-safe).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@force/database';
import { assertStrictTablesVisible, type R2CatalogDb } from '@api/lib/r2-references';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('R2 strict-visibility guard on a real Postgres (issue 2354)', () => {
  const pc = createPrismaClient({ connectionString: process.env.DATABASE_URL ?? '' });
  const sfx = crypto.randomBytes(4).toString('hex');
  const table = `r2probe_${sfx}`;
  const role = `r2probe_role_${sfx}`;
  // The table OWNER is a plain role too: the test DB connects as a superuser,
  // and a superuser bypasses RLS entirely, so it cannot stand in for either.
  const owner = `r2probe_owner_${sfx}`;
  // A non-owner role that bypasses RLS by itself: the sweep's collection role.
  const bypassRole = `r2probe_bypass_${sfx}`;

  type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
  const inTx = <T>(asRole: string | null, fn: (tx: Tx) => Promise<T>) =>
    pc.$transaction(async tx => {
      if (asRole) await tx.$executeRawUnsafe(`SET LOCAL ROLE ${asRole}`);
      return fn(tx);
    });
  const runner =
    (asRole: string | null) =>
    <T>(fn: (db: never) => Promise<T>) =>
      inTx(asRole, tx => fn(tx as never));
  const catalogAs = (asRole: string | null): R2CatalogDb =>
    ({
      $executeRawUnsafe: (sql: string, ...v: unknown[]) =>
        inTx(asRole, tx => tx.$executeRawUnsafe(sql, ...v)),
      $queryRawUnsafe: (sql: string, ...v: unknown[]) =>
        inTx(asRole, tx => tx.$queryRawUnsafe(sql, ...v)),
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
      `CREATE POLICY ${table}_iso ON public.${table} USING (store_id = nullif(current_setting('app.current_store_id', true), ''))`
    );
    await pc.$executeRawUnsafe(`CREATE ROLE ${bypassRole} NOLOGIN BYPASSRLS`);
    await pc.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${bypassRole}`);
    await pc.$executeRawUnsafe(`GRANT SELECT ON public.${table} TO ${bypassRole}`);
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
    await pc
      .$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${bypassRole}`)
      .catch(() => undefined);
    await pc.$executeRawUnsafe(`DROP ROLE IF EXISTS ${bypassRole}`);
    await pc.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
    await pc.$executeRawUnsafe(`DROP ROLE IF EXISTS ${owner}`);
    await pc.$disconnect();
  });

  it('non-owner BYPASSRLS role, never-analyzed empty table: ANALYZE is skipped and reltuples stays -1', async () => {
    await expect(
      assertStrictTablesVisible(runner(bypassRole), catalogAs(bypassRole), [table])
    ).resolves.toBeUndefined();
    // The branch under test really executed: the non-owner ANALYZE did not mint an estimate.
    expect(await reltuples()).toBe(-1);
  });

  it('non-owner plain role, unknown estimate, bypass NOT proven: refuses', async () => {
    await expect(assertStrictTablesVisible(runner(role), catalogAs(role), [table])).rejects.toThrow(
      /did not prove that the\s+connection role bypasses RLS/
    );
  });

  it('a populated table: visible under the bypass, refused when RLS filters it', async () => {
    await inTx(null, tx =>
      tx.$executeRawUnsafe(`INSERT INTO public.${table} (id, store_id) VALUES ('a', 's1')`)
    );
    await expect(
      assertStrictTablesVisible(runner(bypassRole), catalogAs(bypassRole), [table])
    ).resolves.toBeUndefined();
    await expect(assertStrictTablesVisible(runner(role), catalogAs(role), [table])).rejects.toThrow(
      /REFUSING/
    );
  });

  it('owner path: ANALYZE mints the estimate, and a filtered read is refused on it', async () => {
    await expect(
      assertStrictTablesVisible(runner(owner), catalogAs(owner), [table])
    ).rejects.toThrow(/catalog says it has rows \(reltuples 1/);
    expect(await reltuples()).toBe(1);
  });
});
