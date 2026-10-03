/**
 * Issues 2441 / 2442 / 2443 / 2450 / 2451 — the admin list pages whose action handlers used to call a
 * `fetchX()` captured from an old render (old page/filter) and whose responses were not
 * latest-wins. Fixed class: handlers bump a `refreshKey`, the single fetch effect owns every request,
 * and `useLatestRequest` discards a superseded response. Source-level gate (the behaviour is pinned by
 * the colocated `page.test.tsx` next to each page) so a new list cannot reintroduce the shape, plus a
 * repo-wide walk for the standalone `setPage(1)` effect that issue 2436 removed.
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

// [page, the post-action fetchers that must no longer be called directly from a handler]
const PAGES: [string, string[]][] = [
  ['app/stores/[id]/stock/inventory/page.tsx', ['retryProducts']],
  ['app/stores/[id]/affiliates/page.tsx', ['fetchAffiliates']],
  ['app/stores/[id]/loyalty/page.tsx', ['fetchMembers']],
  ['app/stores/[id]/loyalty/transactions/page.tsx', ['fetchTransactions']],
  ['app/stores/[id]/finance/bank-reconciliation/[statementId]/page.tsx', ['fetchStmt']],
  ['app/stores/[id]/stock/warehouses/[warehouseId]/page.tsx', ['loadStock']],
  ['app/stores/[id]/tax/page.tsx', ['fetchRates']],
  ['app/stores/[id]/finance/fx-rates/page.tsx', ['loadRates']],
  ['app/stores/[id]/reviews/page.tsx', ['fetchReviews']],
  ['app/stores/[id]/returns/_hooks/useReturns.ts', ['fetchReturns']],
  ['app/users/page.tsx', ['fetchUsers']],
  ['app/webhook-events/page.tsx', ['fetchEvents']],
];

describe('admin list pages: refetches route through the fetch effect, latest wins', () => {
  for (const [file, fetchers] of PAGES) {
    describe(file, () => {
      const src = read(file);

      it('has a refreshKey and a latest-request guard', () => {
        expect(src).toMatch(/\[refreshKey, setRefreshKey\] = useState\(0\)/);
        expect(src).toMatch(/useLatestRequest\(\)/);
        expect(src).toMatch(/if \(!isLatest\(\)\) return;/);
      });

      it('a handler bumps the key instead of calling the fetcher directly', () => {
        expect(src).toMatch(/setRefreshKey\(k => k \+ 1\)/);
        for (const fn of fetchers) {
          // Allowed callers: the effect body and `useCallback` plumbing, never an `await fn()` /
          // bare statement call inside an async action handler.
          expect(src, `${fn} awaited from a handler`).not.toMatch(new RegExp(`await ${fn}\\(\\)`));
        }
      });
    });
  }

  it('bank statement detail guards the statement fetch with its OWN sequence, not the transactions one (issue 2442)', () => {
    const src = read('app/stores/[id]/finance/bank-reconciliation/[statementId]/page.tsx');
    expect(src).toMatch(/const beginStmtRequest = useLatestRequest\(\)/);
    expect(src).toMatch(/const beginTxRequest = useLatestRequest\(\)/);
    expect(src).toMatch(/const isLatest = beginStmtRequest\(\)/);
  });

  it('no admin source resets the page in a standalone effect keyed on the filter (issue 2436 class)', () => {
    const offenders = walk(ADMIN)
      .filter(f =>
        /useEffect\(\(\) => \{\s*set\w*Page\(1\);?\s*\}, \[[^\]]*\]\)/.test(readFileSync(f, 'utf8'))
      )
      .map(f => f.slice(ADMIN.length + 1));
    expect(offenders).toEqual([]);
  });

  it('inventory resets the page in the search handler (issue 2441)', () => {
    expect(read('app/stores/[id]/stock/inventory/page.tsx')).toMatch(
      /setSearch\(value\);\s*setCurrentPage\(1\);/
    );
  });
});
