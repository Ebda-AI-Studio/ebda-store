/**
 * Unit test — `deferAfterTenantCommit` / `withDeferredWork` semantics.
 *
 * The integration suite (tests/integration/after-tenant-commit.test.ts) proves
 * the P2028 behaviour against a real Postgres. This file pins the contract
 * that makes the fix SAFE rather than merely working:
 *
 *  - outside a request, work still runs inline and returns its value (so
 *    adopting the helper cannot regress Inngest / cron / script paths);
 *  - deferred work runs in a FRESH `runInTenantContext` carrying the SAME
 *    storeId AND userId — i.e. the RLS GUCs are re-established, not dropped
 *    (escaping AsyncLocalStorage to get a bare client would trade the
 *    transaction bug for a tenancy bug);
 *  - a failing task is LOUD — error log + Telegram alert — and does not
 *    prevent the remaining tasks from running. A swallowed `.catch` is why
 *    the original defect went undetected;
 *  - a rolled-back request drops its deferred work.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runInTenantContextMock, onClosedTenantTxAccessMock, sendAlertMock, loggerMock } =
  vi.hoisted(() => ({
    // Faithful stand-in: invokes the callback exactly like the real one does.
    runInTenantContextMock: vi.fn(
      async (_storeId: string | undefined, fn: () => Promise<unknown>, _userId?: string) => fn()
    ),
    onClosedTenantTxAccessMock: vi.fn(),
    sendAlertMock: vi.fn().mockResolvedValue('sent'),
    loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }));

vi.mock('@force/database', () => ({
  runInTenantContext: runInTenantContextMock,
  onClosedTenantTxAccess: onClosedTenantTxAccessMock,
}));

vi.mock('@api/services/alerts.service', () => ({ sendAlert: sendAlertMock }));
vi.mock('@api/lib/logger', () => ({ default: loggerMock }));

import {
  deferAfterTenantCommit,
  hasDeferralScope,
  installClosedTenantTxAlerting,
  withDeferredWork,
  awaitDeferredWork,
  DEFERRED_TX_GLOBAL_LIMIT,
  deferredConnectionsInUse,
} from '@api/lib/after-tenant-commit';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  runInTenantContextMock.mockImplementation(
    async (_storeId: string | undefined, fn: () => Promise<unknown>, _userId?: string) => fn()
  );
});

describe('deferAfterTenantCommit — no ambient request transaction', () => {
  it('runs inline and returns the result unchanged', async () => {
    expect(hasDeferralScope()).toBe(false);
    const run = vi.fn(async () => 'inline');

    await expect(deferAfterTenantCommit('t', run)).resolves.toBe('inline');
    expect(run).toHaveBeenCalledTimes(1);
    // No extra transaction is opened for the inline path.
    expect(runInTenantContextMock).not.toHaveBeenCalled();
  });

  it('propagates rejections inline, as before', async () => {
    await expect(
      deferAfterTenantCommit('t', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});

describe('withDeferredWork — inside a request transaction', () => {
  it('holds work until the transaction settles, then runs it in order', async () => {
    const order: string[] = [];

    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
      expect(hasDeferralScope()).toBe(true);
      void deferAfterTenantCommit('a', async () => {
        order.push('a');
      });
      void deferAfterTenantCommit('b', async () => {
        order.push('b');
      });
      // Nothing has run yet — the transaction is still open.
      expect(order).toEqual([]);
    });

    expect(order).toEqual(['a', 'b']);
  });

  it('resolves to null when deferred (the result is not knowable yet)', async () => {
    let deferredResult: unknown = 'unset';
    await withDeferredWork({ storeId: STORE_ID }, async () => {
      deferredResult = await deferAfterTenantCommit('t', async () => 'never-returned-inline');
    });
    expect(deferredResult).toBeNull();
  });

  it('re-establishes the SAME tenant context for each deferred task', async () => {
    await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
      void deferAfterTenantCommit('t', async () => undefined);
    });

    expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
    const [storeId, , userId] = runInTenantContextMock.mock.calls[0];
    expect(storeId).toBe(STORE_ID);
    expect(userId).toBe(USER_ID);
  });

  it('surfaces a failing task loudly and still runs the rest', async () => {
    const after = vi.fn(async () => undefined);

    await withDeferredWork({ storeId: STORE_ID }, async () => {
      void deferAfterTenantCommit('exploding.task', async () => {
        throw Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
      });
      void deferAfterTenantCommit('later.task', after);
    });

    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'after-tenant-commit.exploding.task',
      context: expect.objectContaining({ code: 'P2028', storeId: STORE_ID }),
    });
    // One task failing must not strand the queue.
    expect(after).toHaveBeenCalledTimes(1);
  });

  // Regression for #1591: drain() ran queued tasks one at a time, each in
  // its own Prisma interactive transaction — a bulk op that queues one task
  // per row (e.g. removing 8 banner images) paid N sequential round trips
  // AFTER the response was already sent. Proves overlap (not sequential)
  // without hardcoding the concurrency constant, and proves it's bounded
  // (not all N at once) so a large batch can't spike connections.
  it('drains multiple queued tasks with overlap, not strictly one at a time', async () => {
    const releases: Array<() => void> = [];
    runInTenantContextMock.mockImplementation(
      async (_storeId: string | undefined, fn: () => Promise<unknown>) => {
        await new Promise<void>(resolve => releases.push(resolve));
        return fn();
      }
    );

    const TASK_COUNT = 8;
    const donePromise = withDeferredWork({ storeId: STORE_ID }, async () => {
      for (let i = 0; i < TASK_COUNT; i++) {
        void deferAfterTenantCommit(`bulk-${i}`, async () => undefined);
      }
    });

    // Let every worker that starts synchronously reach its await point.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // More than one task is in flight at once (an improvement over strictly
    // sequential), and fewer than all of them are (bounded, not a fan-out of
    // TASK_COUNT simultaneous transactions).
    expect(releases.length).toBeGreaterThan(1);
    expect(releases.length).toBeLessThan(TASK_COUNT);

    // Let everything finish so the test doesn't leak a pending promise: a
    // few release/flush rounds cover every remaining batch of workers.
    for (let round = 0; round < 5; round++) {
      const pending = releases.splice(0, releases.length);
      pending.forEach(r => r());
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    await donePromise;
  });

  // P2 on PR #1977: the per-request bound let N concurrent requests hold
  // N × DRAIN_CONCURRENCY interactive transactions — three draining requests
  // were the whole default 15-connection pool. The cap is process-wide now.
  it('caps deferred transactions ACROSS concurrent requests, not per request', async () => {
    const releases: Array<() => void> = [];
    runInTenantContextMock.mockImplementation(
      async (_storeId: string | undefined, fn: () => Promise<unknown>) => {
        await new Promise<void>(resolve => releases.push(resolve));
        return fn();
      }
    );

    const REQUESTS = 4;
    const TASKS_EACH = 6;
    const drains = Array.from({ length: REQUESTS }, (_, r) =>
      withDeferredWork({ storeId: STORE_ID }, async () => {
        for (let i = 0; i < TASKS_EACH; i++) {
          void deferAfterTenantCommit(`req-${r}-task-${i}`, async () => undefined);
        }
      })
    );

    let maxInFlight = 0;
    let ran = 0;
    for (let round = 0; round < 100 && ran < REQUESTS * TASKS_EACH; round++) {
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < 20; i++) await Promise.resolve();
      maxInFlight = Math.max(maxInFlight, releases.length);
      const pending = releases.splice(0, releases.length);
      ran += pending.length;
      pending.forEach(r => r());
    }
    await Promise.all(drains);

    expect(ran).toBe(REQUESTS * TASKS_EACH);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(DEFERRED_TX_GLOBAL_LIMIT);
  });

  // issue 2250: r2-cleanup nests withRlsBypass inside its tenant transaction,
  // so each task holds TWO connections. Counted per task, five of them held
  // 10 of 15. Mutation-proof: acquiring 1 slot regardless of `connections`
  // lets maxConnections reach 2 × DEFERRED_TX_GLOBAL_LIMIT and reddens this.
  it('counts CONNECTIONS, so two-connection tasks never exceed the pool share', async () => {
    const releases: Array<() => void> = [];
    runInTenantContextMock.mockImplementation(
      async (_storeId: string | undefined, fn: () => Promise<unknown>) => {
        await new Promise<void>(resolve => releases.push(resolve));
        return fn();
      }
    );
    const TASKS = 12;
    const drain = withDeferredWork({ storeId: STORE_ID }, async () => {
      for (let i = 0; i < TASKS; i++) {
        void deferAfterTenantCommit(`nested-${i}`, async () => undefined, { connections: 2 });
      }
    });
    let maxConnections = 0;
    let ran = 0;
    for (let round = 0; round < 100 && ran < TASKS; round++) {
      // eslint-disable-next-line no-await-in-loop
      for (let i = 0; i < 20; i++) await Promise.resolve();
      maxConnections = Math.max(maxConnections, releases.length * 2);
      const pending = releases.splice(0, releases.length);
      ran += pending.length;
      pending.forEach(r => r());
    }
    await drain;
    expect(ran).toBe(TASKS);
    expect(maxConnections).toBeLessThanOrEqual(DEFERRED_TX_GLOBAL_LIMIT);
    expect(deferredConnectionsInUse()).toBe(0);
  });

  it('drops deferred work when the request transaction rolled back', async () => {
    const never = vi.fn(async () => undefined);

    await expect(
      withDeferredWork({ storeId: STORE_ID }, async () => {
        void deferAfterTenantCommit('never', never);
        throw new Error('Handler returned 500');
      })
    ).rejects.toThrow('Handler returned 500');

    expect(never).not.toHaveBeenCalled();
    expect(runInTenantContextMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  // PR 2279 audit: work that records something irreversible that already
  // happened outside the DB (a provider refund's P1) must survive a rollback.
  it('runs a runOnRollback task even when the transaction rolled back, and still drops the rest', async () => {
    const survivor = vi.fn(async () => undefined);
    const dropped = vi.fn(async () => undefined);

    await expect(
      withDeferredWork({ storeId: STORE_ID }, async () => {
        void deferAfterTenantCommit('survivor', survivor, { runOnRollback: true });
        void deferAfterTenantCommit('dropped', dropped);
        throw new Error('Handler returned 500');
      })
    ).rejects.toThrow('Handler returned 500');
    await awaitDeferredWork(1000);

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('leaves the scope behind, so nested deferrals inside a drained task run inline', async () => {
    const inner = vi.fn(async () => 'inner');

    await withDeferredWork({ storeId: STORE_ID }, async () => {
      void deferAfterTenantCommit('outer', async () => {
        expect(hasDeferralScope()).toBe(false);
        await deferAfterTenantCommit('inner', inner);
      });
    });

    expect(inner).toHaveBeenCalledTimes(1);
  });

  // Regression for #1588: a fire-and-forget promise created inside the
  // handler (never awaited — the anti-pattern this whole module exists to
  // close) can still be running after `withDeferredWork` has already
  // returned. Before this fix, a `deferAfterTenantCommit` call arriving from
  // it pushed into `scope.tasks` after `drain()` had already spliced that
  // array once — the task was queued but nothing would ever drain it again,
  // and it vanished silently with no log, no alert.
  describe('a deferAfterTenantCommit call that arrives after the scope closed (#1588)', () => {
    it('after a COMMIT + drain: runs the task in a fresh tenant transaction, loudly', async () => {
      let orphan: Promise<unknown> = Promise.resolve();
      const late = vi.fn(async () => 'ran-late');

      await withDeferredWork({ storeId: STORE_ID, userId: USER_ID }, async () => {
        // Captures the ALS context but is never awaited by the handler —
        // it resolves on its own, after withDeferredWork has returned.
        orphan = new Promise(resolve => setTimeout(resolve, 0)).then(() =>
          deferAfterTenantCommit('late.task', late)
        );
      });

      // withDeferredWork already resolved and drained (nothing was queued
      // synchronously) — the orphan is still pending.
      expect(late).not.toHaveBeenCalled();

      const result = await orphan;

      expect(late).toHaveBeenCalledTimes(1);
      expect(result).toBe(null); // same "deferred" contract as the on-time path
      // Ran in a SECOND fresh tenant transaction — the first was drain()'s
      // (empty, since nothing was queued in time), this is the late one.
      expect(runInTenantContextMock).toHaveBeenCalledTimes(1);
      const [storeId, , userId] = runInTenantContextMock.mock.calls[0];
      expect(storeId).toBe(STORE_ID);
      expect(userId).toBe(USER_ID);
      // Loud, not silent — this is exactly the failure class
      // installClosedTenantTxAlerting exists to catch.
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'late.task', scopeState: 'drained' }),
        expect.stringContaining('already drained')
      );
      expect(sendAlertMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'after-tenant-commit.late.late.task' })
      );
    });

    it('after a ROLLBACK: drops the task instead of running it against rolled-back rows', async () => {
      let orphan: Promise<unknown> = Promise.resolve();
      const late = vi.fn(async () => 'should-not-run');

      await expect(
        withDeferredWork({ storeId: STORE_ID }, async () => {
          orphan = new Promise(resolve => setTimeout(resolve, 0)).then(() =>
            deferAfterTenantCommit('late.after.rollback', late)
          );
          throw new Error('Handler returned 500');
        })
      ).rejects.toThrow('Handler returned 500');

      const result = await orphan;

      expect(late).not.toHaveBeenCalled();
      expect(result).toBe(null);
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'late.after.rollback', scopeState: 'rolledback' }),
        expect.stringContaining('already rolledback')
      );
    });
  });
});

describe('awaitDeferredWork — graceful shutdown drain (#1601)', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const start = Date.now();
    await awaitDeferredWork(5000);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('waits for an in-flight drain to finish before resolving (mutation-proof: an un-tracked drain would let this resolve BEFORE the task runs)', async () => {
    const order: string[] = [];
    let releaseTask: () => void;
    const gate = new Promise<void>(resolve => {
      releaseTask = resolve;
    });

    const requestPromise = withDeferredWork({ storeId: STORE_ID }, async () => {
      void deferAfterTenantCommit('slow-shutdown-task', async () => {
        await gate;
        order.push('task-finished');
      });
    });

    // Let the request's own await chain run far enough to start the drain
    // and register it in the in-flight set (a macrotask tick is enough here
    // since nothing else is queued).
    await new Promise(resolve => setImmediate(resolve));

    const shutdownWait = awaitDeferredWork(5000).then(() => {
      order.push('shutdown-wait-resolved');
    });

    releaseTask!();
    await shutdownWait;
    await requestPromise;

    expect(order).toEqual(['task-finished', 'shutdown-wait-resolved']);
  });

  it('gives up after timeoutMs instead of waiting forever on a hung task', async () => {
    const neverResolves = new Promise<void>(() => undefined);
    void withDeferredWork({ storeId: STORE_ID }, async () => {
      void deferAfterTenantCommit('hung-task', async () => {
        await neverResolves;
      });
    });
    await new Promise(resolve => setImmediate(resolve));

    const start = Date.now();
    await awaitDeferredWork(30);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('installClosedTenantTxAlerting', () => {
  it('registers a reporter that logs at error level and alerts for a COMMITTED tx (#1598)', () => {
    installClosedTenantTxAlerting();

    expect(onClosedTenantTxAccessMock).toHaveBeenCalledTimes(1);
    const reporter = onClosedTenantTxAccessMock.mock.calls[0][0] as (info: {
      property: string;
      stack?: string;
      reason: 'committed' | 'aborted';
    }) => void;

    reporter({ property: 'store', stack: 'Error\n    at somewhere', reason: 'committed' });

    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock.mock.calls[0][0]).toMatchObject({
      level: 'p1',
      source: 'after-tenant-commit.closed_tx_access',
      context: expect.objectContaining({ property: 'store' }),
    });
  });

  it('downgrades an ABORTED (rolled-back) tx access to a debug log with no alert (#1598)', () => {
    installClosedTenantTxAlerting();

    const reporter = onClosedTenantTxAccessMock.mock.calls[0][0] as (info: {
      property: string;
      stack?: string;
      reason: 'committed' | 'aborted';
    }) => void;

    reporter({ property: 'order', stack: 'Error\n    at somewhere', reason: 'aborted' });

    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(sendAlertMock).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalledTimes(1);
  });
});

// Merge of issue 2250 (connection-weighted cap) with PR 2279 (runOnRollback):
// a task can declare both, and a rolled-back request still runs it, under the
// same weighted cap, releasing every slot it took.
describe('connections + runOnRollback together', () => {
  it('a rolled-back request still runs a runOnRollback task declaring 2 connections, and frees its slots', async () => {
    console.log('SLOTS-BEFORE', deferredConnectionsInUse());
    // An earlier test deliberately leaves a hung task holding a slot, so
    // measure the delta rather than an absolute count.
    const before = deferredConnectionsInUse();
    const ran = vi.fn(async () => undefined);
    await expect(
      withDeferredWork({ storeId: STORE_ID }, async () => {
        void deferAfterTenantCommit('both', ran, { connections: 2, runOnRollback: true });
        void deferAfterTenantCommit('dropped', async () => undefined, { connections: 2 });
        throw new Error('Handler returned 500');
      })
    ).rejects.toThrow('Handler returned 500');
    for (let i = 0; i < 50 && ran.mock.calls.length === 0; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(deferredConnectionsInUse()).toBe(before);
  });
});
