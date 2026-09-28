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
