import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';

const read = (p: string) => readFileSync(p, 'utf8');

describe('STORE-QA-9 stock value zero with stock on hand explains itself', () => {
  it('the dashboard shows a cost-price hint (ar + en) when value is 0 and SKUs are on hand', () => {
    const src = read('apps/admin/src/app/stores/[id]/stock/dashboard/page.tsx');
    expect(src).toMatch(/dashboard\.stockValue === 0 && \(onHandCount \?\? 0\) > 0/);
    expect(ar.stock.dashboard.stockValueNoCost).toMatch(/التكلفة/);
    expect(en.stock.dashboard.stockValueNoCost).toMatch(/cost/);
  });
});

describe('STORE-QA-11 finance accounts name one language', () => {
  it('the cash table no longer prints "English— Arabic" together', () => {
    const src = read('apps/admin/src/app/stores/[id]/finance/dashboard/page.tsx');
    expect(src).not.toMatch(/— \{row\.nameAr\}/);
    expect(src).toContain("adminLocale === 'ar' && row.nameAr");
  });
});

describe('STORE-QA-6 never-signed-in users', () => {
  it('reads as a state, not an absolute', () => {
    expect(JSON.stringify(ar)).not.toContain('"neverLoggedIn": "أبدًا"');
  });
});
