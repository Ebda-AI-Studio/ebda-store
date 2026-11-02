/**
 * Ruling NZ-D19 follow-up: a failed post-commit D1 / DO Store write is logged, ALERTED and put on the jobs queue for a durable retry;
 * the retry converges (idempotent, absolute patch) and never undoes a newer write. runCommitHooks reports, never swallows.
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

describe('reportAndRetryStoreUpdate', () => {
  it('logs, alerts and enqueues a retry message carrying the absolute patch', async () => {
    const enqueue = vi.fn(async () => undefined);
    const alert = vi.fn();
    const r = await reportAndRetryStoreUpdate(
      's1',
      { plan: 'professional' },
      new Error('d1 down'),
      { version: 1234 },
      { enqueue, alert }
    );
    expect(r.enqueued).toBe(true);
    expect(enqueue).toHaveBeenCalledWith({
      kind: 'store-update-retry',
      storeId: 's1',
      data: { plan: 'professional' },
      version: 1234,
    });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(alert.mock.calls[0][1])).toMatch(/retry is queued/i);
  });
  it('a failing enqueue still alerts, and says NO RETRY QUEUED', async () => {
    const alert = vi.fn();
    const r = await reportAndRetryStoreUpdate(
      's1',
      { plan: 'x' },
      new Error('d1 down'),
      { version: 1 },
      {
        enqueue: async () => {
          throw new Error('queue down');
        },
        alert,
      }
    );
    expect(r.enqueued).toBe(false);
    expect(String(alert.mock.calls[0][1])).toMatch(/NO RETRY QUEUED/);
  });
});

describe('applyStoreUpdateRetry', () => {
  const m = {
    kind: 'store-update-retry' as const,
    storeId: 's1',
    data: { plan: 'professional' },
    version: 5,
  };
  it('retry succeeds -> applied once and done', async () => {
    const apply = vi.fn(async () => 'applied' as const);
    expect(await applyStoreUpdateRetry(m, { apply })).toBe('done');
    expect(apply).toHaveBeenCalledWith('s1', { plan: 'professional' }, 5);
  });
  it('a failing apply asks for a redelivery, then converges when D1 is back', async () => {
    let down = true;
    const apply = vi.fn(async () => {
      if (down) throw new Error('d1 down');
      return 'applied' as const;
    });
    expect(await applyStoreUpdateRetry(m, { apply })).toBe('retry');
    down = false;
    expect(await applyStoreUpdateRetry(m, { apply })).toBe('done');
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it('a retry superseded by a newer commit is done (skipped), not retried forever', async () => {
    expect(await applyStoreUpdateRetry(m, { apply: async () => 'skipped' })).toBe('done');
  });
  it('isStoreUpdateRetry recognises only its own message shape (version, not a timestamp)', () => {
    expect(isStoreUpdateRetry(m)).toBe(true);
    expect(isStoreUpdateRetry({ ...m, version: undefined })).toBe(false);
    expect(isStoreUpdateRetry({ kind: 'job' })).toBe(false);
    expect(isStoreUpdateRetry(null)).toBe(false);
  });
});
