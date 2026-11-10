import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyOrphans, rlsBypassRunner } from '../../scripts/r2-orphan-audit';
import {
  R2_REFERENCE_COLUMNS,
  assertStrictTablesVisible,
  STRICT_R2_TABLES,
} from '../../apps/api/src/lib/r2-references';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const HOUR = 3600_000;
const obj = (key: string, size = 100, agoMs?: number) => ({
  key,
  size,
  lastModified: agoMs === undefined ? undefined : new Date(NOW - agoMs),
});

describe('classifyOrphans — the R2 delete guard', () => {
  it('treats referenced keys as not-orphans regardless of age', () => {
    const r = classifyOrphans([obj('a', 10, 99 * HOUR)], new Set(['a']), 24 * HOUR, NOW);
    expect(r.orphans).toEqual([]);
    expect(r.totalBytes).toBe(10);
    expect(r.orphanBytes).toBe(0);
  });

  it('marks an old unreferenced key as an orphan', () => {
    const r = classifyOrphans([obj('a', 10, 99 * HOUR)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual(['a']);
    expect(r.orphanBytes).toBe(10);
  });

  it('SKIPS a freshly-uploaded unreferenced key — the data-loss guard', () => {
    // A file PUT to R2 whose DB row has not landed yet. Deleting it is the
    // failure mode that may have produced Demo Boutique's missing covers.
    const r = classifyOrphans([obj('fresh', 10, 1 * HOUR)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual([]);
    expect(r.skippedRecent).toBe(1);
  });

  it('is exclusive at the boundary — exactly minAge is old enough', () => {
    const r = classifyOrphans([obj('edge', 10, 24 * HOUR)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual(['edge']);
    expect(r.skippedRecent).toBe(0);
  });

  it('treats a missing lastModified as infinitely old (deletable)', () => {
    const r = classifyOrphans([obj('nodate', 10, undefined)], new Set(), 24 * HOUR, NOW);
    expect(r.orphans).toEqual(['nodate']);
  });

  it('totals bytes across every object, orphan or not', () => {
    const r = classifyOrphans(
      [obj('keep', 5, 99 * HOUR), obj('drop', 7, 99 * HOUR), obj('fresh', 3, 0)],
      new Set(['keep']),
      24 * HOUR,
      NOW
    );
    expect(r.totalBytes).toBe(15);
    expect(r.orphanBytes).toBe(7);
    expect(r.orphans).toEqual(['drop']);
    expect(r.skippedRecent).toBe(1);
  });

  it('handles an empty bucket', () => {
    expect(classifyOrphans([], new Set(), 24 * HOUR, NOW)).toEqual({
      orphans: [],
      orphanBytes: 0,
      totalBytes: 0,
      skippedRecent: 0,
    });
  });
});

// Issue 2251: this bulk-delete collector (the sweep is the other) read the registry with a bare
// client. Under ebda_app a contextless read of a STRICT table returns [] and
// `--apply` would delete every file those rows reference.
describe('r2-orphan-audit reads the registry as an owner-role connection (issue 2251)', () => {
  it('the runner runs the read inside one transaction and sets no bypass GUC (the role itself bypasses RLS)', async () => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
        calls.push(strings.join('?'));
        return 0;
      }),
      $queryRawUnsafe: vi.fn(async () => {
        calls.push('READ');
        return [];
      }),
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run = rlsBypassRunner(prisma as any);
    await run(db => db.$queryRawUnsafe('SELECT 1'));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Ebda has no `app.bypass_rls`: nothing is set, the read is the first and only statement.
    expect(calls).toEqual(['READ']);
  });

  it('the audit collects through that runner, never a bare client', () => {
    const src = readFileSync(path.resolve(__dirname, '../../scripts/r2-orphan-audit.ts'), 'utf8');
    expect(src).toMatch(/const run = rlsBypassRunner\(prisma\)/);
    expect(src).not.toMatch(/run: fn => fn\(prisma\)/);
    // That the visibility guard runs in front of the delete is a behaviour test: tests/unit/r2-orphan-delete-guard.test.ts.
  });

  it('STRICT_R2_TABLES is exactly the registry tables on the pinned STRICT list', () => {
    // Every table with a store_id column is under strict, forced RLS now (migration
    // 20261004000000_ebda_strict_rls lists them in its header). The guard probes four of them:
    // each must be a registry table AND on that list, so the probe can never name a table that is
    // not actually RLS-protected.
    const migration = readFileSync(
      path.resolve(
        __dirname,
        '../../packages/database/prisma/migrations/20261004000000_ebda_strict_rls/migration.sql'
      ),
      'utf8'
    );
    const registry = new Set(R2_REFERENCE_COLUMNS.map(c => c.table));
    expect(STRICT_R2_TABLES.length).toBeGreaterThan(0);
    for (const t of STRICT_R2_TABLES) {
      expect(registry.has(t), `${t} is in the R2 registry`).toBe(true);
      expect(migration, `${t} is under strict RLS in the migration`).toMatch(
        new RegExp(`(^|[^a-z_])${t}([^a-z_]|$)`)
      );
    }
  });

  // Collector (through the bypass runner) sees `seen` rows; the catalog reports
  // `reltuples` / `live` after the guard's ANALYZE.
  const collector = (seen: number) =>
    (async (fn: (db: unknown) => Promise<unknown>) =>
      fn({ $queryRawUnsafe: async () => [{ n: seen }] })) as never;
  const catalog = (reltuples: number, live = 0, analyze: () => Promise<number> = async () => 0) => {
    const calls: string[] = [];
    return {
      calls,
      db: {
        $executeRawUnsafe: async (sql: string) => {
          calls.push(sql);
          return analyze();
        },
        $queryRawUnsafe: async () => [{ reltuples, live }],
      } as never,
    };
  };

  it('refuses when a STRICT table is invisible to the collector but non-empty in the catalog', async () => {
    await expect(assertStrictTablesVisible(collector(0), catalog(42).db)).rejects.toThrow(
      /REFUSING: "blog_posts" shows 0 rows.*reltuples 42/
    );
  });

  it('refuses on the stats collector alone (reltuples 0 but n_live_tup > 0)', async () => {
    await expect(assertStrictTablesVisible(collector(0), catalog(0, 7).db)).rejects.toThrow(
      /n_live_tup 7/
    );
  });

  it('issue 2288: refuses when the catalog estimate is UNKNOWN (-1, never analyzed) — it used to pass', async () => {
    await expect(assertStrictTablesVisible(collector(0), catalog(-1).db)).rejects.toThrow(
      /cannot say whether it is empty \(reltuples -1/
    );
  });

  it('issue 2288: an ANALYZE that fails (not the owner) still refuses on an unknown estimate', async () => {
    const c = catalog(-1, 0, async () => {
      throw new Error('must be owner of table blog_posts');
    });
    await expect(assertStrictTablesVisible(collector(0), c.db)).rejects.toThrow(/REFUSING/);
  });

  it('ANALYZEs a table before trusting its estimate, and only when the collector saw nothing', async () => {
    const empty = catalog(0);
    await expect(assertStrictTablesVisible(collector(0), empty.db)).resolves.toBeUndefined();
    expect(empty.calls).toEqual(STRICT_R2_TABLES.map(t => `ANALYZE "${t}"`));
    const seeing = catalog(-1);
    await expect(assertStrictTablesVisible(collector(5), seeing.db)).resolves.toBeUndefined();
    expect(seeing.calls).toEqual([]);
  });

  // Issue 2354: after the ebda_app cutover the role cannot ANALYZE (not the
  // owner) and a never-populated table stays reltuples -1 forever. A bypass
  // proven through the SAME runner makes a 0 a real 0.
  const bypassCollector = (seen: number, bypass: string | boolean | null) =>
    (async (fn: (db: unknown) => Promise<unknown>) =>
      fn({
        $queryRawUnsafe: async (sql: string) =>
          /rolbypassrls/.test(sql)
            ? [{ bypass: bypass === 'true' || bypass === true }]
            : [{ n: seen }],
      })) as never;

  it('issue 2354: UNKNOWN (-1) passes when the runner proves the role bypasses RLS', async () => {
    const notOwner = catalog(-1, 0, async () => 0); // ANALYZE skipped (WARNING), stays -1
    await expect(
      assertStrictTablesVisible(bypassCollector(0, 'true'), notOwner.db)
    ).resolves.toBeUndefined();
  });

  it('issue 2354: UNKNOWN still refuses when the bypass is NOT proven', async () => {
    for (const bypass of [null, '', 'false']) {
      await expect(
        assertStrictTablesVisible(bypassCollector(0, bypass), catalog(-1).db)
      ).rejects.toThrow(/did not prove that the\s+connection role bypasses RLS|did not prove/);
    }
  });

  it('issue 2354: positive catalog evidence still refuses even with the bypass proven', async () => {
    await expect(
      assertStrictTablesVisible(bypassCollector(0, 'true'), catalog(42).db)
    ).rejects.toThrow(/reltuples 42/);
    await expect(
      assertStrictTablesVisible(bypassCollector(0, 'true'), catalog(0, 3).db)
    ).rejects.toThrow(/n_live_tup 3/);
  });

  it('issue 2354: --force-report prints a refused dry run, never a refused --apply', async () => {
    const { guardForAudit } = await import('../../scripts/r2-orphan-audit');
    const refuse = async () => {
      throw new Error('REFUSING: x');
    };
    await expect(guardForAudit(refuse, { apply: false, forceReport: true })).resolves.toBe(
      'REFUSING: x'
    );
    await expect(guardForAudit(refuse, { apply: true, forceReport: true })).rejects.toThrow(
      /REFUSING/
    );
    await expect(guardForAudit(refuse, { apply: false, forceReport: false })).rejects.toThrow(
      /REFUSING/
    );
    await expect(
      guardForAudit(async () => undefined, { apply: true, forceReport: false })
    ).resolves.toBeNull();
  });

  // The dry run validating the report too, and the Inngest sweep running the same guard before deleting, are behaviour
  // tests: tests/unit/r2-orphan-delete-guard.test.ts.
});
