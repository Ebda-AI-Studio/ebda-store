/**
 * Ruling NZ-D19 follow-up: a failed post-commit D1 / DO Store write is logged, ALERTED and put on the jobs queue for a durable retry;
 * the retry carries {storeId} only and re-syncs the current committed state (Ruling NZ-D20). runCommitHooks reports, never swallows.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  afterTxCommit,
  registerTxHooks,
  runCommitHooks,
  setCommitHookErrorReporter,
} from '../../packages/database/src/tx-hooks';
import {
  applyStoreUpdateRetry,
  isStoreUpdateRetry,
  reportAndRetryStoreUpdate,
} from '../../apps/api/src/lib/store-update-retry';

vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));

describe('runCommitHooks reports a failing hook (never silent)', () => {
  it('a throwing hook goes to the reporter and the remaining hooks still run', async () => {
    const seen: unknown[] = [];
    setCommitHookErrorReporter(e => void seen.push(e));
    const tx = {};
    const hooks: Array<() => unknown> = [];
    registerTxHooks(tx, hooks);
    const ran: string[] = [];
    afterTxCommit(tx, () => {
      throw new Error('d1 down');
    });
    afterTxCommit(tx, () => ran.push('second'));
    await runCommitHooks(hooks);
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('d1 down');
    expect(ran).toEqual(['second']);
  });
});

describe('reportAndRetryStoreUpdate (NZ-D20: {storeId} only, never a patch)', () => {
  it('logs, alerts and enqueues a retry message carrying only the store id', async () => {
    const enqueue = vi.fn(async () => undefined);
    const alert = vi.fn();
    const r = await reportAndRetryStoreUpdate('s1', new Error('d1 down'), { enqueue, alert });
    expect(r.enqueued).toBe(true);
    expect(enqueue).toHaveBeenCalledWith({ kind: 'store-update-retry', storeId: 's1' });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0][1])).toMatch(/retry is queued/i);
  });
  it('a failing enqueue still alerts, and says NO RETRY QUEUED', async () => {
    const alert = vi.fn();
    const r = await reportAndRetryStoreUpdate('s1', new Error('d1 down'), {
      enqueue: async () => {
        throw new Error('queue down');
      },
      alert,
    });
    expect(r.enqueued).toBe(false);
    expect(String(alert.mock.calls[0][1])).toMatch(/NO RETRY QUEUED/);
  });
});

describe('applyStoreUpdateRetry', () => {
  const m = { kind: 'store-update-retry' as const, storeId: 's1' };
  it('sync succeeds -> done', async () => {
    const sync = vi.fn(async () => undefined);
    expect(await applyStoreUpdateRetry(m, { sync })).toBe('done');
    expect(sync).toHaveBeenCalledWith('s1');
  });
  it('a failing sync asks for a redelivery, then converges when D1 is back', async () => {
    let down = true;
    const sync = vi.fn(async () => {
      if (down) throw new Error('d1 down');
    });
    expect(await applyStoreUpdateRetry(m, { sync })).toBe('retry');
    down = false;
    expect(await applyStoreUpdateRetry(m, { sync })).toBe('done');
    expect(sync).toHaveBeenCalledTimes(2);
  });
  it('isStoreUpdateRetry recognises only its own message shape', () => {
    expect(isStoreUpdateRetry(m)).toBe(true);
    expect(isStoreUpdateRetry({ kind: 'store-update-retry' })).toBe(false);
    expect(isStoreUpdateRetry({ kind: 'job' })).toBe(false);
    expect(isStoreUpdateRetry(null)).toBe(false);
  });
});
