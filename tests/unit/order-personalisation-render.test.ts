/**
 * B0 Task 5: the customer's personalisation text ("✎ Sara") prints under the
 * item name on the invoice and the order-confirmation email, ESCAPED with each
 * renderer's own escaper (the text is free customer input). The variant title
 * snapshot prints too.
 *
 * Mutation proof: drop `escapeHtml(...)` around the note in invoice.service.ts
 * or order-confirmation.ts → the `<script>` cases go red.
 */
import { describe, it, expect, vi } from 'vitest';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import type { OrderEmailData } from '@api/services/email.service';

const findFirst = vi.fn();
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn((await import('./helpers/invoice-repo-mock')).platformTx()),
  prisma: {
    fiscalDocument: { findMany: async () => [] }, // legacy order: no fiscal document (MONEYB-1)
    order: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));
vi.mock('@api/lib/repo-factory', async () =>
  (await import('./helpers/invoice-repo-mock')).repoFactoryMock()
);
vi.mock('@api/lib/jobs/store-db', async () =>
  (await import('./helpers/invoice-repo-mock')).storeDbMock()
);

import { InvoiceService } from '@api/services/invoice.service';

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'N-1',
    locale: 'en',
    currency: 'EGP',
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
      currency: 'EGP',
      timezone: 'Africa/Cairo',
    },
    customer: null,
    items: [],
    payments: [],
    appliedPromotion: null,
    ...overrides,
  };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  productId: 'p1',
  productName: 'Linen Abaya',
  variantName: 'M / Sand',
  personalisation: 'Sara',
  sku: null,
  quantity: 1,
  price: 5000,
  total: 5000,
  product: null,
  bundleGroupId: null,
  ...over,
});

describe('invoice: personalisation line', () => {
  it('prints ✎ note and the variant under the item name', async () => {
    findFirst.mockResolvedValue(order({ items: [item()] }));
    const html = await InvoiceService.generateInvoice('s1', 'o1', 'en');
    expect(html).toContain('<div class="item-note">&#9998; <bdi>Sara</bdi></div>');
    expect(html).toContain('Linen Abaya &middot; M / Sand');
  });

  it('escapes a hostile note', async () => {
    findFirst.mockResolvedValue(
      order({ items: [item({ personalisation: '<script>alert(1)</script>' })] })
    );
    const html = await InvoiceService.generateInvoice('s1', 'o1', 'en');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('prints nothing extra for a line without a note', async () => {
    findFirst.mockResolvedValue(order({ items: [item({ personalisation: null })] }));
    const html = await InvoiceService.generateInvoice('s1', 'o1', 'en');
    expect(html).not.toContain('class="item-note"');
  });
});

describe('order-confirmation email: personalisation line', () => {
  const data = (items: OrderEmailData['items']): OrderEmailData => ({
    orderNumber: 'N-1',
    customerName: 'A',
    customerEmail: 'a@x.test',
    items,
    subtotal: 5000,
    tax: 0,
    shipping: 0,
    total: 5000,
    shippingAddress: {
      firstName: 'A',
      lastName: 'B',
      address1: 'x',
      city: 'y',
      state: 'z',
      postalCode: '1',
      country: 'EG',
    },
  });

  it('renders ✎ note + the variant in the email language (each value isolated) and escapes it', () => {
    const d = data([
      {
        name: 'Linen Abaya',
        variantName: 'M / Sand',
        variantNameAr: 'وسط / رملي',
        personalisation: '<script>x</script>سارة',
        quantity: 1,
        price: 5000,
      },
    ]);
    for (const lang of ['en', 'ar'] as const) {
      const html = orderConfirmationTemplate[lang](d, 'Shop');
      expect(html).toContain('&#9998; <bdi>&lt;script&gt;x&lt;/script&gt;سارة</bdi>');
      expect(html).not.toContain('<script>x</script>');
    }
    const en = orderConfirmationTemplate.en(d, 'Shop');
    expect(en).toContain('<bdi>M</bdi> &middot; <bdi>Sand</bdi>');
    expect(en).not.toContain('رملي');
    expect(orderConfirmationTemplate.ar(d, 'Shop')).toContain(
      '<bdi>وسط</bdi> &middot; <bdi>رملي</bdi>'
    );
    // a pre-B0-41 line (no Arabic snapshot) falls back to the canonical title in Arabic
    const old = data([{ name: 'Linen Abaya', variantName: 'M / Sand', quantity: 1, price: 5000 }]);
    expect(orderConfirmationTemplate.ar(old, 'Shop')).toContain(
      '<bdi>M</bdi> &middot; <bdi>Sand</bdi>'
    );
  });

  it('adds nothing for a plain line', () => {
    const html = orderConfirmationTemplate.en(
      data([{ name: 'Dates', quantity: 1, price: 5000 }]),
      'Shop'
    );
    expect(html).not.toContain('&#9998;');
  });
});
