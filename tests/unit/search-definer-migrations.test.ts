/**
 * Source pins for the two search definers (migrations 20261024000300 / 20261024000500). Their
 * behaviour is proven against Postgres in tests/integration/search-lexical-rls-index.test.ts and
 * search-definer-authz.test.ts; these cheap pins keep the review fixes from being edited away
 * where no database is available.
 *  - M-2: the super-admin arm of the `customers` visibility predicate is wrapped as
 *    `(SELECT ...)` like the `users` policy, so it is a once-per-statement initplan, not a call per
 *    candidate row.
 *  - I-1: word-start mode (a query of words under 3 characters) also matches a word that follows
 *    the Arabic prefixes `ا` / `ال`, and a word that follows punctuation, all on the same GIN index.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mig = (n: string) =>
  fs.readFileSync(
    path.resolve(__dirname, `../../packages/database/prisma/migrations/${n}/migration.sql`),
    'utf8'
  );

describe('search definer migrations (review fixes)', () => {
  it('M-2: the super-admin arm is an initplan, never a bare per-row call', () => {
    const sql = mig('20261024000500_order_customer_search_ids');
    expect(sql).toContain('OR (SELECT public.ebda_is_super_admin())');
    expect(sql).not.toMatch(/OR public\.ebda_is_super_admin\(\)/);
  });

  it('I-1: word-start mode lists the Arabic-prefix and punctuation boundaries', () => {
    const sql = mig('20261024000300_search_ids_definer');
    const m = /v_bounds text\[\] := ARRAY\[([^\]]*)\]/.exec(sql);
    expect(m, 'v_bounds array not found').not.toBeNull();
    const bounds = [...m![1].matchAll(/'([^']*)'/g)].map(x => x[1]);
    for (const required of [
      '', // starts the document
      '% ', // after a space
      '%/', // S/XL
      '%(', // (XL)
      '%-',
      '%,',
      '%.',
      'ا', // أرز folds to ارز: one-letter prefix
      '% ا',
      'ال', // الرز, القط
      '% ال',
    ])
      expect(bounds, `boundary ${JSON.stringify(required)}`).toContain(required);
  });
});
