/**
 * Ruling CF-JOBS-4B: queue-depth-watch for a store on its Durable Object. The stuck BulkAiJob rows come from the store's own DO on
 * its alarm, the resume flips the row through the DO writer, and Postgres THROWS if reached. Double fire: the first run resumes the
 * job (row back to `queued`, one event), the second finds nothing stuck and sends nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, any>>,
  sent: [] as Array<{ name: string; data: any }>,
  boom: (what: string): object =>
    new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: ${what}.${String(p)}`);
        },
      }
    ),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.boom('prisma'),
    extra: {
      withStore: async (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ store: { findUnique: async () => ({ name: 'Dahab', slug: 'dahab' }) } }),
    },
  })
);
vi.mock('@api/lib/repo-factory', () => {
  const db = {
    store: { findUnique: async () => ({ name: 'Dahab', slug: 'dahab' }) },
    bulkAiJob: {
      findMany: async (a: { where: Record<string, any> }) =>
        h.jobs.filter(
          j =>
            j.storeId === a.where.storeId &&
            j.status === a.where.status &&
            (a.where.startedAt
              ? j.startedAt < a.where.startedAt.lt
              : j.createdAt < a.where.createdAt.lt)
        ),
    },
  };
  const writer = {
    bulkAiJob: {
      update: async (a: { where: { id: string }; data: Record<string, any> }) => {
        const j = h.jobs.find(x => x.id === a.where.id)!;
        const { autoResumeCount, ...rest } = a.data;
        Object.assign(j, rest);
        if (autoResumeCount?.increment) j.autoResumeCount += autoResumeCount.increment;
        return j;
      },
    },
  };
  return { storeRepo: async () => ({ backend: 'do', db, writer }), storeDb: async () => db };
});
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(async (e: { name: string; data: any }) => void h.sent.push(e)),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn(async () => 'sent') }));
vi.mock('@api/lib/ai-quota', () => ({
  assertAiQuota: vi.fn(async () => undefined),
  isAiQuotaCapError: () => false,
}));

import { queueDepthWatch } from '@api/lib/inngest/functions/queue-depth-watch';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { ALARM_READY } from '@api/lib/jobs/alarm-flag';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

const alarm = { name: 'x', data: { alarm: true, storeId: DO_STORE } };
const run = () =>
  (queueDepthWatch as unknown as { handler: (a: unknown) => Promise<any> }).handler({
    event: alarm,
  });
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeEach(() => {
  h.sent.length = 0;
  h.jobs = [
    {
      id: 'j1',
      storeId: DO_STORE,
      kind: 'seo',
      status: 'running',
      processed: 3,
      total: 10,
      startedAt: minutesAgo(90),
      createdAt: minutesAgo(10),
      force: false,
      direction: null,
      autoResumeCount: 0,
    },
  ];
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('queue-depth-watch on a DO store', () => {
  it('is ported, alarm-armed and not refused', async () => {
    expect(PORTED_JOBS.has('queue-depth-watch')).toBe(true);
    expect(ALARM_READY.has('queue-depth-watch')).toBe(true);
    expect(await decideRunForStore({ id: 'queue-depth-watch' } as never, DO_STORE)).toEqual({
      run: true,
    });
  });

  it('resumes a stuck job through the DO writer and re-sends its event once (double fire)', async () => {
    const first = await run();
    expect(first).toMatchObject({ stuckRunning: 1, autoResumed: 1 });
    expect(h.jobs[0]).toMatchObject({ status: 'queued', autoResumeCount: 1 });
    expect(h.sent).toEqual([
      { name: 'bulk-ai/seo-requested', data: { jobId: 'j1', storeId: DO_STORE, force: false } },
    ]);
    const second = await run();
    expect(second).toMatchObject({ ok: true, stuckQueued: 0, stuckRunning: 0 });
    expect(h.sent).toHaveLength(1);
  });

  it('a job past the resume cap is failed in the DO row', async () => {
    h.jobs[0].autoResumeCount = 3;
    const out = await run();
    expect(out).toMatchObject({ autoReaped: 1 });
    expect(h.jobs[0].status).toBe('failed');
    expect(h.sent).toHaveLength(0);
  });
});
