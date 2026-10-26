/**
 * Tenant transactions pin the session time zone to UTC (Ruling ITEST-12).
 *
 * The schema keeps instants in `timestamp(3)` WITHOUT time zone. Prisma writes UTC wall time, but a SQL
 * `now()` / `CURRENT_TIMESTAMP` default yields the wall time of the SESSION's zone, so on a database or
 * pooler that is not UTC every DB-side default was hours off next to Prisma-written values. `gucStatements`
 * now adds a transaction-local `TimeZone = UTC` to the statement every tenant transaction already sends.
 * This test gives the connection a non-UTC zone on purpose and proves the tenant transaction overrides it
 * and gives the same wall time as the JS clock, then reverts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { createPrismaClient, runInTenantContext, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function kuwaitSessionUrl(): string {
  const u = new URL(OWNER_URL);
  u.searchParams.set('options', '-c TimeZone=Asia/Kuwait');
  return u.toString();
}

describe.skipIf(!hasDb)('tenant transactions pin the session time zone to UTC', () => {
  const client = hasDb
    ? createPrismaClient({ connectionString: kuwaitSessionUrl(), max: 2, role: 'owner' })
    : null;
  afterAll(async () => {
    await client?.$disconnect();
  });
  const asClient = <T>(fn: () => Promise<T>) => runWithRequestDb(() => client!, fn);

  it('control: the connection really starts in a non-UTC zone', async () => {
    const rows = await client!.$queryRaw<
      Array<{ tz: string }>
    >`SELECT current_setting('TimeZone') AS tz`;
    expect(rows[0].tz).toBe('Asia/Kuwait');
  });

  it('inside a tenant transaction the zone is UTC and CURRENT_TIMESTAMP matches the JS clock', async () => {
    const storeId = crypto.randomUUID();
    const inside = await asClient(() =>
      runInTenantContext(storeId, async () => {
        const { prisma } = await import('@ebda/database');
        return prisma.$queryRaw<Array<{ tz: string; wall: Date }>>`
          SELECT current_setting('TimeZone') AS tz, CURRENT_TIMESTAMP::timestamp AS wall`;
      })
    );
    expect(inside[0].tz).toBe('UTC');
    expect(Math.abs(inside[0].wall.getTime() - Date.now())).toBeLessThan(2 * 60_000);

    // transaction-local: the next plain statement on the same client is back in the session zone
    const after = await client!.$queryRaw<
      Array<{ tz: string }>
    >`SELECT current_setting('TimeZone') AS tz`;
    expect(after[0].tz).toBe('Asia/Kuwait');
  });
});
