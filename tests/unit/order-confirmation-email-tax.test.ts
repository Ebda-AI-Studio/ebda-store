import { describe, expect, it } from 'vitest';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import type { OrderEmailData } from '@api/services/email.service';

/**
 * Issue 2210 class sweep — the order confirmation / payment-success email is
 * the fifth post-purchase surface printing `order.tax`. For an inclusive-VAT
 * order the tax is already inside subtotal/total, so a summed "Tax" row makes
 * Subtotal + Tax + Shipping exceed the printed Total by exactly `tax`.
 */
const base: OrderEmailData = {
  orderNumber: 'ORD-1',
  customerName: 'Sara',
  items: [{ name: 'Tea', quantity: 1, price: 5000 }],
  subtotal: 5000,
  tax: 238,
  shipping: 500,
  total: 5500,
  shippingAddress: {
    firstName: 'S',
    lastName: 'A',
    address1: 'Block 1',
    city: 'Egypt',
    state: 'Capital',
    postalCode: '00000',
    country: 'EG',
  },
};

describe('order confirmation email — tax placement', () => {
  it.each(['en', 'ar'] as const)(
    '%s: inclusive VAT is a caption after Total, not a summed row',
    lang => {
      const html = orderConfirmationTemplate[lang]({ ...base, taxIncludedInPrice: true }, 'Shop');
      const taxLabel = lang === 'en' ? '>Tax</td>' : '>الضريبة</td>';
      expect(html).not.toContain(taxLabel);
      const caption = lang === 'en' ? 'Incl. VAT 2.38' : 'شامل ضريبة القيمة المضافة 2.38';
      expect(html).toContain(caption);
      const totalLabel = lang === 'en' ? '>Total</td>' : '>الإجمالي</td>';
      expect(html.indexOf(caption)).toBeGreaterThan(html.indexOf(totalLabel));
    }
  );

  it.each(['en', 'ar'] as const)('%s: exclusive tax keeps its summed row (unchanged)', lang => {
    const html = orderConfirmationTemplate[lang]({ ...base, total: 5738 }, 'Shop');
    expect(html).toContain(lang === 'en' ? '>Tax</td>' : '>الضريبة</td>');
    expect(html).toContain('2.38');
    expect(html).not.toContain('Incl. VAT');
    expect(html).not.toContain('شامل ضريبة');
  });

  it('both inngest callers pass taxIncludedInPrice through', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of [
      'apps/api/src/lib/inngest/functions/order-created.ts',
      'apps/api/src/lib/inngest/functions/order-status-changed.ts',
    ]) {
      expect(readFileSync(f, 'utf8')).toContain('taxIncludedInPrice: order.taxIncludedInPrice');
    }
  });
});
