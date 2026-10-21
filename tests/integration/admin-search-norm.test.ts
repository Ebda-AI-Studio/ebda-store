/**
 * Search P2 Task 15: the digit/name normalisation functions and the four expression indexes behind
 * the admin customer + order search (migration 20261027000100). That the indexes are USED as
 * `ebda_app` (RLS makes an inline predicate unable to) is proven in customers-search-sql.test.ts,
 * which reads each index's scan counter through the app-role planner after the production lookup.
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const INDEXES = [
  'users_phone_digits_trgm_idx',
  'users_name_norm_trgm_idx',
  'orders_guest_phone_digits_trgm_idx',
  'orders_guest_name_norm_trgm_idx',
  'orders_guest_email_store_trgm_idx',
];

describe.skipIf(!hasDb)('admin search normalisation (Task 15)', () => {
  it('ebda_digits folds Arabic-Indic and Persian digits and drops everything else', async () => {
    const [r] = await prisma.$queryRaw<Array<{ a: string; b: string; c: string | null }>>`
      SELECT public.ebda_digits('+20 ١٠١-234') AS a,
             public.ebda_digits('۰۱۰ 1234 (x)') AS b,
             public.ebda_digits(NULL) AS c`;
    expect(r).toEqual({ a: '20101234', b: '0101234', c: null });
  });

  it('all five indexes exist, are VALID and are GIN trigram expression indexes', async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; valid: boolean; def: string }>>`
      SELECT c.relname::text AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ANY(${INDEXES}) ORDER BY 1`;
    expect(rows.map(r => r.name)).toEqual([...INDEXES].sort());
    for (const r of rows) {
      expect(r.valid, r.name).toBe(true);
      expect(r.def).toMatch(/USING gin/);
      expect(r.def).toMatch(/gin_trgm_ops/);
      if (!r.name.includes('email')) expect(r.def).toMatch(/ebda_(digits|ar_norm)\(/);
    }
    const guest = rows.filter(r => r.name.startsWith('orders_guest_'));
    for (const r of guest) {
      expect(r.def).toMatch(/WHERE .*customer_id IS NULL/);
      // store-leading (btree_gin): a search is for one store (Ruling SEARCH-P2-8)
      expect(r.def, r.name).toMatch(/USING gin \(store_id, /);
    }
  });

  it('the normalised name matches the way the search sees it', async () => {
    const [r] = await prisma.$queryRaw<Array<{ n: string }>>`
      SELECT public.ebda_ar_norm(coalesce('أحمد', '') || ' ' || coalesce(NULL::text, '')) AS n`;
    expect(r.n).toBe('احمد');
  });
});
