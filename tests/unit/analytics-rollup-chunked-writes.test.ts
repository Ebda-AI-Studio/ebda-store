/**
 * issue 2293 — the nightly rollup's per-row UPDATE loops paid a savepoint per
 * row (SAVEPOINT + UPDATE + RELEASE) inside ONE 30s tenant transaction that
 * also held the other two rollups. Now: one savepoint per chunk of rows, a
 * failed chunk replayed row by row, and each rollup in its own step + tenant
 * transaction.
 *
 * Mutation-proof: wrapping each row in its own savepoint again reddens the
 * savepoint-count case; merging the steps back into one reddens the step case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ savepoints: 0, tenantWraps: [] as string[] }));

vi.mock('@api/lib/savepoint', () => ({
  withSavepoint: async <T>(fn: () => Promise<T>) => {
    h.savepoints += 1;
    return fn();
  },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  RfmSegment: {},
  withRlsBypass: vi.fn(),
  runInTenantContext: async (storeId: string, fn: () => unknown) => {
    h.tenantWraps.push(storeId);
    return fn();
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}));
const r = vi.hoisted(() => ({
  cohort: vi.fn(async () => 1),
  funnel: vi.fn(async () => 2),
  rfm: vi.fn(async () => 3),
}));
vi.mock('@api/services/accounting/analytics-rollup.service', async orig => ({
  ...(await orig<typeof import('@api/services/accounting/analytics-rollup.service')>()),
  runCohortRollup: r.cohort,
  runFunnelRollup: r.funnel,
  runRfmRollup: r.rfm,
}));

import { writeInChunks } from '@api/services/accounting/analytics-rollup.service';
import { runStoreRollupSteps } from '@api/lib/inngest/functions/analytics-daily-rollup';

beforeEach(() => {
  h.savepoints = 0;
  h.tenantWraps = [];
});

describe('rollup writes are chunked (issue 2293)', () => {
  it('250 rows cost 3 savepoints, not 250', async () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const written = await writeInChunks(
      items,
      async () => undefined,
      () => undefined
    );
    expect(written).toBe(250);
    expect(h.savepoints).toBe(3);
  });

  it('a failing row costs only itself: its chunk is replayed row by row', async () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    const errors: number[] = [];
    const written = await writeInChunks(
      items,
      async i => {
        if (i === 42) throw new Error('bad row');
      },
      (_err, i) => errors.push(i)
    );
    expect(written).toBe(149);
    expect(errors).toEqual([42]);
  });
});

describe('each rollup runs in its own step and tenant transaction (issue 2293)', () => {
  it('three steps, three tenant wraps, results assembled', async () => {
    const ids: string[] = [];
    const step = { run: async <T>(id: string, fn: () => Promise<T>) => (ids.push(id), fn()) };
    const res = await runStoreRollupSteps(step, 'store-1', 'rollup-store-1');
    expect(ids).toEqual(['rollup-store-1-cohort', 'rollup-store-1-funnel', 'rollup-store-1-rfm']);
    expect(h.tenantWraps).toEqual(['store-1', 'store-1', 'store-1']);
    expect(res).toEqual({ cohortRows: 1, funnelDays: 2, rfmCustomers: 3 });
  });
});

describe('the nightly cron fans out one run per store (issue 2348)', () => {
  it('does no rollup work itself: one list step + batched events, never 3 steps per store', async () => {
    // Behaviour: run the real cron handler with a fake step and count what it does.
    vi.resetModules();
    const { inngest } = await import('@api/lib/inngest/client');
    await import('@api/lib/inngest/functions/analytics-daily-rollup');
    const stores = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const stepRuns: string[] = [];
    const events: Array<{ name: string; data: { storeId: string } }> = [];
    const step = {
      run: async (id: string, _fn: () => unknown) => {
        stepRuns.push(id);
        return stores;
      },
      sendEvent: async (_id: string, batch: typeof events) => {
        events.push(...batch);
      },
    };
    const call = vi
      .mocked(inngest.createFunction)
      .mock.calls.find(c => (c[0] as { id: string }).id === 'analytics-daily-rollup')!;
    await (call[1] as unknown as (ctx: unknown) => Promise<unknown>)({ step });
    // exactly ONE step (the store list); the three rollups are not run here, only requested
    expect(stepRuns).toHaveLength(1);
    expect(r.cohort).not.toHaveBeenCalled();
    expect(r.funnel).not.toHaveBeenCalled();
    expect(r.rfm).not.toHaveBeenCalled();
    expect(events.map(e => e.name)).toEqual(Array(3).fill('insights/rollup-requested'));
    expect(events.map(e => e.data.storeId)).toEqual(['s1', 's2', 's3']);
    // and the per-store function is capped: 3 stores at once, one run per store
    const onDemand = vi
      .mocked(inngest.createFunction)
      .mock.calls.find(c => (c[0] as { id: string }).id === 'analytics-rollup-on-demand')!;
    expect((onDemand[0] as { concurrency: unknown }).concurrency).toEqual([
      { limit: 3 },
      { key: 'event.data.storeId', limit: 1 },
    ]);
  });

  it('batches the fan-out: 1201 stores → 3 sendEvent calls', async () => {
    // Fresh module registry: beforeEach's clearAllMocks wiped the createFunction
    // calls recorded when the file first imported the module.
    vi.resetModules();
    const { inngest } = await import('@api/lib/inngest/client');
    const { FANOUT_BATCH } = await import('@api/lib/inngest/functions/analytics-daily-rollup');
    expect(FANOUT_BATCH).toBe(500);
    const stores = Array.from({ length: 1201 }, (_, i) => ({ id: `s${i}` }));
    const sent: Array<{ id: string; n: number }> = [];
    const step = {
      run: async (_id: string, _fn: () => unknown) => stores,
      sendEvent: async (id: string, events: unknown[]) => {
        sent.push({ id, n: events.length });
      },
    };
    const call = vi
      .mocked(inngest.createFunction)
      .mock.calls.find(c => (c[0] as { id: string }).id === 'analytics-daily-rollup')!;
    const handler = call[1] as unknown as (ctx: unknown) => Promise<unknown>;
    const res = await handler({ step });
    expect(res).toEqual({ stores: 1201 });
    expect(sent).toEqual([
      { id: 'fan-out-0', n: 500 },
      { id: 'fan-out-1', n: 500 },
      { id: 'fan-out-2', n: 201 },
    ]);
  });
});
