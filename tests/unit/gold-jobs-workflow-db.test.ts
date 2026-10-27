/**
 * Production bug 2026-10-27: gold-rate-staleness-watch (and the feed fetch) failed EVERY hour on the
 * Workflow with "DATABASE_URL is not set": they read the database BETWEEN steps, where a Workflow has
 * no connection. This runs both handlers on a Workflow-shaped step (`cfWorkflow`, the real marker) in
 * which the database is reachable ONLY inside a step body, and proves they never touch it outside.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ inStep: false, touched: 0 }));
const guard = <T>(v: T): T => {
  if (!h.inStep) throw new Error('DATABASE_URL is not set: a Worker binds one per request');
  h.touched++;
  return v;
};
vi.mock('../../apps/api/src/lib/definer', () => ({
  goldRateWatch: async () =>
    guard([
      {
        storeId: 's1',
        karat: 21,
        rateId: 'r1',
        appliedAt: new Date('2026-10-21T08:00:00Z'),
        maxAgeMinutes: 1560,
      },
    ]),
  goldFeedStores: async () => guard([{ storeId: 's1', premiumBps: 0 }]),
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { getClient: () => ({ get: async () => null, set: async () => 'OK' }) },
}));
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: { sendGoldRateNotice: async () => undefined },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({ sendAlert: async () => 'sent' }));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => guard({ name: 'Dahab', slug: 'dahab', owner: { email: null } }),
      },
    }),
}));

const { handleGoldRateStalenessWatch } =
  await import('../../apps/api/src/lib/inngest/functions/gold-rate-staleness-watch');
const { handleGoldRateFeedFetch } =
  await import('../../apps/api/src/lib/inngest/functions/gold-rate-feed-fetch');

/** A Workflow step: normalises results to JSON like the real one, database only inside `run`. */
const workflowStep = {
  cfWorkflow: true as const,
  async run<T>(_id: string, fn: () => Promise<T> | T): Promise<T> {
    h.inStep = true;
    try {
      const v = await fn();
      return (v === undefined ? null : JSON.parse(JSON.stringify(v))) as T;
    } finally {
      h.inStep = false;
    }
  },
};

describe('gold jobs on a Workflow never touch the database between steps', () => {
  it('gold-rate-staleness-watch reads the watch list and notifies inside steps', async () => {
    h.touched = 0;
    const out = await handleGoldRateStalenessWatch(
      { step: workflowStep },
      new Date('2026-10-22T10:00:00Z') // 26 h after the rate: blocked
    );
    expect(out).toMatchObject({ stores: 1 });
    expect(h.touched).toBeGreaterThan(0);
  });

  it('gold-rate-feed-fetch reads its store list inside a step', async () => {
    h.touched = 0;
    const out = await handleGoldRateFeedFetch(
      { step: workflowStep },
      { fetch: async () => ({ kind: 'down' }) as never }
    );
    expect(out).toBeDefined();
    expect(h.touched).toBeGreaterThan(0);
  });

  it('control: the same read outside a step does fail (the guard can fail)', async () => {
    h.inStep = false;
    const { goldRateWatch } = await import('../../apps/api/src/lib/definer');
    await expect(goldRateWatch()).rejects.toThrow('DATABASE_URL is not set');
  });
});
