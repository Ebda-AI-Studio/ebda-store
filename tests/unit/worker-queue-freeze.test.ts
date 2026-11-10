/**
 * INFRA-CF-1 PR E (Ruling CF-JOBS-2): the Worker `queue()` entry parks a batch BEFORE any consumer runs.
 * Behaviour, not source order: the real Worker entry is imported with its consumers replaced by spies and `queue()` is
 * driven for every consumer route. Frozen: no consumer runs and every message is parked (acked or retried). Thawed: the
 * consumer for that queue, and only it, runs. A guard that sits in another branch, is dead, or runs after a consumer fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ran = vi.hoisted(() => [] as string[]);
const send = vi.fn(async () => undefined);

vi.mock('cloudflare:node', () => ({ handleAsNodeRequest: vi.fn() }));
vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {},
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
vi.mock('node:http', () => ({ createServer: () => ({ listen: vi.fn() }) }));
vi.mock('@api/app', () => ({ default: {} }));
vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_o: unknown, h: unknown) => h,
  instrumentWorkflowWithSentry: (_o: unknown, c: unknown) => c,
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock('@api/cf/auth-state', () => ({ AuthState: class {} }));
vi.mock('@api/cf/store-realtime', () => ({ StoreRealtime: class {} }));
vi.mock('@api/cf/store-do/store-do', () => ({ StoreDO: class {} }));
vi.mock('@api/cf/job-gate', () => ({ JobGate: class {} }));
vi.mock('@api/cf/store-schedule-do', () => ({ StoreSchedule: class {} }));
vi.mock('@api/cf/queues', () => ({ handleQueueBatch: async () => void ran.push('queue') }));
vi.mock('@api/lib/wa/store-events-queue', () => ({
  handleStoreEventsBatch: async () => void ran.push('store-events'),
}));
vi.mock('@api/lib/ci/sink', () => ({
  handleCiEventsBatch: async () => void ran.push('ci-events'),
}));

const batch = (queue: string, n = 2) => ({
  queue,
  messages: Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    body: { n: i },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  })),
});

afterEach(() => {
  ran.length = 0;
  vi.unstubAllGlobals();
});

describe('Worker queue() entry under the write freeze', () => {
  it('parks every consumer route before it runs, and runs exactly that consumer when thawed', async () => {
    // workerd has globalThis.addEventListener (the Worker registers an unhandledrejection hook at import); Node does not.
    vi.stubGlobal('addEventListener', () => {});
    const worker = (await import('@api/worker')).default as unknown as {
      queue(b: unknown, env: unknown, ctx: unknown): Promise<void>;
    };
    const ctx = { waitUntil: () => {} };
    const frozenEnv = {
      WRITES_FROZEN: '1',
      EMAIL_QUEUE: { send },
      SMS_QUEUE: { send },
      CI_EVENTS_QUEUE: { send },
      JOBS_QUEUE: { send },
    };
    const routes: [string, string][] = [
      ['ebda-email', 'queue'],
      ['ebda-store-events', 'store-events'],
      ['ebda-ci-events', 'ci-events'],
    ];

    for (const [queue] of routes) {
      const b = batch(queue);
      await worker.queue(b, frozenEnv, ctx);
      for (const m of b.messages) {
        expect(m.ack.mock.calls.length + m.retry.mock.calls.length).toBe(1); // parked, not dropped
      }
    }
    expect(ran).toEqual([]); // frozen: no consumer ran

    for (const [queue, consumer] of routes) {
      ran.length = 0;
      // No queue bindings when thawed: the boot-time CI-capture assert only matters once a CI queue is bound.
      await worker.queue(batch(queue), {}, ctx);
      expect(ran).toEqual([consumer]);
    }
  });
});
