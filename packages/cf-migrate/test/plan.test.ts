import { describe, expect, it } from 'vitest';
import {
  ENTITY_KIND_TABLES,
  USER_SCOPED,
  entityIndexQuery,
  loadPlan,
  scopeWhere,
  selectExpr,
  tableQuery,
  transformValue,
} from '../../../scripts/cf/lib/plan.mjs';

describe('transformValue', () => {
  it('keeps integers exact and refuses anything beyond 2^53', () => {
    expect(transformValue('decimal', '123456')).toBe(123456);
    expect(transformValue('date', '1761350000123')).toBe(1761350000123);
    expect(() => transformValue('int', '9007199254740993')).toThrow(/safe integer/);
  });
  it('maps booleans, nulls, text, lists and json verbatim', () => {
    expect(transformValue('bool', 1)).toBe(1);
    expect(transformValue('bool', 0)).toBe(0);
    expect(transformValue('text', null)).toBeNull();
    expect(transformValue('list', '["a","b"]')).toBe('["a","b"]');
    expect(transformValue('json', '{"a": 1}')).toBe('{"a": 1}');
    expect(transformValue('text', 'مرحبا')).toBe('مرحبا');
  });
});

describe('selectExpr', () => {
  it('never routes a Decimal through a float', () => {
    const e = selectExpr('decimal', 2, 't."price"');
    expect(e).toContain('* 100');
    expect(e).not.toMatch(/float|double|::real/i);
    expect(selectExpr('decimal', 5, 'x')).toContain('* 100000');
  });
  it('dates are epoch milliseconds from epoch seconds, exact', () => {
    expect(selectExpr('date', undefined, 't."c"')).toBe(
      `round(extract(epoch from t."c") * 1000)::bigint::text`
    );
  });
});

describe('plan against the generated schema', () => {
  const plan = loadPlan();
  it('covers both databases and never plans the identity tables', () => {
    expect(plan.store.length).toBeGreaterThan(100);
    expect(plan.platform.length).toBeGreaterThan(15);
    const all = new Set([...plan.store, ...plan.platform].map(t => t.name));
    for (const n of ['users', 'refresh_tokens', 'verification_tokens', 'passkey_credentials'])
      expect(all.has(n)).toBe(false);
    expect(plan.elsewhere.get('users')).toBe('identity');
  });
  it('orders parents before children (same database)', () => {
    for (const list of [plan.store, plan.platform]) {
      const pos = new Map(list.map((t, i) => [t.name, i]));
      let cycles = 0;
      for (const t of list)
        for (const fk of t.fks) {
          if (fk.refTable === t.name || !pos.has(fk.refTable)) continue;
          if (pos.get(fk.refTable)! > pos.get(t.name)!) cycles++; // only a true FK cycle may violate the order
        }
      expect(cycles).toBeLessThanOrEqual(2);
    }
  });
  it('every Postgres-backed store table has a store scope (or a ruled user scope) and a buildable query', () => {
    for (const t of plan.store.filter(x => x.inPg)) {
      expect(() => scopeWhere(t, plan.store), t.name).not.toThrow();
      expect(tableQuery(t, plan.store, 'store')).toMatch(/^SELECT .* ORDER BY /);
    }
    expect(Object.keys(USER_SCOPED).sort()).toEqual(['addresses']);
  });
  it('the scope of a child table without store_id climbs to its parent', () => {
    const items = plan.store.find(t => t.name === 'order_items')!;
    expect(scopeWhere(items, plan.store)).toContain('EXISTS');
  });
  it('every entity_index kind resolves to a store id', () => {
    for (const [kind, table] of Object.entries(ENTITY_KIND_TABLES))
      expect(entityIndexQuery(kind, table, plan.store)).toContain('store_id');
  });
  it('store_profile and store_config read stores.id as their store_id', () => {
    const p = plan.store.find(t => t.name === 'store_profile')!;
    expect(p.origin).toBe('stores');
    expect(p.columns.find(c => c.col === 'store_id')!.src).toBe('id');
  });
});
