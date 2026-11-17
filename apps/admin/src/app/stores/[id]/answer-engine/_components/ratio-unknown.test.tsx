// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { GscTotalsCards } from './GscTotalsCards';
import { EngineSummaryCards } from './EngineSummaryCards';
import { TrendChart } from './TrendChart';
import { PromptResultsList } from './PromptResultsList';
import { formatPosition } from './types';

afterEach(cleanup);

describe('GSC totals with no impressions (GS1: unknown is not zero)', () => {
  it('shows "—" and a hint for CTR and average position, never 0%/0.0', () => {
    render(<GscTotalsCards totals={{ impressions: 0, clicks: 0, ctr: 0, avgPosition: 0 }} />);
    expect(screen.queryByText('0.0')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getAllByText('—').length).toBe(2);
    expect(screen.getByText('noImpressionsHint')).toBeTruthy();
  });

  it('with impressions it shows the real figures and no hint', () => {
    render(
      <GscTotalsCards totals={{ impressions: 200, clicks: 10, ctr: 0.05, avgPosition: 7.25 }} />
    );
    expect(screen.getByText('5%')).toBeTruthy();
    expect(screen.getByText('7.3')).toBeTruthy();
    expect(screen.queryByText('noImpressionsHint')).toBeNull();
  });

  it('formatPosition renders null as a dash', () => {
    expect(formatPosition(null)).toBe('—');
    expect(formatPosition(3)).toBe('3.0');
  });
});

describe('answer-engine cited rate over zero checks', () => {
  it('an engine with 0 checks shows "—", not 0%', () => {
    render(
      <EngineSummaryCards
        engines={[
          {
            engine: 'gemini',
            totalChecks: 0,
            citedCount: 0,
            citedRate: 0,
            groundedCaveat: false,
            groundingUnavailable: false,
          } as never,
        ]}
      />
    );
    expect(screen.queryByText('citedRate')).toBeTruthy();
    expect(document.body.textContent).not.toContain('0%');
  });
});

describe('citations area empty panels (GS2)', () => {
  it('the three panels render nothing when empty; the page owns the single empty state', () => {
    const { container } = render(
      <>
        <EngineSummaryCards engines={[]} />
        <TrendChart trend={[]} />
        <PromptResultsList storeId="s" prompts={[]} />
      </>
    );
    expect(container.innerHTML).toBe('');
  });
});
