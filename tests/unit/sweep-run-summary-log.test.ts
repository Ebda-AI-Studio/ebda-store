/**
 * One structured summary line per scheduled sweep run, even when nothing is stuck (the empty-exit path logged nothing, so a live run
 * of a sweep could not be seen in R2 Logpush). Counts only: a non-numeric field (an id, a name, an email) is dropped, never logged.
 * Sweeps covered (the stuck-sweep family in lib/inngest/functions): order-created-stuck-sweep, order-status-fanout-stuck-sweep,
 * payment-webhook-stuck-sweep, payment-reconcile-sweep, refund-reversal-stuck-sweep (which also covers the partial-return and
 * refund-claim sweeps it runs on the same tick). Not covered: sweeps that are not stuck-row safety nets
 * (ai-autofill, catalog-import-uploads, domain-claim, payment-abandonment, r2-orphan, warehouse-reconcile).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: h.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, fn: unknown) => fn, send: vi.fn() },
}));
vi.mock('../../apps/api/src/lib/jobs/store-db', () => ({
  sweepStoresDb: async () => [],
  storeNameOf: async (id: string) => id,
  withStoreDb: async () => undefined,
  acrossStoresDb: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/definer', async importOriginal => ({
  ...(await importOriginal<object>()),
  webhookInbox: { stuck: async () => [] },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { acquireLock: async () => true },
}));
vi.mock('../../apps/api/src/services/payment-event.service', () => ({
  recordPaymentEventForStore: vi.fn(),
}));

import { logSweepRun } from '../../apps/api/src/lib/inngest/sweep-run-log';
import { orderCreatedStuckSweep } from '../../apps/api/src/lib/inngest/functions/order-created-stuck-sweep';
import { orderStatusFanoutStuckSweep } from '../../apps/api/src/lib/inngest/functions/order-status-fanout-stuck-sweep';
import { paymentWebhookStuckSweep } from '../../apps/api/src/lib/inngest/functions/payment-webhook-stuck-sweep';
import { paymentReconcileSweep } from '../../apps/api/src/lib/inngest/functions/payment-reconcile-sweep';
import { refundReversalStuckSweep } from '../../apps/api/src/lib/inngest/functions/refund-reversal-stuck-sweep';

const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };
const run = (job: unknown) =>
  (job as (a: { step: typeof step; event: undefined }) => Promise<unknown>)({
    step,
    event: undefined,
  });

beforeEach(() => h.info.mockClear());

describe('logSweepRun', () => {
  it('logs the sweep name and its numeric counts only, and returns its input untouched', () => {
    const input = { swept: 3, resent: 2, alerted: 0, ids: ['order-1'], who: 'a@b.test', bad: NaN };
    expect(logSweepRun('demo-sweep', input)).toBe(input);
    expect(h.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = h.info.mock.calls[0]!;
    expect(fields).toEqual({
      event: 'sweep.run',
      sweep: 'demo-sweep',
      swept: 3,
      resent: 2,
      alerted: 0,
    });
    expect(msg).toBe('[sweep-run] demo-sweep');
    expect(JSON.stringify(fields)).not.toMatch(/order-1|a@b\.test/);
  });
});

describe('an empty run of each stuck sweep still logs its summary line', () => {
  it.each([
    ['order-created-stuck-sweep', orderCreatedStuckSweep, { swept: 0, resent: 0, alerted: 0 }],
    [
      'order-status-fanout-stuck-sweep',
      orderStatusFanoutStuckSweep,
      { swept: 0, resent: 0, alerted: 0 },
    ],
    ['payment-webhook-stuck-sweep', paymentWebhookStuckSweep, { swept: 0, resent: 0, alerted: 0 }],
    ['payment-reconcile-sweep', paymentReconcileSweep, { scanned: 0, alerted: 0 }],
    [
      'refund-reversal-stuck-sweep',
      refundReversalStuckSweep,
      {
        swept: 0,
        resent: 0,
        alerted: 0,
        partialReturnsSwept: 0,
        partialReturnsResent: 0,
        stuckRefundClaims: 0,
      },
    ],
  ])('%s', async (name, job, counts) => {
    await run(job);
    const lines = h.info.mock.calls.filter(c => (c[0] as { event?: string }).event === 'sweep.run');
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual({ event: 'sweep.run', sweep: name, ...counts });
    expect(lines[0]![1]).toBe(`[sweep-run] ${name}`);
  });
});
