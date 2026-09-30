/**
 * Issue #1933 — the AI narration label was translated in some insights
 * pages but the body was always rendered as `data.narration.en`,
 * regardless of the admin's active locale (and cohorts/funnel didn't even
 * translate the label — a hardcoded `AI:` literal). Static source scan
 * (same pattern as customer-page-refund-column-not-badge.test.ts) because
 * a full render test would have to stub next-intl + fetch just to reach a
 * JSX expression.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const PAGES = ['segments', 'dashboard', 'cohorts', 'funnel'] as const;

function pagePath(name: (typeof PAGES)[number]): string {
  return join(process.cwd(), `apps/admin/src/app/stores/[id]/insights/${name}/page.tsx`);
}

describe('insights pages render the locale-matched AI narration', () => {
  for (const page of PAGES) {
    it(`${page}/page.tsx uses pickNarration(...) instead of hardcoding .narration.en`, () => {
      const source = readFileSync(pagePath(page), 'utf8');
      expect(source).toContain("from '@/i18n/narration'");
      expect(source).toContain('pickNarration(');
      // The only place `.narration.en`/`.narration?.en` may still appear is
      // inside the pickNarration helper's own internal fallback — which
      // lives in a different file — so the page source itself must have
      // NO direct narration.en/ narration?.en reference left.
      expect(source).not.toMatch(/narration\??\.en\b/);
    });

    it(`${page}/page.tsx reads the active locale via next-intl's useLocale`, () => {
      const source = readFileSync(pagePath(page), 'utf8');
      expect(source).toContain("useLocale } from 'next-intl'");
      expect(source).toMatch(/const locale = useLocale\(\)/);
    });
  }

  it('cohorts and funnel translate the AI label too (no hardcoded "AI:" literal)', () => {
    for (const page of ['cohorts', 'funnel'] as const) {
      const source = readFileSync(pagePath(page), 'utf8');
      expect(source).not.toContain('font-semibold text-primary">AI:<');
      expect(source).toContain("t('aiLabel')");
    }
  });
});

describe('cohorts retention matrix is a genuine grid, not card-stacked (#1966)', () => {
  it('renders an isolated horizontal-scroll <table> with a sticky first column', () => {
    const source = readFileSync(pagePath('cohorts'), 'utf8');
    expect(source).toMatch(/<table className="min-w-max/);
    expect(source).toMatch(/sticky start-0/);
  });

  it('the retention matrix is no longer routed through the card-stacking DataTable', () => {
    const source = readFileSync(pagePath('cohorts'), 'utf8');
    expect(source).not.toContain('retentionColumns');
    expect(source).not.toMatch(/<DataTable<string>\s*\n\s*columns=\{retentionColumns\}/);
  });

  it('the simple LTV table still uses DataTable (a normal list, not a grid)', () => {
    const source = readFileSync(pagePath('cohorts'), 'utf8');
    expect(source).toMatch(/<DataTable<string>[^>]*columns=\{ltvColumns\}/);
  });
});
