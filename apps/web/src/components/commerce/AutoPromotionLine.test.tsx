// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { post } }));
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', t: (en: string) => en }),
}));
vi.mock('@/contexts/StoreContext', () => ({ useStore: () => ({ store: { id: 'store-1' } }) }));
vi.mock('@/hooks/useLocalePrice', () => ({
  useLocalePrice: () => (n: number) => `EGP ${n / 100}`,
}));

import { AutoPromotionLine } from './AutoPromotionLine';
import { primaryDiscount } from '@/lib/auto-promotion';

afterEach(() => {
  cleanup();
  post.mockReset();
});

describe('PDP automatic promotion line', () => {
  it('shows the SERVER-evaluated discount, asked for this product', async () => {
    post.mockResolvedValue({ success: true, data: { promotion: { id: 'p1', discount: 1500 } } });
    render(<AutoPromotionLine productId="prod-1" quantity={2} />);
    expect(await screen.findByTestId('pdp-auto-promotion')).toBeTruthy();
    expect(screen.getByTestId('pdp-auto-promotion').textContent).toContain('EGP 15');
    expect(post).toHaveBeenCalledWith('/stores/public/store-1/promotions/preview', {
      items: [{ productId: 'prod-1', quantity: 2 }],
      phone: undefined,
      email: undefined,
    });
  });
  it('renders nothing when no promotion applies', async () => {
    post.mockResolvedValue({ success: true, data: { promotion: null } });
    render(<AutoPromotionLine productId="prod-1" />);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByTestId('pdp-auto-promotion')).toBeNull();
  });
});

describe('primaryDiscount (cart + checkout share it)', () => {
  it('the larger of coupon and promotion applies; the promotion wins ties', () => {
    expect(primaryDiscount(0, 1500)).toEqual({
      discount: 1500,
      promotionWins: true,
      promotionApplied: 1500,
    });
    expect(primaryDiscount(2000, 1500)).toEqual({
      discount: 2000,
      promotionWins: false,
      promotionApplied: 0,
    });
    expect(primaryDiscount(1500, 1500).promotionWins).toBe(true);
    expect(primaryDiscount(0, 0)).toEqual({
      discount: 0,
      promotionWins: false,
      promotionApplied: 0,
    });
  });
});
