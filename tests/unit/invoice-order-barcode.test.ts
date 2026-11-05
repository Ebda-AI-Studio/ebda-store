/**
 * The printable invoice carries a real Code 128 of the order number in the
 * store's chosen shape (settings.receiptBarcodeShape): plain by default, a
 * masked shape, or nothing for `off`. The number is also printed, LTR.
 */
import { describe, it, expect, vi } from 'vitest';

const findFirst = vi.fn();
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn((await import('./helpers/invoice-repo-mock')).platformTx()),
  prisma: {
    fiscalDocument: { findMany: async () => [] },
    order: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));
vi.mock('@api/lib/repo-factory', async () =>
  (await import('./helpers/invoice-repo-mock')).repoFactoryMock()
);
vi.mock('@api/lib/jobs/store-db', async () =>
  (await import('./helpers/invoice-repo-mock')).storeDbMock()
);
const { InvoiceService } = await import('@api/services/invoice.service');

function order(settings: unknown) {
  return {
    id: 'o1',
    orderNumber: 'ORD-T5JK9Q-AB3XY',
    locale: 'ar',
    currency: 'EGP',
    status: 'delivered',
    paymentStatus: 'paid',
    createdAt: new Date('2026-10-07T10:00:00Z'),
    subtotal: 10000,
    discount: 0,
    couponCode: null,
    couponDiscount: 0,
    promotionDiscount: 0,
    loyaltyDiscount: 0,
    loyaltyPointsRedeemed: null,
    tax: 0,
    taxIncludedInPrice: false,
    sellerTaxRegistrationNumber: null,
    sellerTaxLegalName: null,
    taxRateBps: null,
    shipping: 500,
    total: 10500,
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
      settings,
    },
    customer: null,
    items: [],
    payments: [],
    appliedPromotion: null,
  };
}
const html = async (settings: unknown) => {
  findFirst.mockResolvedValue(order(settings));
  return InvoiceService.generateInvoice('s1', 'o1', 'ar');
};

describe('invoice order barcode', () => {
  it('defaults to a plain barcode, LTR, with the number printed', async () => {
    const h = await html({});
    expect(h).toContain('class="doc-barcode"');
    expect(h).toContain('<bdi dir="ltr"><svg');
    expect(h).not.toContain('<mask');
    expect(h).toContain('aria-label="ORD-T5JK9Q-AB3XY"');
  });
  it('renders the chosen shape', async () => {
    expect(await html({ receiptBarcodeShape: 'palm' })).toContain('<mask id="bcm-palm"');
  });
  it('off draws nothing; an unknown stored shape falls back to plain', async () => {
    expect(await html({ receiptBarcodeShape: 'off' })).not.toContain('<div class="doc-barcode">');
    const h = await html({ receiptBarcodeShape: 'star' });
    expect(h).toContain('class="doc-barcode"');
    expect(h).not.toContain('<mask');
  });
});
