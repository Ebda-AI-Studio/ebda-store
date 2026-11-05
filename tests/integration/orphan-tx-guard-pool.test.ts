/**
 * The orphan-transaction guard (packages/database/src/orphan-tx-guard.ts) must never delay a NORMAL release: after a
 * commit or a rollback the pg client is back in the pool at once (idleCount == totalCount, nobody waiting), not at the
 * guard's 40 s watchdog or at dispose. PR 446: the guard was suspected of starving the pool in stock-race.
 */
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPrismaClientWithAdapter } from '../../packages/database/src/client';
import { guardOrphanTransactionsFactory } from '../../packages/database/src/orphan-tx-guard';

const url = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
const client = createPrismaClientWithAdapter(guardOrphanTransactionsFactory(new PrismaPg(pool)));

afterAll(async () => {
  await client.$disconnect();
});

const settled = () =>
  expect({ idle: pool.idleCount, total: pool.totalCount, waiting: pool.waitingCount }).toEqual({
    idle: pool.totalCount,
    total: pool.totalCount,
    waiting: 0,
  });

describe('orphan-tx-guard on a real pg pool', () => {
  it('a committed transaction returns its client to the pool immediately', async () => {
    await client.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1`;
    });
    settled();
  });

  it('a rolled-back transaction returns its client to the pool immediately', async () => {
    await expect(
      client.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1`;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    settled();
  });

  it('30 concurrent transactions on a pool of 3 finish fast and leave every client idle', async () => {
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        client
          .$transaction(async tx => {
            await tx.$queryRaw`SELECT ${i}::int`;
            if (i % 5 === 0) throw new Error('rollback');
          })
          .catch(() => undefined)
      )
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    settled();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`
    );
    expect(rows[0].n).toBe(0);
  });
});
