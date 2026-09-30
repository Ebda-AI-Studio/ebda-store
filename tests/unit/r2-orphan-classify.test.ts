import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  classifyOrphans,
  rlsBypassRunner,
  assertStrictTablesVisible,
  STRICT_R2_TABLES,
} from '../../scripts/r2-orphan-audit';
import { R2_REFERENCE_COLUMNS } from '../../apps/api/src/lib/r2-references';

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
    // failure mode that may have produced Palora's missing covers.
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

// Issue 2251: the only delete-capable collector read the registry with a bare
// client. Under force_app a contextless read of a STRICT table returns [] and
// `--apply` would delete every file those rows reference.
describe('r2-orphan-audit reads the registry with the RLS bypass (issue 2251)', () => {
  it('the runner sets app.bypass_rls BEFORE running the read, inside one transaction', async () => {
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
    expect(calls[0]).toMatch(/SET LOCAL app\.bypass_rls = 'true'/);
    expect(calls.indexOf('READ')).toBeGreaterThan(0);
  });

  it('the audit collects through that runner, never a bare client', () => {
    const src = readFileSync(path.resolve(__dirname, '../../scripts/r2-orphan-audit.ts'), 'utf8');
    expect(src).toMatch(/const run = rlsBypassRunner\(prisma\)/);
    expect(src).not.toMatch(/run: fn => fn\(prisma\)/);
    // The visibility guard sits in front of the delete.
    expect(src.indexOf('await assertStrictTablesVisible(run, prisma)')).toBeLessThan(
      src.indexOf('await deleteKeysInBatches(')
    );
  });

  it('STRICT_R2_TABLES is exactly the registry tables on the pinned STRICT list', () => {
    const rls = readFileSync(
      path.resolve(__dirname, '../../tests/integration/rls-force-app.test.ts'),
      'utf8'
    );
    const block = rls.slice(
      rls.indexOf('const STRICT_TABLES = ['),
      rls.indexOf('];', rls.indexOf('const STRICT_TABLES = ['))
    );
    const strict = new Set([...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
    expect(strict.size).toBeGreaterThan(10);
    const registry = new Set(R2_REFERENCE_COLUMNS.map(c => c.table));
    const expected = [...registry].filter(t => strict.has(t)).sort();
    expect([...STRICT_R2_TABLES].sort()).toEqual(expected);
  });

  it('refuses --apply when a STRICT table is invisible to the collector but non-empty in the catalog', async () => {
    const run = (async (fn: (db: unknown) => Promise<unknown>) =>
      fn({ $queryRawUnsafe: async () => [{ n: 0 }] })) as never;
    const catalog = { $queryRawUnsafe: async () => [{ n: 42 }] } as never;
    await expect(assertStrictTablesVisible(run, catalog)).rejects.toThrow(/REFUSING --apply/);
  });

  it('allows --apply when the collector sees rows, or the table is genuinely empty', async () => {
    const seeing = (async (fn: (db: unknown) => Promise<unknown>) =>
      fn({ $queryRawUnsafe: async () => [{ n: 5 }] })) as never;
    const empty = (async (fn: (db: unknown) => Promise<unknown>) =>
      fn({ $queryRawUnsafe: async () => [{ n: 0 }] })) as never;
    await expect(
      assertStrictTablesVisible(seeing, { $queryRawUnsafe: async () => [{ n: 5 }] } as never)
    ).resolves.toBeUndefined();
    await expect(
      assertStrictTablesVisible(empty, { $queryRawUnsafe: async () => [{ n: 0 }] } as never)
    ).resolves.toBeUndefined();
  });
});
