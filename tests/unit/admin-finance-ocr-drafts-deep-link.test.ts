/**
 * Issue 2404: the finance dashboard's "Pending receipt drafts (any date)" card
 * counts `status=draft&hasOcr=true` over ALL dates, but its "View all" link
 * landed on an expenses list scoped to this month with no receipt filter, so a
 * card that said 3 could open onto an empty page. The link must carry every
 * filter the card's count query used, and the destination must honour them.
 * Source-level, like the other admin page guards here (no jsdom in this repo).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FINANCE = resolve(__dirname, '../../apps/admin/src/app/stores/[id]/finance');
const dashboard = readFileSync(resolve(FINANCE, 'dashboard/page.tsx'), 'utf8');
const expenses = readFileSync(resolve(FINANCE, 'expenses/page.tsx'), 'utf8');

/** Filter keys (not paging) in the card's count query. */
function cardFilters(): string[] {
  const m = dashboard.match(/\/expenses\?([^`]*perPage=1[^`]*)`/);
  expect(m, 'pending OCR count query not found').not.toBeNull();
  return m![1]
    .split('&')
    .map(kv => kv.split('=')[0])
    .filter(k => k !== 'perPage' && k !== 'page');
}

function viewAllLink(): string {
  const m = dashboard.match(
    /router\.push\(`\/stores\/\$\{storeId\}\/finance\/expenses\?([^`]*)`\)/
  );
  expect(m, 'expenses View-all link not found').not.toBeNull();
  return m![1];
}

describe('pending receipt drafts card and its View-all link agree (issue 2404)', () => {
  it('the link carries every filter the card counted', () => {
    const linkKeys = viewAllLink()
      .split('&')
      .map(kv => kv.split('=')[0]);
    for (const key of cardFilters()) expect(linkKeys).toContain(key);
  });

  it('the expenses page reads hasOcr from the query string and forwards it', () => {
    expect(expenses).toMatch(/searchParams\?\.get\('hasOcr'\)/);
    expect(expenses).toMatch(/qs\.set\('hasOcr', 'true'\)/);
  });

  it('receipt-only mode does not apply the month window the card never had', () => {
    const branch = expenses.slice(expenses.indexOf('if (receiptOnly)'));
    const receiptBranch = branch.slice(0, branch.indexOf('} else {'));
    expect(receiptBranch).not.toMatch(/'from'|'to'/);
    expect(expenses).toMatch(/\{receiptOnly \? \(/); // visible chip, not hidden state
  });
});
