// @vitest-environment jsdom
/**
 * #2258 — past ~130 points the bars stopped shrinking and every bar from
 * there on was drawn outside the 520-wide viewBox (clipped): "This year" hid
 * half the year while the legend claimed the whole range.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CashflowChart } from './CashflowChart';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

afterEach(() => cleanup());

const points = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    net: (i % 3) - 1 || 500,
  }));

describe('CashflowChart fits every bar in the viewBox (#2258)', () => {
  it.each([7, 30, 90, 131, 365, 800])('%i points: all bars drawn inside 0..520', n => {
    const { container } = render(<CashflowChart data={points(n)} periodLabel="p" />);
    const rects = [...container.querySelectorAll('rect')];
    expect(rects).toHaveLength(n);
    for (const r of rects) {
      const x = Number(r.getAttribute('x'));
      const w = Number(r.getAttribute('width'));
      expect(w).toBeGreaterThan(0);
      expect(x + w).toBeLessThanOrEqual(520 + 1e-9);
    }
    // The last bar reaches the right edge region — the range is really covered.
    const last = rects[rects.length - 1];
    expect(Number(last.getAttribute('x'))).toBeGreaterThan(520 * (1 - 2 / n) - 1);
  });
});
