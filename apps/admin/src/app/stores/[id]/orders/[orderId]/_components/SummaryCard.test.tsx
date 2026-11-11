// @vitest-environment jsdom
/**
 * #197: loyaltyDiscount/loyaltyPointsRedeemed are persisted on every
 * redeeming order (order.service.ts) but had no distinct order-detail UI —
 * the discount folded silently into the generic `otherDiscount` bucket, so
 * docs/uat/loyalty-redemption.md step 11 ("the order detail shows the
 * loyalty discount") had no line to point at. This asserts the "Loyalty
 * points" row renders distinctly, with the points count, and reconciles the
 * same way coupon/promotion already do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OrderDetail } from './types';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return {
    useTranslations: () => t,
    useLocale: () => 'en',
  };
});

import { SummaryCard } from './SummaryCard';

afterEach(() => {
  cleanup();
});

function order(overrides: Partial<OrderDetail>): OrderDetail {
  return {
    subtotal: 10_000,
    tax: 0,
    shipping: 0,
    discount: 0,
    total: 10_000,
    currency: 'EGP',
    ...overrides,
  } as OrderDetail;
}

describe('SummaryCard — loyalty points line (#197)', () => {
  it('shows a distinct "loyaltyPoints" row with the points count when loyaltyDiscount > 0', () => {
    render(
      <SummaryCard
        order={order({
          discount: 2_000,
          loyaltyDiscount: 2_000,
          loyaltyPointsRedeemed: 1000,
        })}
      />
    );
    expect(screen.getByText('loyaltyPoints (1,000)')).toBeTruthy();
    expect(screen.getByText('20 ج.م')).toBeTruthy();
    // Not folded into the generic "discount" bucket alongside it.
    expect(screen.queryByText(/^discount/)).toBeNull();
  });

  it('reconciles coupon + promotion + loyalty + other back to the total discount', () => {
    render(
      <SummaryCard
        order={order({
          discount: 5_000, // 1000 coupon + 1500 promotion + 2000 loyalty + 500 other
          couponDiscount: 1_000,
          promotionDiscount: 1_500,
          loyaltyDiscount: 2_000,
          loyaltyPointsRedeemed: 800,
        })}
      />
    );
    expect(screen.getByText('coupon')).toBeTruthy();
    expect(screen.getByText('promotion')).toBeTruthy();
    expect(screen.getByText('loyaltyPoints (800)')).toBeTruthy();
    // The unexplained remainder (500 piastres) still shows as the generic bucket.
    expect(screen.getByText(/^discount/)).toBeTruthy();
    // #2261 — its percentage is of the 500 piastres shown (5% of 10,000), not the
    // whole-order 50%.
    expect(screen.getByText('5 ج.م (5%)')).toBeTruthy();
    expect(screen.queryByText(/\(50%\)/)).toBeNull();
  });

  it('omits the loyalty row entirely when no redemption applied', () => {
    render(
      <SummaryCard
        order={order({
          discount: 1_000,
          couponDiscount: 1_000,
          loyaltyDiscount: 0,
          loyaltyPointsRedeemed: null,
        })}
      />
    );
    expect(screen.queryByText(/loyaltyPoints/)).toBeNull();
  });
});

describe('SummaryCard — inclusive VAT is a caption after Total, never a summed row (issue 2210)', () => {
  // The exact order the M3-8 integration test creates: tax 238 is INSIDE the
  // 5000 subtotal, so Subtotal + Tax + Shipping must not be printed as rows
  // that add up to more than the 5500 Total.
  const inclusive = { subtotal: 5000, tax: 238, shipping: 500, total: 5500 };

  it('inclusive: no summed tax row; an "incl. VAT" caption follows Total', () => {
    const { container } = render(
      <SummaryCard order={order({ ...inclusive, taxIncludedInPrice: true })} />
    );
    const labels = screen.getAllByRole('term').map(el => el.textContent);
    expect(labels).not.toContain('tax');
    expect(labels).toContain('taxIncluded');
    // Caption renders AFTER the Total row.
    const terms = Array.from(container.querySelectorAll('dt')).map(el => el.textContent);
    expect(terms.indexOf('taxIncluded')).toBeGreaterThan(terms.indexOf('total'));
  });

  it('exclusive (default, every existing order): tax stays a summed row, no caption', () => {
    render(<SummaryCard order={order({ subtotal: 5000, tax: 250, shipping: 500, total: 5750 })} />);
    const labels = screen.getAllByRole('term').map(el => el.textContent);
    expect(labels).toContain('tax');
    expect(labels).not.toContain('taxIncluded');
  });
});
