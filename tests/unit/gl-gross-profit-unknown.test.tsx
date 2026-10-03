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

describe('GL gross profit — unknown when no COGS was booked', () => {
  it('renders "Unknown" + the reason when revenue > 0 and COGS = 0', () => {
    const html = renderToStaticMarkup(
      <GlKpiCards
        gl={{ revenue: 12_345, cogs: 0, grossProfit: 12_345, netIncome: 12_345 }}
        periodLabel="p"
      />
    );
    expect(html).toContain('grossProfitUnknown');
    expect(html).toContain('noCogsBooked');
    // Revenue and net income still render as figures; gross profit does not.
    expect(html.match(/123\.45/g)).toHaveLength(2);
  });

  it('renders the figure when COGS was booked', () => {
    const html = renderToStaticMarkup(
      <GlKpiCards
        gl={{ revenue: 10_000, cogs: 4_000, grossProfit: 6_000, netIncome: 5_000 }}
        periodLabel="p"
      />
    );
    expect(html).not.toContain('grossProfitUnknown');
    expect(html).toContain('60.00');
  });

  it('a period with no revenue is a known 0, not unknown', () => {
    expect(glGrossProfitKnown({ revenue: 0, cogs: 0 })).toBe(true);
  });
});
