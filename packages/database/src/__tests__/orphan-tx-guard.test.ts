import { describe, it, expect, vi } from 'vitest';
import type { SqlDriverAdapter, SqlDriverAdapterFactory } from '@prisma/driver-adapter-utils';
import { createPrismaClientWithAdapter } from '../client';
import { guardOrphanTransactions, guardOrphanTransactionsFactory } from '../orphan-tx-guard';

/** A fake pg-like adapter: BEGIN succeeds (the "connection" is checked out), then the caller decides what happens. */
function fakeAdapter() {
  const log: string[] = [];
  let gate!: () => void;
  const started = new Promise<void>(r => (gate = r));
  let releaseStart!: () => void;
  const startGate = new Promise<void>(r => (releaseStart = r));
  const tx = {
    provider: 'postgres' as const,
    adapterName: 'fake',
    options: { usePhantomQuery: false },
    queryRaw: async () => ({ columnNames: [], columnTypes: [], rows: [] }),
    executeRaw: async (q: { sql: string }) => {
      log.push(q.sql);
      return 0;
    },
    commit: async () => void log.push('release:commit'),
    rollback: async () => void log.push('release:rollback'),
  };
  const adapter = {
    provider: 'postgres' as const,
    adapterName: 'fake',
    queryRaw: tx.queryRaw,
    executeRaw: tx.executeRaw,
    executeScript: async () => undefined,
    startTransaction: async () => {
      gate();
      await startGate; // BEGIN is "in flight"
      log.push('BEGIN');
      return tx;
    },
    dispose: async () => void log.push('pool.end'),
  } as unknown as SqlDriverAdapter;
  const factory = {
    provider: 'postgres',
    adapterName: 'fake',
    connect: async () => adapter,
  } as SqlDriverAdapterFactory;
  return { factory, log, started, releaseStart };
}

describe('orphan transaction guard (Prisma 6.19.3 "Unknown transaction status")', () => {
  it('a $disconnect() racing a transaction start no longer leaves BEGIN open before the pool ends', async () => {
    const f = fakeAdapter();
    const client = createPrismaClientWithAdapter(guardOrphanTransactionsFactory(f.factory));
    const inTx = vi.fn();
    const p = client
      .$transaction(async () => inTx())
      .then(
        () => 'ok',
        (e: Error) => e.message
      );
    await f.started;
    const dc = client.$disconnect();
    f.releaseStart();
    const msg = await p;
    await dc;
    expect(msg).toMatch(/Unknown transaction status/); // the Prisma defect this guards (adapter tx orphaned)
    expect(inTx).not.toHaveBeenCalled();
    // the orphan was rolled back AND released before the pool was ended
    const iRollback = f.log.indexOf('ROLLBACK');
    expect(iRollback).toBeGreaterThan(f.log.indexOf('BEGIN'));
    expect(f.log).toContain('release:rollback');
    expect(f.log.indexOf('release:rollback')).toBeLessThan(f.log.indexOf('pool.end'));
  });

  it('a transaction Prisma never closes is rolled back by the watchdog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = fakeAdapter();
      f.releaseStart();
      const a = guardOrphanTransactions(await f.factory.connect(), { orphanMs: 1000 });
      await a.startTransaction();
      await vi.advanceTimersByTimeAsync(1001);
      expect(f.log).toEqual(['BEGIN', 'ROLLBACK', 'release:rollback']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a transaction that commits is not touched by the guard afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = fakeAdapter();
      f.releaseStart();
      const a = guardOrphanTransactions(await f.factory.connect(), { orphanMs: 1000 });
      const tx = await a.startTransaction();
      await tx.executeRaw({ sql: 'COMMIT', args: [], argTypes: [] });
      await tx.commit();
      await vi.advanceTimersByTimeAsync(5000);
      await a.dispose();
      expect(f.log).toEqual(['BEGIN', 'COMMIT', 'release:commit', 'pool.end']);
    } finally {
      vi.useRealTimers();
    }
  });
});
