import { describe, expect, it } from 'vitest';
import { loadPlan } from '../../../scripts/cf/lib/plan.mjs';
import { ReplayOwnershipError, replayTable } from '../../../scripts/cf/lib/replay.mjs';

// The rollback replay runs with owner privileges (no RLS). These tests pin its store fence: a DO row that
// claims another store aborts the replay before any write, and every write must hit exactly one owned row.
const plan = loadPlan();
const cats = plan.store.find(t => t.name === 'categories')!;
const items = plan.store.find(t => t.name === 'order_items')!;
const types = { get: () => ({ udt_name: 'text', data_type: 'text' }) } as unknown as Map<
  string,
  { udt_name: string; data_type: string }
>;
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ctxFor = (storeId: string | null) => ({ storeId, allowed: new Set([A, B]), all: plan.store });

function fakeClient(rowCount = 1, ownerStore: string | null = A) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      // the in-transaction ownership lookup (SELECT <store col> AS store ...) returns the row's real store
      if (/AS store FROM/.test(sql))
        return { rowCount: ownerStore === undefined ? 0 : 1, rows: [{ store: ownerStore }] };
      return { rowCount, rows: [] };
    },
  };
}
const diff = (
  table: typeof cats,
  rows: Partial<Record<string, unknown>>[],
  extra: Record<string, unknown[][]> = {}
) => {
  const columns = table.columns.map(c => c.col);
  return {
    columns,
    pk: table.pk,
    added: rows.map(r => columns.map(c => (r[c] === undefined ? null : r[c]))),
    changed: [] as unknown[][],
    deleted: [] as unknown[][],
    ...extra,
  };
};

describe('replayTable store fence', () => {
  it('aborts BEFORE any write when a DO row claims another store', async () => {
    const c = fakeClient();
    const d = diff(cats, [{ id: 'x1', store_id: B, name: 'stolen', slug: 'stolen' }]);
    await expect(replayTable(c, types, cats, d, 'upsert', ctxFor(A))).rejects.toThrow(
      ReplayOwnershipError
    );
    expect(c.calls).toHaveLength(0);
  });

  it('aborts when a D1 row names a store that is not being rolled back', async () => {
    const c = fakeClient();
    const d = diff(cats, [
      { id: 'x1', store_id: 'cccccccc-0000-0000-0000-000000000003', name: 'n', slug: 's' },
    ]);
    await expect(replayTable(c, types, cats, d, 'upsert', ctxFor(null))).rejects.toThrow(
      /not one of the stores/
    );
    expect(c.calls).toHaveLength(0);
  });

  it('fences the upsert with the ownership predicate and reads the row back', async () => {
    const c = fakeClient();
    await replayTable(
      c,
      types,
      cats,
      diff(cats, [{ id: 'x1', store_id: A, name: 'n', slug: 's' }]),
      'upsert',
      ctxFor(A)
    );
    expect(c.calls[0].sql).toMatch(
      /ON CONFLICT .* DO UPDATE SET .* WHERE "categories"\.store_id = \$\d+/
    );
    expect(c.calls[0].params.at(-1)).toBe(A);
    expect(c.calls[1].sql).toMatch(
      /^SELECT 1 FROM "categories" WHERE .* AND "categories"\.store_id = \$\d+/
    );
  });

  it('aborts when the upsert hits an existing row of another store (0 rows affected)', async () => {
    const c = fakeClient(0);
    await expect(
      replayTable(
        c,
        types,
        cats,
        diff(cats, [{ id: 'x1', store_id: A, name: 'n', slug: 's' }]),
        'upsert',
        ctxFor(A)
      )
    ).rejects.toThrow(/exactly 1 row/);
  });

  it('looks up the real store of a row before deleting it and binds the delete to the allowed stores', async () => {
    const ok = fakeClient(1);
    await replayTable(ok, types, cats, diff(cats, [], { deleted: [['x1']] }), 'delete', ctxFor(A));
    expect(ok.calls[0].sql).toMatch(
      /^SELECT "store_id"::text AS store FROM "categories" WHERE "id" = \$1::"text"/
    );
    expect(ok.calls[1].sql).toMatch(
      /^DELETE FROM "categories" WHERE "id" = \$1::"text" AND "store_id"::text = ANY\(\$2::text\[\]\)/
    );
    expect(ok.calls[1].params).toEqual(['x1', [A]]);
    await expect(
      replayTable(
        fakeClient(0),
        types,
        cats,
        diff(cats, [], { deleted: [['x1']] }),
        'delete',
        ctxFor(A)
      )
    ).rejects.toThrow(/exactly 1 row/);
    await expect(
      replayTable(
        fakeClient(2),
        types,
        cats,
        diff(cats, [], { deleted: [['x1']] }),
        'delete',
        ctxFor(A)
      )
    ).rejects.toThrow(/exactly 1 row/);
  });

  it('D1 delete: a key whose real row belongs to a store NOT being rolled back aborts without deleting', async () => {
    const c = fakeClient(1, 'cccccccc-0000-0000-0000-000000000003');
    await expect(
      replayTable(c, types, cats, diff(cats, [], { deleted: [['x1']] }), 'delete', ctxFor(null))
    ).rejects.toThrow(/not being rolled back/);
    expect(c.calls.some(x => /^DELETE/.test(x.sql))).toBe(false);
  });

  it('D1 delete: a row owned by an allowed store is deleted with the allowed list; a NULL store aborts', async () => {
    const ok = fakeClient(1, B);
    await replayTable(
      ok,
      types,
      cats,
      diff(cats, [], { deleted: [['x1']] }),
      'delete',
      ctxFor(null)
    );
    expect(ok.calls[1].params[1]).toEqual([A, B]);
    const nul = fakeClient(1, null);
    await expect(
      replayTable(nul, types, cats, diff(cats, [], { deleted: [['x1']] }), 'delete', ctxFor(null))
    ).rejects.toThrow(/NULL store claim/);
    expect(nul.calls.some(x => /^DELETE/.test(x.sql))).toBe(false);
  });

  it('DO delete: a row owned by another store than the one replayed aborts', async () => {
    const c = fakeClient(1, B);
    await expect(
      replayTable(c, types, cats, diff(cats, [], { deleted: [['x1']] }), 'delete', ctxFor(A))
    ).rejects.toThrow(/belongs to store/);
    expect(c.calls.some(x => /^DELETE/.test(x.sql))).toBe(false);
  });

  it('rejects an upsert row that carries a NULL store claim on a store-scoped table', async () => {
    const c = fakeClient();
    await expect(
      replayTable(
        c,
        types,
        cats,
        diff(cats, [{ id: 'x1', store_id: null, name: 'n', slug: 's' }]),
        'upsert',
        ctxFor(A)
      )
    ).rejects.toThrow(/NULL store claim/);
    expect(c.calls).toHaveLength(0);
  });

  it('a child table without store_id is fenced through its parent chain', async () => {
    const c = fakeClient();
    await replayTable(c, types, items, diff(items, [], { deleted: [['i1']] }), 'delete', ctxFor(A));
    expect(c.calls[0].sql).toMatch(/AND EXISTS \(SELECT 1 FROM "orders"/);
    expect(c.calls[0].params.at(-1)).toBe(A);
  });
});

describe('replayTable without a fence', () => {
  it('refuses to run when the store fence is not configured', async () => {
    const c = fakeClient();
    const d = diff(cats, [{ id: 'x1', store_id: A, name: 'n', slug: 's' }]);
    await expect(replayTable(c, types, cats, d, 'upsert', undefined as never)).rejects.toThrow(
      /without a store fence/
    );
    await expect(
      replayTable(c, types, cats, d, 'upsert', { allowed: new Set(), all: [] } as never)
    ).rejects.toThrow(/without a store fence/);
    expect(c.calls).toHaveLength(0);
  });
});
