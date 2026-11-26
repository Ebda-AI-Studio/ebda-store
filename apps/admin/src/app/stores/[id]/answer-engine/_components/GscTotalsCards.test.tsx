// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { GscTotalsCards } from './GscTotalsCards';
import { formatPosition } from './types';

afterEach(cleanup);

const totals = (
  over: Partial<{ impressions: number; clicks: number; ctr: number; avgPosition: number }>
) => ({ impressions: 0, clicks: 0, ctr: 0, avgPosition: 0, ...over }) as never;

describe('Search Console average position (live: showed "0.0" with 0 impressions)', () => {
  it('shows an em dash, not 0.0, when there are no impressions', () => {
    render(<GscTotalsCards totals={totals({})} />);
    const card = screen.getByText('avgPosition').closest('div')!;
    expect(card.textContent).toContain('—');
    expect(card.textContent).not.toContain('0.0');
  });
  it('shows the position once there are impressions', () => {
    render(
      <GscTotalsCards
        totals={totals({ impressions: 120, clicks: 4, ctr: 0.033, avgPosition: 7.26 })}
      />
    );
    expect(screen.getByText('avgPosition').closest('div')!.textContent).toContain('7.3');
  });
});

describe('formatPosition', () => {
  it('no data = em dash: zero impressions, a zero or negative position, NaN or Infinity', () => {
    expect(formatPosition(0)).toBe('—');
    expect(formatPosition(5.2, 0)).toBe('—');
    expect(formatPosition(-1, 10)).toBe('—');
    expect(formatPosition(Number.NaN, 10)).toBe('—');
    expect(formatPosition(Number.POSITIVE_INFINITY, 10)).toBe('—');
  });
  it('a real position keeps one decimal, with or without the impression count', () => {
    expect(formatPosition(1)).toBe('1.0');
    expect(formatPosition(12.345, 50)).toBe('12.3');
  });
});
