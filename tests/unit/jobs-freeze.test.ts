/**
 * INFRA-CF-1 PR E (Ruling CF-JOBS-2): the cutover write freeze reaches every background writer.
 * With WRITES_FROZEN=1 a cron, a queue consumer, a Workflow instance/step and a DO alarm do NOT run job code, and
 * nothing is dropped: queue messages are re-sent, Workflows sleep, alarms keep their due time, rare crons are parked.
 * (The DO alarm half runs on workerd: apps/api/workers-test/store-schedule.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { JOBS_MAP } from '@api/lib/jobs/jobs-map';
import { FREEZE_MAX_WAITS, isSweepCron, writesFrozen } from '@api/lib/jobs/freeze';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { runJobWorkflow } from '@api/lib/jobs/run-workflow';
import { handleJobsBatch, type QueueMessageLike } from '@api/lib/jobs/run-queue';
import { runScheduledJobs } from '@api/lib/jobs/schedule';
import { parkIfFrozen, parkRetryDelaySeconds } from '@api/cf/queue-freeze';
import { runScheduled } from '@api/cf/cron';
import type { WorkflowStepLike } from '@api/lib/jobs/step-adapter';

vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));
// The legacy crons hit the database: replace the services CRON_SCHEDULE calls with a spy that must never run while frozen.
const legacy = vi.hoisted(() => ({ ran: [] as string[] }));
vi.mock('@api/services/abandoned-cart.service', () => ({
  abandonedCartService: { process: async () => void legacy.ran.push('abandoned-cart') },
}));
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: {
    runTrackingCron: async () => void legacy.ran.push('shipping-tracking'),
  },
}));
vi.mock('@api/services/loyalty-automation.service', () => ({
  loyaltyAutomationService: {
    runDailyAutomation: async () => void legacy.ran.push('loyalty-daily'),
  },
}));
vi.mock('@api/services/auth.service', () => ({
  AuthService: { cleanupRefreshTokens: async () => void legacy.ran.push('refresh-token-cleanup') },
}));
vi.mock('@api/cf/ops/backup-sweep', () => ({
  runBackupSweep: async () => {
    legacy.ran.push('backup-sweep');
    return { ok: true };
  },
  flaggedStoreIds: () => [],
}));
vi.mock('@api/lib/jobs/store-schedule', () => ({
  syncStoreSchedules: async () => void legacy.ran.push('store-schedule-sync'),
}));

class NonRetryable extends Error {}
const calls: string[] = [];
let sleepHook: () => void = () => {};
const wf: WorkflowStepLike = {
  async do(name, _c, cb) {
    calls.push(`do:${name}`);
    return cb();
  },
  async sleep(name) {
    calls.push(`sleep:${name}`);
    sleepHook();
  },
  async sleepUntil() {},
};
const wfArgs = (fn: string, data: Record<string, unknown> = { storeId: 's1' }) => ({
  params: { fn, event: { name: 'x/y', id: 'e1', data } } as never,
  instanceId: 'inst-1',
  step: wf,
  withContext: <T>(f: () => Promise<T>) => f(),
  NonRetryable,
});
const qmsg = (fn: string, extra: object = {}) => {
  const m = {
    id: 'm1',
    attempts: 1,
    body: { kind: 'job', fn, event: { name: 'x/y', id: 'e1', data: { storeId: 's1' } }, ...extra },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return m as typeof m & QueueMessageLike;
};
const send = vi.fn(async () => undefined);
const create = vi.fn(async () => ({ id: 'i' }));

beforeEach(() => {
  vi.unstubAllEnvs();
  calls.length = 0;
  legacy.ran.length = 0;
  sleepHook = () => {};
  send.mockClear();
  create.mockClear();
  clearJobRegistry();
  setCfBindings({ JOBS_QUEUE: { send }, JOBS_WORKFLOW: { create } } as never);
});
afterEach(() => {
  clearCfBindings();
  vi.unstubAllEnvs();
});
const freeze = () => vi.stubEnv('WRITES_FROZEN', '1');
const thaw = () => vi.stubEnv('WRITES_FROZEN', '');

describe('the flag', () => {
  it('is on only for exactly "1" (a typo can never freeze production)', () => {
    for (const v of ['', '0', 'true', 'yes', ' 1', '1 ', 'on']) {
      vi.stubEnv('WRITES_FROZEN', v);
      expect(writesFrozen()).toBe(false);
    }
    vi.stubEnv('WRITES_FROZEN', '1');
    expect(writesFrozen()).toBe(true);
    vi.stubEnv('WRITES_FROZEN', '');
    expect(writesFrozen({ WRITES_FROZEN: '1' })).toBe(true); // a Durable Object only has its own env
  });

  it('a sweep is a cron that fires again within 6 h; a daily or weekly one is not', () => {
    const t = Date.UTC(2026, 9, 29, 10, 0);
    expect(isSweepCron('7 * * * *', t)).toBe(true);
    expect(isSweepCron('*/15 * * * *', t)).toBe(true);
    expect(isSweepCron('0 */6 * * *', t)).toBe(true);
    expect(isSweepCron('0 3 * * *', t)).toBe(false);
    expect(isSweepCron('TZ=Africa/Cairo 0 6 * * 0', t)).toBe(false);
  });
});

describe('no job writes anywhere while frozen (every job in the map, both runners)', () => {
  const ids = Object.keys(JOBS_MAP);

  it('the map has jobs of both kinds (the loops below are not vacuous)', () => {
    expect(ids.length).toBeGreaterThan(90);
    expect(ids.some(i => JOBS_MAP[i].kind === 'workflow')).toBe(true);
    expect(ids.some(i => JOBS_MAP[i].kind === 'queue')).toBe(true);
  });

  it('queue runner: no handler runs, every message is re-sent (never dropped) and acked', async () => {
    freeze();
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    for (const id of ids) {
      const h = vi.fn(async () => 1);
      handlers.set(id, h);
      registerJob({ id }, h);
    }
    for (const id of ids) {
      const m = qmsg(id);
      await handleJobsBatch({ queue: 'ebda-jobs', messages: [m] });
      expect(m.ack, id).toHaveBeenCalledTimes(1);
      expect(m.retry, id).not.toHaveBeenCalled();
    }
    expect([...handlers.values()].every(h => h.mock.calls.length === 0)).toBe(true);
    expect(send).toHaveBeenCalledTimes(ids.length);
    expect(send.mock.calls[0][0]).toMatchObject({ kind: 'job', frozenWaits: 1 });
    // after the thaw the SAME re-sent message runs the job exactly once
    thaw();
    const first = send.mock.calls[0][0] as { fn: string };
    const m = qmsg(first.fn);
    await handleJobsBatch({ queue: 'ebda-jobs', messages: [m] });
    expect(handlers.get(first.fn)).toHaveBeenCalledTimes(1);
  });

  it('workflow runner: every job sleeps before its first step; none runs a body until the thaw, then each runs once', async () => {
    freeze();
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    for (const id of ids) {
      const h = vi.fn(
        async ({ step }: { step: { run: (i: string, f: () => unknown) => unknown } }) => {
          await step.run('only', () => 1);
        }
      );
      handlers.set(id, h);
      registerJob({ id }, h as never);
    }
    for (const id of ids) {
      calls.length = 0;
      let sleeps = 0;
      sleepHook = () => {
        sleeps++;
        for (const [other, h] of handlers) if (other === id) expect(h, id).not.toHaveBeenCalled();
        if (sleeps === 2) thaw();
      };
      await runJobWorkflow(wfArgs(id));
      expect(sleeps, id).toBe(2);
      expect(
        calls.filter(c => c.startsWith('sleep:freeze-wait')),
        id
      ).toHaveLength(2);
      expect(handlers.get(id), id).toHaveBeenCalledTimes(1);
      freeze();
    }
  });

  it('a freeze that starts MID-RUN parks the run before its next step, and the step runs after the thaw', async () => {
    const order: string[] = [];
    registerJob({ id: 'bulk-ai-seo' }, async ({ step }) => {
      await step.run('a', async () => {
        order.push('a');
        freeze(); // the operator flips the flag while the run is between steps
      });
      await step.run('b', async () => void order.push('b'));
    });
    sleepHook = () => {
      order.push('slept');
      thaw();
    };
    await runJobWorkflow(wfArgs('bulk-ai-seo'));
    expect(order).toEqual(['a', 'slept', 'b']);
  });

  it('a freeze longer than 24 h ends the run loudly (failure path), it does not loop forever', async () => {
    freeze();
    registerJob({ id: 'bulk-ai-seo' }, async () => 1);
    let sleeps = 0;
    sleepHook = () => void sleeps++;
    await expect(runJobWorkflow(wfArgs('bulk-ai-seo'))).rejects.toBeInstanceOf(NonRetryable);
    expect(sleeps).toBe(FREEZE_MAX_WAITS);
  });

  it('the dead-letter consumer waits too (its failure path writes)', async () => {
    freeze();
    const onFailure = vi.fn();
    registerJob({ id: 'bulk-ai-seo', onFailure }, async () => 1);
    const m = qmsg('bulk-ai-seo');
    await handleJobsBatch({ queue: 'ebda-jobs-dlq', messages: [m] });
    expect(onFailure).not.toHaveBeenCalled();
    expect(m.ack).not.toHaveBeenCalled();
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
  });
});

describe('crons', () => {
  it('Cron Triggers: a sweep tick is skipped, a rare job is STARTED (parked by the run layer)', async () => {
    registerJob(
      { id: 'payment-reconcile-sweep', triggers: [{ cron: '7 * * * *' }] },
      vi.fn() as never
    );
    registerJob(
      { id: 'billing-renewal-daily', triggers: [{ cron: '0 4 * * *' }] },
      vi.fn() as never
    );
    freeze();
    const hour = Date.UTC(2026, 9, 29, 4, 7);
    const sweep = await runScheduledJobs('7 * * * *', hour);
    expect(sweep).toEqual([{ job: 'payment-reconcile-sweep', result: 'frozen-skipped' }]);
    expect(send).not.toHaveBeenCalled();
    const daily = await runScheduledJobs('0 4 * * *', Date.UTC(2026, 9, 29, 4, 0));
    expect(daily).toEqual([{ job: 'billing-renewal-daily', result: 'started' }]);
    thaw();
    expect((await runScheduledJobs('7 * * * *', hour))[0].result).toBe('started');
  });

  it('legacy crons: nothing runs; a sweep (<= 6 h) is skipped, anything rarer is parked on the jobs queue as a legacy-cron message', async () => {
    freeze();
    for (const cron of ['*/15 * * * *', '*/30 * * * *', '0 */12 * * *', '0 * * * *', '0 3 * * *'])
      await runScheduled(cron, Date.UTC(2026, 9, 29, 3, 0));
    expect(legacy.ran).toEqual([]);
    const parked = send.mock.calls.map(c => c[0]);
    expect(parked).toEqual([
      { kind: 'legacy-cron', name: 'refresh-token-cleanup', cron: '0 */12 * * *' }, // every 12 h: rarer than a sweep
      { kind: 'legacy-cron', name: 'loyalty-daily', cron: '0 3 * * *' },
      { kind: 'legacy-cron', name: 'backup-sweep', cron: '0 3 * * *' },
    ]);
  });

  it('a parked legacy cron runs once the freeze is off (and not before)', async () => {
    freeze();
    const m = {
      ...qmsg('x'),
      body: { kind: 'legacy-cron', name: 'loyalty-daily', cron: '0 3 * * *' },
    };
    await handleJobsBatch({ queue: 'ebda-jobs', messages: [m as never] });
    expect(legacy.ran).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1); // re-sent
    thaw();
    await handleJobsBatch({ queue: 'ebda-jobs', messages: [m as never] });
    expect(legacy.ran).toEqual(['loyalty-daily']);
    expect(m.ack).toHaveBeenCalledTimes(2);
  });

  it('nothing changes when not frozen', async () => {
    await runScheduled('*/15 * * * *', Date.UTC(2026, 9, 29, 3, 0));
    expect(legacy.ran).toEqual(['abandoned-cart']);
  });
});

describe('every other queue consumer (email, sms, CI, WhatsApp store events, DLQs)', () => {
  const batch = (queue: string, n = 2) => {
    const messages = Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      body: { n: i },
      attempts: 1 + i,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    return { queue, messages };
  };

  it('is a no-op while not frozen', async () => {
    const b = batch('ebda-email');
    expect(await parkIfFrozen(b, { EMAIL_QUEUE: { send } } as never)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(b.messages[0].ack).not.toHaveBeenCalled();
  });

  it('re-sends each message to its own queue with a delay, then acks (no attempt spent)', async () => {
    freeze();
    for (const [queue, binding] of [
      ['ebda-email', 'EMAIL_QUEUE'],
      ['ebda-sms', 'SMS_QUEUE'],
      ['ebda-ci-events', 'CI_EVENTS_QUEUE'],
      ['ebda-jobs', 'JOBS_QUEUE'],
    ] as const) {
      send.mockClear();
      const b = batch(queue);
      expect(await parkIfFrozen(b, { [binding]: { send } } as never)).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith({ n: 0 }, { contentType: 'json', delaySeconds: 300 });
      for (const m of b.messages) {
        expect(m.ack).toHaveBeenCalledTimes(1);
        expect(m.retry).not.toHaveBeenCalled();
      }
    }
  });

  it('a queue only another Worker produces to, and every DLQ, is retried with backoff (never acked)', async () => {
    freeze();
    for (const queue of [
      'ebda-store-events',
      'ebda-email-dlq',
      'ebda-sms-dlq',
      'ebda-ci-events-dlq',
    ]) {
      const b = batch(queue);
      expect(await parkIfFrozen(b, {} as never)).toBe(true);
      expect(b.messages[0].ack).not.toHaveBeenCalled();
      expect(b.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(b.messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    }
    expect(parkRetryDelaySeconds(40)).toBe(43_200); // capped at the 12 h platform limit
  });

  it('a failed re-send falls back to retry: a message is acked only when it is safely queued again', async () => {
    freeze();
    const b = batch('ebda-email', 1);
    const bad = vi.fn(async () => {
      throw new Error('queue down');
    });
    await parkIfFrozen(b, { EMAIL_QUEUE: { send: bad } } as never);
    expect(b.messages[0].ack).not.toHaveBeenCalled();
    expect(b.messages[0].retry).toHaveBeenCalledTimes(1);
  });

  it('the Worker queue() entry parks BEFORE any consumer runs', () => {
    const src = readFileSync(new URL('../../apps/api/src/worker.ts', import.meta.url), 'utf8');
    const q = src.slice(src.indexOf('async function queue('));
    const body = q.slice(0, q.indexOf('\n}\n'));
    expect(body.indexOf('parkIfFrozen')).toBeGreaterThan(-1);
    expect(body.indexOf('parkIfFrozen')).toBeLessThan(body.indexOf('handleQueueBatch'));
    expect(body.indexOf('parkIfFrozen')).toBeLessThan(body.indexOf('handleStoreEventsBatch'));
    expect(body.indexOf('parkIfFrozen')).toBeLessThan(body.indexOf('handleCiEventsBatch'));
  });
});
