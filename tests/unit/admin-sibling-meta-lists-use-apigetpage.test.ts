/**
 * Issue 2430 — five API routes answer the sibling `{ data, meta }` shape that `apiGet` silently
 * flattens (it keeps `data`, drops `meta`), so a list capped at perPage rows says nothing about the
 * rows beyond it. Issue 2417 fixed `/expenses`; this closes the class for the other four list
 * routes: `/finance/journal`, `/finance/bank-statements`, `/finance/bank-statements/:sid/transactions`
 * and `/purchase-orders`. Source-level, like the other admin page guards here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ADMIN = resolve(__dirname, '../../apps/admin/src');
const read = (p: string) => readFileSync(resolve(ADMIN, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

// A list GET on one of the `{ data, meta }` routes: the URL ends at the route (optionally `?query`).
const SIBLING_LIST =
  /apiGet(?:<[^>(]*>)?\(\s*[`'"][^`'"]*\/(?:expenses|finance\/journal|finance\/bank-statements|finance\/bank-statements\/\$\{[^}]+\}\/transactions|purchase-orders)(?:\?[^`'"]*)?[`'"]/;

// Reads ONE row (`perPage=1`) and never shows a count, so it has no use for `meta`: the OCR
// upload poll looking for the draft it just created.
const ALLOWED = ['app/stores/[id]/finance/expenses/new/page.tsx'];

describe('no admin page reads a { data, meta } list through apiGet (issue 2430)', () => {
  it('every admin source file reaches those routes through apiGetPage', () => {
    const offenders = walk(ADMIN)
      .filter(f => SIBLING_LIST.test(readFileSync(f, 'utf8')))
      .map(f => f.slice(ADMIN.length + 1))
      .filter(f => !ALLOWED.includes(f));
    expect(offenders).toEqual([]);
  });

  it('the guard regex does catch the shape it forbids', () => {
    expect(
      SIBLING_LIST.test('apiGet<X[]>(`/api/v1/stores/${id}/purchase-orders?perPage=50`)')
    ).toBe(true);
    expect(
      SIBLING_LIST.test('apiGetPage<X>(`/api/v1/stores/${id}/purchase-orders?perPage=50`)')
    ).toBe(false);
  });
});

describe('each page shows the real total and pages through the rest (issue 2430)', () => {
  const pages: [string, string][] = [
    ['journal', 'app/stores/[id]/finance/journal/page.tsx'],
    ['bank statements', 'app/stores/[id]/finance/bank-reconciliation/page.tsx'],
    ['bank transactions', 'app/stores/[id]/finance/bank-reconciliation/[statementId]/page.tsx'],
    ['purchase orders', 'app/stores/[id]/stock/purchase-orders/page.tsx'],
  ];
  for (const [name, file] of pages) {
    it(`${name}: reads meta, sends the page, renders the pager`, () => {
      const src = read(file);
      expect(src).toMatch(/apiGetPage</);
      expect(src).toMatch(/&?page=\$\{(?:tx)?[pP]age\}|set\('page'|page: String\(page\)/);
      expect(src).toMatch(/<PageControls meta=\{\w+\} onPageChange=\{set\w*Page\} \/>/);
      expect(src).toMatch(/totalCount/);
    });
  }

  it('the stale "needs a raw-response variant of apiGet" TODOs are gone', () => {
    for (const [, file] of pages) {
      expect(read(file)).not.toMatch(/not recoverable through apiGet|raw-response variant/);
    }
  });

  it('purchase-order search is server-side (no client filter over the first page)', () => {
    const src = read('app/stores/[id]/stock/purchase-orders/page.tsx');
    expect(src).toMatch(/qs\.set\('q'/);
    expect(src).not.toMatch(/orders\.filter\(/);
  });

  it('a new journal window / PO search / tx filter / expenses filter restarts on page 1 in the SAME handler (issue 2436)', () => {
    // A separate `setPage(1)` effect runs AFTER the fetch effect of the same commit, so the fetch
    // reads the stale page and a second request follows. The reset rides the change handler.
    const journal = read('app/stores/[id]/finance/journal/page.tsx');
    expect(journal).toMatch(/setCustomRange\(c\);[^}]*setPage\(1\);/);
    expect(journal).not.toMatch(/setPage\(1\);\s*\}, \[period, customRange\]\)/);
    const po = read('app/stores/[id]/stock/purchase-orders/page.tsx');
    expect(po).toMatch(/setSearch\(value\);[^}]*setPage\(1\);/);
    expect(po).not.toMatch(/setPage\(1\);\s*\}, \[search\]\)/);
    const exp = read('app/stores/[id]/finance/expenses/page.tsx');
    expect(exp.match(/setPage\(1\)/g)?.length).toBe(3);
    expect(exp).not.toMatch(/setPage\(1\);\s*\}, \[period/);
    expect(read('app/stores/[id]/finance/bank-reconciliation/[statementId]/page.tsx')).toMatch(
      /setTxPage\(1\)/
    );
  });

  it('every converted list fetch is latest-request-wins (issue 2436)', () => {
    for (const [name, file] of pages) {
      const src = read(file);
      if (name === 'purchase orders') {
        // guards through the effect cleanup instead of the shared hook
        expect(src).toMatch(/let stale = false;/);
        expect(src).toMatch(/return \(\) => \{\s*stale = true;/);
        expect(src).toMatch(/if \(stale\) return;/);
      } else {
        expect(src).toMatch(/useLatestRequest\(\)/);
        expect(src).toMatch(/if \(!isLatest\(\)\) return;/);
      }
    }
  });
});
