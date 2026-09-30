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
vi.mock('@force/database', () => ({
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
