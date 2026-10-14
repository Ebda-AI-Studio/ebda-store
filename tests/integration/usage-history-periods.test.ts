/**
 * issue 2329 — /admin/super-admin/usage-history must return the newest
 * `months` DISTINCT periods, whatever the number of stores per period.
 *
 * The period pick used `findMany({ distinct, take })`; where Prisma does not
 * push `DISTINCT ON` down, `take` limits raw rows before the de-dupe and the
 * newest month alone fills it. It is now a `groupBy` (GROUP BY … LIMIT).
 * Real Postgres; per-call unique stores. Periods are placed in a year after
 * every period already in the table, so rows from other tests or an earlier
 * retry attempt cannot be "the newest" (retry-safe).
 */
import { describe, it, expect } from 'vitest';
import { withRlsBypass } from '@ebda/database';
import { loadUsageHistoryRows } from '@api/routes/admin.routes';
import { hasDb, seedBundleStore } from '../helpers/bundle-fixtures';

const uid = () => `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)('usage-history period paging (issue 2329)', () => {
  it('3 stores × 3 months, months=3 → three periods, each with every store', async () => {
    // Strictly newer than any period already in the DB (other fixtures, an
    // earlier attempt of this test under --retry), so "the newest 3" is ours.
    const latest = await withRlsBypass(tx =>
      tx.storeUsageSnapshot.aggregate({ _max: { periodStart: true } })
    );
    const year = Math.max(2900, (latest._max.periodStart?.getUTCFullYear() ?? 0) + 1);
    const periods = [1, 2, 3].map(m => new Date(Date.UTC(year, m - 1, 1)));
    const stores = await Promise.all([0, 1, 2].map(() => seedBundleStore(uid())));
    await withRlsBypass(tx =>
      tx.storeUsageSnapshot.createMany({
        data: stores.flatMap(s =>
          periods.map(periodStart => ({ storeId: s.storeId, periodStart }))
        ),
      })
    );

    const rows = await withRlsBypass(tx => loadUsageHistoryRows(tx, 3)).finally(() =>
      // Leave no far-future period behind for anything else that reads "newest".
      withRlsBypass(tx =>
        tx.storeUsageSnapshot.deleteMany({ where: { storeId: { in: stores.map(s => s.storeId) } } })
      )
    );

    const byPeriod = new Map<string, number>();
    for (const r of rows) {
      const k = r.periodStart.toISOString().slice(0, 10);
      byPeriod.set(k, (byPeriod.get(k) ?? 0) + 1);
    }
    expect([...byPeriod.keys()].sort()).toEqual(
      periods.map(p => p.toISOString().slice(0, 10)).sort()
    );
    for (const n of byPeriod.values()) expect(n).toBe(3);
  });
});
