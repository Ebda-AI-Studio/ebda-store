/**
 * The delivery pick reaches the shopper (Ruling B4-7 follow-up): `notes` never leaves the server, so
 * the receipt and the confirmation email read only the first notes line, via deliveryLineFromNotes.
 * Mutation proof: make deliveryLineFromNotes scan every line -> the forged-line case goes red.
 */
import { describe, it, expect } from 'vitest';
import { deliveryLineFromNotes } from '@ebda/shared';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import type { OrderEmailData } from '@api/services/email.service';

describe('deliveryLineFromNotes', () => {
  it('reads the first line without its prefix, in Arabic and English', () => {
    expect(
      deliveryLineFromNotes('التوصيل: الثلاثاء 3 نوفمبر، غدا 12-2 (12:00 م–2:00 م)\nمن غير فستق')
    ).toBe('الثلاثاء 3 نوفمبر، غدا 12-2 (12:00 م–2:00 م)');
    expect(deliveryLineFromNotes('Delivery: Tue 3 Nov, Lunch (12:00 PM–2:00 PM)')).toBe(
      'Tue 3 Nov, Lunch (12:00 PM–2:00 PM)'
    );
  });

  it('is null without a delivery line, and a customer cannot forge one on a later line', () => {
    expect(deliveryLineFromNotes(null)).toBeNull();
    expect(deliveryLineFromNotes('')).toBeNull();
    expect(deliveryLineFromNotes('من غير فستق')).toBeNull();
    expect(deliveryLineFromNotes('من غير فستق\nالتوصيل: بكرة')).toBeNull();
  });
});

describe('order confirmation email', () => {
  const base: OrderEmailData = {
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
  };

  it('shows the delivery pick, escaped, in both locales, and nothing without one', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = orderConfirmationTemplate[locale](
        { ...base, deliveryLine: 'Tue <b>3</b> Nov' },
        'S'
      );
      expect(html).toContain('Tue &lt;b&gt;3&lt;/b&gt; Nov');
      expect(html).not.toContain('<b>3</b>');
      expect(orderConfirmationTemplate[locale](base, 'S')).not.toMatch(
        /موعد التوصيل|<strong>Delivery<\/strong>/
      );
    }
  });
});

describe('WhatsApp COD confirmation', () => {
  it('names the delivery pick when the order has one', async () => {
    const { buildCodConfirmationMessage } = await import('@ebda/shared');
    const base = { orderNumber: 'N-1', items: [], totalMinor: 5500 } as const;
    expect(
      buildCodConfirmationMessage({ ...base, locale: 'ar', deliveryLine: 'الثلاثاء 3 نوفمبر' })
    ).toContain('موعد التوصيل: الثلاثاء 3 نوفمبر');
    expect(
      buildCodConfirmationMessage({ ...base, locale: 'en', deliveryLine: 'Tue 3 Nov' })
    ).toContain('Delivery: Tue 3 Nov');
    expect(buildCodConfirmationMessage({ ...base, locale: 'en' })).not.toContain('Delivery: ');
  });
});
