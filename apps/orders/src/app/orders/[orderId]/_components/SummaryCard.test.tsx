// @vitest-environment jsdom
/**
 * Issue 197: a loyalty-points redemption must be named on the order detail,
 * not folded into a generic "Discount" line. The admin SummaryCard and the
 * storefront order detail split it out; the orders PWA — whose SummaryCard
 * "mirrors the admin SummaryCard" — did not, so the three surfaces disagreed
 * about the same order (scoped audit, PR 1978).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OrderDetail } from '@/lib/orders';

vi.mock('@/contexts/LanguageContext', () => {
  const echo = new Proxy({}, { get: (_t, key) => String(key) });
  return { useLanguage: () => ({ t: { detail: echo }, locale: 'en' }) };
});

import { SummaryCard } from './SummaryCard';

afterEach(() => cleanup());

function order(overrides: Partial<OrderDetail>): OrderDetail {
  return {
    id: 'o1',
    storeId: 's1',
    orderNumber: 'ORD-1',
    currency: 'KWD',
    subtotal: 10000,
    tax: 0,
    shipping: 0,
    discount: 0,
    total: 10000,
    items: [],
    ...overrides,
  } as unknown as OrderDetail;
}

const rowLabels = () => screen.getAllByRole('term').map(el => el.textContent);

describe('orders PWA SummaryCard — loyalty redemption line (issue 197)', () => {
  it('names the loyalty portion with the points redeemed, and leaves no "other" remainder', () => {
    render(
      <SummaryCard
        order={order({
          discount: 1500,
          couponDiscount: 1000,
          couponCode: 'SAVE',
          loyaltyDiscount: 500,
          loyaltyPointsRedeemed: 250,
          total: 8500,
        })}
      />
    );
    const labels = rowLabels();
    expect(labels).toContain('loyaltyPoints (250)');
    expect(labels).toContain('coupon (SAVE)');
    // coupon + loyalty reconcile to `discount`, so the generic line is absent.
    expect(labels).not.toContain('discount');
  });

  it('still shows a genuine remainder as the generic discount line', () => {
    render(
      <SummaryCard
        order={order({ discount: 800, loyaltyDiscount: 500, loyaltyPointsRedeemed: 250 })}
      />
    );
    const labels = rowLabels();
    expect(labels).toContain('loyaltyPoints (250)');
    expect(labels).toContain('discount');
  });

  it('shows no loyalty line on an order that redeemed nothing', () => {
    render(<SummaryCard order={order({ discount: 1000, couponDiscount: 1000 })} />);
    expect(rowLabels().some(l => l?.startsWith('loyaltyPoints'))).toBe(false);
  });
});
