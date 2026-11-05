/**
 * G5: the two runners with fakes for Workflows, the gate DO and the queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { runJobWorkflow } from '@api/lib/jobs/run-workflow';
import {
  handleJobsBatch,
  jobRetryDelaySeconds,
  type QueueMessageLike,
} from '@api/lib/jobs/run-queue';
import type { WorkflowStepLike } from '@api/lib/jobs/step-adapter';

const sendAlert = vi.hoisted(() => vi.fn(async () => 'sent'));
const captureException = vi.hoisted(() => vi.fn(() => 'evt-123'));
const flush = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@api/services/alerts.service', () => ({ sendAlert }));
vi.mock('@sentry/cloudflare', () => ({ captureException, flush }));

class NonRetryable extends Error {}

const calls: string[] = [];
const outputs: Record<string, unknown> = {};
const wf: WorkflowStepLike = {
  async do(name, _cfg, cb) {
    calls.push(`do:${name}`);
    const out = await cb();
    outputs[name] = out;
    return out;
  },
  async sleep(name) {
    calls.push(`sleep:${name}`);
  },
  async sleepUntil(name) {
    calls.push(`until:${name}`);
  },
};

// A fake JobGate namespace with real lease semantics and a controllable clock.
let now = 0;
const leases = new Map<string, Map<string, number>>(); // gate -> token -> expiresAt
let acquireFails = 0;
let seq = 0;
const gateStub = (id: string) => ({
  acquire: async (limit: number, ttl: number) => {
    if (acquireFails > 0) {
      acquireFails--;
      return null;
    }
    const m = leases.get(id) ?? new Map<string, number>();
    for (const [t, exp] of m) if (exp <= now) m.delete(t);
    if (m.size >= limit) return null;
    const t = `${id}#${seq++}`;
    m.set(t, now + ttl);
    leases.set(id, m);
    return t;
  },
  renew: async (t: string, ttl: number) => {
    for (const m of leases.values()) if (m.has(t)) return m.set(t, now + ttl) && true;
    return false;
  },
  release: async (t: string) => {
    for (const m of leases.values()) m.delete(t);
  },
  isLatest: async () => latest,
  touch: async () => 'tok',
});
let latest = true;
const qsend = vi.fn(async () => undefined);

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(outputs)) delete outputs[k];
  leases.clear();
  now = 0;
  acquireFails = 0;
  latest = true;
  qsend.mockClear();
  clearJobRegistry();
  sendAlert.mockClear();
  captureException.mockClear();
  flush.mockClear();
  setCfBindings({
    JOBS_WORKFLOW: { create: async () => ({ id: 'i' }) },
    JOBS_QUEUE: { send: qsend },
    JOB_GATE: { idFromName: (n: string) => n, get: (id: unknown) => gateStub(String(id)) as never },
  });
});
afterEach(() => clearCfBindings());

const args = (fn: string, event = { name: 'x/y', id: 'e1', data: { storeId: 's1' } }) => ({
  params: { fn, event } as never,
  instanceId: 'inst-1',
  step: wf,
  withContext: <T>(f: () => Promise<T>) => f(),
  NonRetryable,
});

describe('runJobWorkflow', () => {
  it('runs the unchanged handler, each step.run a durable step, then releases its gate', async () => {
    const seen: unknown[] = [];
    registerJob(
      { id: 'bulk-ai-seo', concurrency: { key: 'event.data.storeId', limit: 1 } },
      async ({ event, step, runId }) => {
        seen.push(runId, event.data);
        await step.run('a', async () => 1);
        await step.sleep('nap', '1m');
        await step.run('b', async () => 2);
      }
    );
    await runJobWorkflow(args('bulk-ai-seo'));
    // Gate released while sleeping (Inngest counts running steps, not sleeping runs), re-taken after.
    expect(calls).toEqual([
      'do:gate0-0-try-0',
      'do:a',
      'do:gate-release-0',
      'sleep:nap',
      'do:gate1-0-try-0',
      'do:b',
      'do:gate-release-1',
    ]);
    expect(seen).toEqual(['inst-1', { storeId: 's1' }]);
    expect([...leases.values()].every(m => m.size === 0)).toBe(true);
  });

  it('concurrency: a busy gate waits (sleeps) and retries instead of running', async () => {
    registerJob(
      { id: 'bulk-ai-seo', concurrency: { key: 'event.data.storeId', limit: 1 } },
      async ({ step }) => {
        await step.run('a', async () => 1);
      }
    );
    acquireFails = 2;
    await runJobWorkflow(args('bulk-ai-seo'));
    expect(calls.slice(0, 5)).toEqual([
      'do:gate0-0-try-0',
      'sleep:gate0-0-wait-0',
      'do:gate0-0-try-1',
      'sleep:gate0-0-wait-1',
      'do:gate0-0-try-2',
    ]);
    expect(calls).toContain('do:a');
  });

  it('lease renewal: a run that outlives the TTL keeps the gate, a second run cannot take it', async () => {
    const TTL = 20 * 60_000;
    const blocked: Array<string | null> = [];
    registerJob(
      { id: 'bulk-ai-seo', concurrency: { key: 'event.data.storeId', limit: 1 } },
      async ({ step }) => {
        for (const i of [1, 2, 3]) {
          await step.run(`s${i}`, async () => {
            now += 15 * 60_000; // each step takes 15 minutes: 45 minutes in all, > 2 x TTL
            // Another run of the same store tries to start meanwhile.
            blocked.push(await gateStub('bulk-ai-seo|s1').acquire(1, TTL));
          });
        }
      }
    );
    await runJobWorkflow(args('bulk-ai-seo'));
    expect(blocked).toEqual([null, null, null]);
    // Once the run is over the gate is free for the next run.
    expect(await gateStub('bulk-ai-seo|s1').acquire(1, TTL)).not.toBeNull();
  });

  it('without renewal the same timeline WOULD have let a second run in (the test is not vacuous)', async () => {
    const TTL = 20 * 60_000;
    const stub = gateStub('g');
    const t = await stub.acquire(1, TTL);
    expect(t).not.toBeNull();
    now += 25 * 60_000; // never renewed
    expect(await stub.acquire(1, TTL)).not.toBeNull();
  });

  it('a lost lease aborts the run before its next step body', async () => {
    const bodies: string[] = [];
    registerJob(
      { id: 'bulk-ai-seo', concurrency: { key: 'event.data.storeId', limit: 1 } },
      async ({ step }) => {
        await step.run('s1', async () => {
          bodies.push('s1');
          // The lease is taken away (expired and re-granted to someone else).
          leases.get('bulk-ai-seo|s1')!.clear();
        });
        await step.run('s2', async () => {
          bodies.push('s2');
        });
      }
    );
    await expect(runJobWorkflow(args('bulk-ai-seo'))).rejects.toBeInstanceOf(NonRetryable);
    expect(bodies).toEqual(['s1']);
  });

  it('limits above the plan-cap threshold are not enforced', async () => {
    registerJob(
      { id: 'order-created-fanout', concurrency: { key: 'event.data.storeId', limit: 5 } },
      async ({ step }) => {
        await step.run('a', async () => 1);
      }
    );
    await runJobWorkflow(args('order-created-fanout'));
    expect(calls).toEqual(['do:a']);
  });

  it('failure: onFailure and the function.failed event run once, the gate is released, the error propagates', async () => {
    const onFailure = vi.fn(async () => undefined);
    registerJob(
      { id: 'bulk-ai-seo', retries: 1, onFailure, concurrency: { limit: 1 } },
      async ({ step }) => {
        await step.run('a', async () => 1);
        throw new Error('boom');
      }
    );
    await expect(runJobWorkflow(args('bulk-ai-seo'))).rejects.toThrow('boom');
    expect(onFailure).toHaveBeenCalledTimes(1);
    const failure = (
      onFailure.mock.calls as unknown as Array<[{ event: any; error: Error }]>
    )[0]![0];
    expect(failure.event.name).toBe('inngest/function.failed');
    expect(failure.event.data.event.name).toBe('x/y');
    expect(failure.error.message).toBe('boom');
    expect(calls).toContain('do:on-failure');
    // Exactly one direct alert + one Sentry capture, with job, group, instance id and error, no event data.
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const alert = (sendAlert.mock.calls as unknown as Array<[Record<string, any>]>)[0]![0];
    expect(alert).toMatchObject({
      level: 'p1',
      scope: 'platform',
      source: 'job.bulk-ai-seo',
      body: 'boom',
      context: { job: 'bulk-ai-seo', group: '4-ai', instanceId: 'inst-1', triggeringEvent: 'x/y' },
    });
    expect(JSON.stringify(alert)).not.toContain('s1'); // event.data (storeId) never leaves
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1); // awaited: a Workflow step has no waitUntil
    // The step output is the proof of delivery (readable with `wrangler workflows instances describe`).
    expect(outputs['on-failure']).toEqual({
      alert: 'sent',
      sentryEventId: 'evt-123',
      sentryFlushed: true,
    });
    expect(calls[calls.length - 1]).toBe('do:gate-release-0');
  });

  it('a NonRetriableError fails the instance without retries', async () => {
    registerJob({ id: 'bulk-ai-seo' }, async () => {
      throw Object.assign(new Error('bad'), { name: 'NonRetriableError' });
    });
    await expect(runJobWorkflow(args('bulk-ai-seo'))).rejects.toBeInstanceOf(NonRetryable);
  });

  it('debounce: a superseded run exits after the quiet period without running the handler', async () => {
    const h = vi.fn(async () => undefined);
    registerJob(
      {
        id: 'search-product-index',
        debounce: { key: 'event.data.storeId', period: '20s', timeout: '2m' },
      },
      h
    );
    latest = false;
    const a = args('search-product-index');
    (a.params as { debounceToken?: string }).debounceToken = 'tok';
    await runJobWorkflow(a);
    expect(h).not.toHaveBeenCalled();
    expect(calls).toEqual(['sleep:debounce-wait', 'do:debounce-latest']);
    latest = true;
    calls.length = 0;
    await runJobWorkflow(a);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('an unknown job is a non-retryable failure', async () => {
    await expect(runJobWorkflow(args('ghost'))).rejects.toBeInstanceOf(NonRetryable);
  });
});

function msg(body: unknown, attempts = 1) {
  const m = { id: 'm1', body, attempts, ack: vi.fn(), retry: vi.fn() };
  return m as typeof m & QueueMessageLike;
}
const job = (fn: string, extra: object = {}) => ({
  kind: 'job',
  fn,
  event: { name: 'x/y', id: 'e1', data: { storeId: 's1' } },
  ...extra,
});
const batch = (m: QueueMessageLike, queue = 'ebda-jobs') => ({ queue, messages: [m] });

describe('handleJobsBatch', () => {
  it('runs the handler inline (attempt is 0-based) and acks', async () => {
    const h = vi.fn(
      async ({
        step,
        attempt,
      }: {
        step: { run: (i: string, f: () => Promise<number>) => Promise<number> };
        attempt: number;
      }) => {
        expect(attempt).toBe(1);
        return step.run('only', async () => 1);
      }
    );
    registerJob({ id: 'heartbeat' }, h as never);
    const m = msg(job('heartbeat'), 2);
    await handleJobsBatch(batch(m));
    expect(m.ack).toHaveBeenCalled();
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('a failure retries with backoff until the job retries are spent, then runs the failure path and acks', async () => {
    const onFailure = vi.fn(async () => undefined);
    registerJob({ id: 'heartbeat', retries: 2, onFailure }, async () => {
      throw new Error('nope');
    });
    const first = msg(job('heartbeat'), 1);
    await handleJobsBatch(batch(first));
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(first.ack).not.toHaveBeenCalled();
    const second = msg(job('heartbeat'), 2);
    await handleJobsBatch(batch(second));
    expect(second.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    const last = msg(job('heartbeat'), 3); // retries: 2 -> 3 attempts in total
    await handleJobsBatch(batch(last));
    expect(last.ack).toHaveBeenCalled();
    expect(last.retry).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
    // The failed attempts alerted nothing; the final failure alerts exactly once (queue job).
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect((sendAlert.mock.calls as unknown as Array<[Record<string, any>]>)[0]![0]).toMatchObject({
      level: 'p1',
      source: 'job.heartbeat',
      body: 'nope',
      context: { job: 'heartbeat', group: '1-observability', instanceId: last.id },
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a payment webhook failure alerts at P0', async () => {
    registerJob({ id: 'payment-webhook-process', retries: 0 }, async () => {
      throw new Error('boom');
    });
    await handleJobsBatch(batch(msg(job('payment-webhook-process'), 1)));
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect((sendAlert.mock.calls as unknown as Array<[Record<string, any>]>)[0]![0].level).toBe(
      'p0'
    );
  });

  it('an alert that cannot be sent never fails the run', async () => {
    sendAlert.mockRejectedValueOnce(new Error('telegram down'));
    registerJob({ id: 'heartbeat', retries: 0 }, async () => {
      throw new Error('nope');
    });
    const m = msg(job('heartbeat'), 1);
    await handleJobsBatch(batch(m));
    expect(m.ack).toHaveBeenCalled();
  });

  it('the failure report records a throttled alert and an unflushed sentry event honestly', async () => {
    sendAlert.mockResolvedValueOnce('throttled' as never);
    flush.mockResolvedValueOnce(false);
    registerJob({ id: 'heartbeat', retries: 0 }, async () => {
      throw new Error('nope');
    });
    await expect(runJobWorkflow(args('heartbeat'))).rejects.toThrow('nope');
    expect(outputs['on-failure']).toEqual({
      alert: 'throttled',
      sentryEventId: 'evt-123',
      sentryFlushed: false,
      // An unfinished flush adds a direct ingest probe (no DSN in the test environment).
      sentryProbe: { error: 'no usable SENTRY_DSN in this context' },
    });
  });

  it('an inactive sentry client falls back to a direct ingest event and reports ITS id', async () => {
    flush.mockResolvedValueOnce(false);
    const fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.SENTRY_DSN = 'https://k@o1.ingest.de.sentry.io/4512212920565840';
    try {
      registerJob({ id: 'heartbeat', retries: 0 }, async () => {
        throw new Error('nope');
      });
      await expect(runJobWorkflow(args('heartbeat'))).rejects.toThrow('nope');
      const out = outputs['on-failure'] as {
        sentryEventId: string;
        sentryProbe: { status: number };
      };
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out.sentryProbe.status).toBe(200);
      expect(out.sentryEventId).toMatch(/^[0-9a-f]{32}$/);
      expect(out.sentryEventId).not.toBe('evt-123'); // the SDK's id never left the Worker
    } finally {
      delete process.env.SENTRY_DSN;
      vi.unstubAllGlobals();
    }
  });

  it('NonRetriableError fails at once', async () => {
    const onFailure = vi.fn(async () => undefined);
    registerJob({ id: 'heartbeat', retries: 5, onFailure }, async () => {
      throw Object.assign(new Error('bad'), { name: 'NonRetriableError' });
    });
    const m = msg(job('heartbeat'), 1);
    await handleJobsBatch(batch(m));
    expect(m.ack).toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('a busy concurrency gate re-sends the message with a delay and spends no attempt', async () => {
    const h = vi.fn(async () => undefined);
    registerJob({ id: 'shipment-create', concurrency: { key: 'event.data.orderId', limit: 1 } }, h);
    acquireFails = 1;
    const m = msg(job('shipment-create'), 1);
    await handleJobsBatch(batch(m));
    expect(h).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    expect(qsend).toHaveBeenCalledWith(
      expect.objectContaining({ fn: 'shipment-create', waits: 1 }),
      { contentType: 'json', delaySeconds: 10 }
    );
  });

  it('a superseded debounce message is dropped', async () => {
    const h = vi.fn(async () => undefined);
    registerJob(
      { id: 'search-product-index', debounce: { key: 'event.data.storeId', period: '20s' } },
      h
    );
    latest = false;
    const m = msg(job('search-product-index', { debounceToken: 'tok' }), 1);
    await handleJobsBatch(batch(m));
    expect(h).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('unreadable and unknown messages are acked, never retried forever', async () => {
    const bad = msg({ nope: true });
    await handleJobsBatch(batch(bad));
    expect(bad.ack).toHaveBeenCalled();
    const ghost = msg(job('ghost'));
    await handleJobsBatch(batch(ghost));
    expect(ghost.ack).toHaveBeenCalled();
  });

  it('the DLQ runs the failure path once and acks', async () => {
    const onFailure = vi.fn(async () => undefined);
    registerJob({ id: 'heartbeat', onFailure }, async () => undefined);
    const m = msg(job('heartbeat'));
    await handleJobsBatch(batch(m, 'ebda-jobs-dlq'));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(m.ack).toHaveBeenCalled();
  });

  it('retry delay curve matches the email queue', () => {
    expect([1, 2, 3, 4, 10].map(jobRetryDelaySeconds)).toEqual([5, 10, 20, 40, 300]);
  });
});
