/**
 * The invoice's totals block — the document a merchant hands a customer and
 * files for VAT.
 *
 *  - issue 1705: money is formatted in the ORDER's currency by the shared
 *    helper, not a local `/1000 + toFixed(3)` that printed "10.000 USD".
 *  - issue 2239: the discount is split into coupon / promotion / loyalty
 *    points / remainder, like every order screen, instead of one aggregate
 *    line annotated with the coupon code only.
 *  - issues 2112 / 2168: inclusive tax is a caption AFTER Total, not a
 *    summed row that makes Subtotal + Tax + Shipping exceed Total.
 *
 * Mutation proof: restore the local `/1000` formatter → the USD case goes
 * red; render `order.discount` as one line → the loyalty case goes red;
 * render the tax row regardless of `taxIncludedInPrice` → the inclusive
 * case goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
vi.mock('@force/database', () => ({
  prisma: { order: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

import { InvoiceService } from '@api/services/invoice.service';

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'N-1',
    locale: 'en',
    currency: 'KWD',
    status: 'delivered',
    paymentStatus: 'paid',
    createdAt: new Date('2026-09-30T10:00:00Z'),
    subtotal: 5000,
    discount: 0,
    couponCode: null,
    couponDiscount: 0,
    promotionDiscount: 0,
    loyaltyDiscount: 0,
    loyaltyPointsRedeemed: null,
    tax: 0,
    taxIncludedInPrice: false,
    shipping: 500,
    total: 5500,
    notes: null,
    shippingAddress: { firstName: 'A', lastName: 'B' },
    billingAddress: null,
    store: {
      name: 'Shop',
      email: null,
      phone: null,
      address: null,
      logo: null,
      theme: null,
      currency: 'KWD',
      timezone: 'Asia/Kuwait',
    },
    customer: null,
    items: [],
    payments: [],
    appliedPromotion: null,
    ...overrides,
  };
}

/** Text of the totals block only, tags stripped. */
async function totals(o: Record<string, unknown>) {
  findFirst.mockResolvedValue(o);
  const html = await InvoiceService.generateInvoice('s1', 'o1', 'en');
  const block = html.slice(
    html.indexOf('<section class="totals-wrap">'),
    html.indexOf('</section>', html.indexOf('<section class="totals-wrap">'))
  );
  return block
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

beforeEach(() => findFirst.mockReset());

describe('invoice totals block', () => {
  it('formats money in the order currency (USD minor units are cents)', async () => {
    const t = await totals(order({ currency: 'USD', subtotal: 10000, shipping: 0, total: 10000 }));
    expect(t).toContain('$100.00');
    expect(t).not.toContain('10.000');
  });

  it('names a loyalty-only discount instead of printing it unexplained', async () => {
    const t = await totals(
      order({ discount: 1000, loyaltyDiscount: 1000, loyaltyPointsRedeemed: 200, total: 4500 })
    );
    expect(t).toContain('Loyalty points (200) −1.000 KWD');
    expect(t).not.toMatch(/Discount −/);
  });

  it('splits coupon + loyalty instead of attributing the points to the coupon', async () => {
    const t = await totals(
      order({
        discount: 1500,
        couponCode: 'SAVE',
        couponDiscount: 500,
        loyaltyDiscount: 1000,
        total: 4000,
      })
    );
    expect(t).toContain('Coupon (SAVE) −0.500 KWD');
    expect(t).toContain('Loyalty points −1.000 KWD');
  });

  it('shows exclusive tax as a summed row before Total', async () => {
    const t = await totals(order({ tax: 250, total: 5750 }));
    expect(t.indexOf('Tax 0.250 KWD')).toBeGreaterThan(-1);
    expect(t.indexOf('Tax 0.250 KWD')).toBeLessThan(t.indexOf('Total'));
  });

  it('shows inclusive tax as a caption AFTER Total, never a summed row', async () => {
    const t = await totals(order({ tax: 238, taxIncludedInPrice: true, total: 5500 }));
    expect(t).not.toMatch(/(^| )Tax 0\.238/);
    expect(t.indexOf('Incl. VAT 0.238 KWD')).toBeGreaterThan(t.indexOf('Total 5.500 KWD'));
  });
});
