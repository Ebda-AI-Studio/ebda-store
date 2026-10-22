// @vitest-environment jsdom
/**
 * Phase B4 Task 2, Ruling B4-6: minimum-order progress is a sentence plus a determinate bar (not
 * colour alone), shows only while the cart is under a set minimum, and changes nothing about the
 * rule itself (checkMinimumOrder and the server MINIMUM_ORDER_NOT_MET stay the authority).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const ctx = vi.hoisted(() => ({ language: 'ar' as 'ar' | 'en' }));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: ctx.language,
    isRtl: ctx.language === 'ar',
    t: (en: string, ar: string) => (ctx.language === 'ar' ? ar : en),
  }),
}));
vi.mock('../../apps/web/src/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (fils: number) => `${fils / 100} ج.م`,
}));

const { MinOrderProgress } =
  await import('../../apps/web/src/components/commerce/MinOrderProgress');
afterEach(cleanup);

describe('MinOrderProgress', () => {
  it('says what is left in Egyptian Arabic and exposes a determinate progressbar', () => {
    const { getByRole, container } = render(
      <MinOrderProgress subtotalFils={7000} minimumOrderFils={15000} />
    );
    expect(container.textContent).toContain('ضيف 80 ج.م وتوصل للحد الأدنى للطلب');
    const bar = getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('15000');
    expect(bar.getAttribute('aria-valuenow')).toBe('7000');
    // named by the visible sentence (labelledby), so it is read once (a11y M1)
    const labelId = bar.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)!.textContent).toContain('80');
  });
  it('speaks English sentence case', () => {
    ctx.language = 'en';
    const { container } = render(<MinOrderProgress subtotalFils={0} minimumOrderFils={15000} />);
    expect(container.textContent).toContain('Add 150 ج.م to reach the minimum order');
    ctx.language = 'ar';
  });
  it('renders nothing with no minimum, a zero minimum or a met minimum', () => {
    for (const [sub, min] of [
      [5000, undefined],
      [5000, 0],
      [5000, null],
      [15000, 15000],
      [20000, 15000],
    ] as const) {
      const { container } = render(
        <MinOrderProgress subtotalFils={sub} minimumOrderFils={min as number | undefined} />
      );
      expect(container.innerHTML, `${sub}/${min}`).toBe('');
      cleanup();
    }
  });
  it('clamps the value so a negative or over-full subtotal never leaves the bar', () => {
    const { getByRole } = render(<MinOrderProgress subtotalFils={-50} minimumOrderFils={100} />);
    expect(getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });
});
