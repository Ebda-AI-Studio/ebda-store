/**
 * Ruling AN-7: the GL Gross-profit card follows the one unknown-state pattern.
 * With GL revenue but zero COGS booked, "revenue − 0" is not a gross profit —
 * the card must say "Unknown" and why, never repeat the revenue figure.
 *
 * Mutation proof: make `glGrossProfitKnown` return `true` → the first test
 * reddens (the card renders the revenue amount as gross profit).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  GlKpiCards,
  glGrossProfitKnown,
} from '@admin/app/stores/[id]/analytics/_components/GlKpiCards';
import { formatCurrency } from '@admin/app/stores/[id]/analytics/_components/types';

describe('GL gross profit — unknown when no COGS was booked', () => {
  it('renders "Unknown" + the reason when revenue > 0 and COGS = 0', () => {
    const html = renderToStaticMarkup(
      <GlKpiCards
        gl={{ revenue: 12_345, cogs: 0, grossProfit: 12_345, netIncome: 12_345 }}
        periodLabel="p"
      />
    );
    expect(html).toContain('grossProfitUnknown');
    // Gross profit AND net income are built on the missing cost, so both say why (QA 2026-11-17 N1, #890).
    expect(html.match(/noCogsBooked/g)).toHaveLength(2);
    // Only revenue still renders as a figure (formatted by the admin's one money formatter).
    const revenue = formatCurrency(12_345);
    expect(html.split(revenue).length - 1).toBe(1);
  });

  it('renders the figure when COGS was booked', () => {
    const html = renderToStaticMarkup(
      <GlKpiCards
        gl={{ revenue: 10_000, cogs: 4_000, grossProfit: 6_000, netIncome: 5_000 }}
        periodLabel="p"
      />
    );
    expect(html).not.toContain('grossProfitUnknown');
    expect(html).toContain(formatCurrency(6_000));
    expect(html).toContain(formatCurrency(5_000));
  });

  it('a period with no revenue is a known 0, not unknown', () => {
    expect(glGrossProfitKnown({ revenue: 0, cogs: 0 })).toBe(true);
  });
});
