/**
 * The order-confirmation email's totals block, both locales.
 *
 *  - issues 2112 / 2168: inclusive tax is a caption AFTER Total (the email
 *    used to print Subtotal + Tax + Shipping = a Total visibly off by the tax),
 *    and a zero tax prints no row at all.
 *  - issue 2239: discount levers are split — loyalty points are never shown
 *    as part of the coupon.
 *  - issue 1705: a non-EGP order renders in its own currency; EGP renders
 *    exactly as before.
 *
 * Mutation proof: in order-confirmation.ts render the tax row whenever
 * `d.tax > 0` → the inclusive case goes red; make `emailMoney` ignore the
 * currency → the USD case goes red.
 */
import { describe, it, expect } from 'vitest';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import type { OrderEmailData } from '@api/services/email.service';

function data(o: Partial<OrderEmailData> = {}): OrderEmailData {
  return {
    orderNumber: 'N-1',
    customerName: 'A',
    customerEmail: 'a@x.test',
    items: [{ name: 'Dates', quantity: 1, price: 5000 }],
    subtotal: 5000,
    tax: 0,
    shipping: 500,
    total: 5500,
    shippingAddress: {
      firstName: 'A',
      lastName: 'B',
      address1: 'x',
      city: 'y',
      state: 'z',
      postalCode: '1',
      country: 'EG',
    },
    ...o,
  };
}

const text = (html: string) => {
  const foot = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
  return foot
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

describe('order confirmation email totals', () => {
  it('inclusive tax is a caption after Total (en + ar)', () => {
    const d = data({ tax: 238, taxIncludedInPrice: true });
    const en = text(orderConfirmationTemplate.en(d, 'S'));
    expect(en).toBe('Subtotal 50.00 EGP Shipping 5.00 EGP Total 55.00 EGP Incl. VAT 2.38 EGP');
    const ar = text(orderConfirmationTemplate.ar(d, 'S'));
    expect(ar.indexOf('شامل ضريبة القيمة المضافة 2.38 ج.م')).toBeGreaterThan(
      ar.indexOf('الإجمالي')
    );
    expect(ar).not.toContain('الضريبة 2.38 ج.م الشحن');
  });

  it('exclusive tax is a summed row; zero tax prints no row', () => {
    expect(text(orderConfirmationTemplate.en(data({ tax: 250, total: 5750 }), 'S'))).toContain(
      'Tax 2.50 EGP Shipping'
    );
    expect(text(orderConfirmationTemplate.en(data(), 'S'))).not.toContain('Tax');
  });

  it('splits coupon and loyalty points', () => {
    const t = text(
      orderConfirmationTemplate.en(
        data({
          discount: 1500,
          couponCode: 'SAVE',
          couponDiscount: 500,
          loyaltyDiscount: 1000,
          loyaltyPointsRedeemed: 200,
          total: 4000,
        }),
        'S'
      )
    );
    expect(t).toContain('Coupon (SAVE) -5.00 EGP');
    expect(t).toContain('Loyalty points (200) -10.00 EGP');
  });

  it('renders a USD order in USD, not "100.00 EGP"', () => {
    const t = text(
      orderConfirmationTemplate.en(
        data({ currency: 'USD', subtotal: 10000, shipping: 0, total: 10000 }),
        'S'
      )
    );
    expect(t).toContain('Total USD 100.00');
    expect(t).not.toContain('EGP');
  });
});
