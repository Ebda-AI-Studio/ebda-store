/**
 * Egypt VAT gate (ruling TAX-2) — what the customer-facing documents say.
 *
 * An order priced under a VERIFIED tax profile froze the seller's TRN; its
 * invoice is a "Tax invoice / فاتورة ضريبية" with the TRN and a VAT breakdown
 * (taxable amount + "VAT (14%)"). An order without a frozen TRN — every order of
 * an unverified store — is an ordinary invoice with NO VAT wording at all.
 *
 * Mutation proof: making `taxInvoiceInfo` ignore `sellerTaxRegistrationNumber`
 * (always returning info) reddens every "unverified … no VAT wording" case;
 * returning null always reddens every "verified … tax invoice" case.
 */
import { describe, it, expect, vi } from 'vitest';
import { taxInvoiceInfo } from '@ebda/shared';

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

const { InvoiceService, renderInvoiceEmailContent } = await import('@api/services/invoice.service');
const { orderConfirmationTemplate } =
  await import('@api/services/email-templates/order-confirmation');

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'N-1',
    locale: 'en',
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
    },
    customer: null,
    items: [],
    payments: [],
    appliedPromotion: null,
    ...overrides,
  };
}

const VERIFIED_EXCL = {
  tax: 1400,
  total: 11900,
  sellerTaxRegistrationNumber: '123456789',
  sellerTaxLegalName: 'Acme Trading LLC',
  taxRateBps: 1400,
};
const VERIFIED_INCL = {
  subtotal: 11400,
  tax: 1400,
  total: 11900,
  taxIncludedInPrice: true,
  sellerTaxRegistrationNumber: '123456789',
  sellerTaxLegalName: 'Acme Trading LLC',
  taxRateBps: 1400,
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const VAT_WORDS = /VAT|Tax invoice|Tax registration|ضريب/;

describe('taxInvoiceInfo', () => {
  it('null without a frozen TRN', () => {
    expect(taxInvoiceInfo(order() as never)).toBeNull();
  });
  it('exclusive: base = subtotal − discount', () => {
    expect(taxInvoiceInfo(order({ ...VERIFIED_EXCL, discount: 1000 }) as never)).toMatchObject({
      ratePercent: 14,
      taxableAmount: 9000,
      vatAmount: 1400,
    });
  });
  it('inclusive: base excludes the extracted VAT', () => {
    expect(taxInvoiceInfo(order(VERIFIED_INCL) as never)).toMatchObject({
      taxableAmount: 10000,
      vatAmount: 1400,
    });
  });
});

describe('printable invoice', () => {
  it.each(['en', 'ar'])('%s: unverified store — no VAT wording at all', async lang => {
    findFirst.mockResolvedValue(order());
    const html = await InvoiceService.generateInvoice('s1', 'o1', lang);
    expect(text(html)).not.toMatch(VAT_WORDS);
    expect(html).not.toContain('123456789');
  });

  it('en: verified — Tax invoice, seller TRN + legal name, taxable amount, VAT (14%)', async () => {
    findFirst.mockResolvedValue(order(VERIFIED_EXCL));
    const t = text(await InvoiceService.generateInvoice('s1', 'o1', 'en'));
    expect(t).toContain('Tax invoice');
    expect(t).toContain('Tax registration no.: 123456789');
    expect(t).toContain('Acme Trading LLC');
    expect(t).toContain('Taxable amount (excl. VAT)');
    expect(t).toMatch(/VAT \(14%\) 14 /);
  });

  it('ar: verified — فاتورة ضريبية + رقم التسجيل الضريبي', async () => {
    findFirst.mockResolvedValue(order(VERIFIED_EXCL));
    const t = text(await InvoiceService.generateInvoice('s1', 'o1', 'ar'));
    expect(t).toContain('فاتورة ضريبية');
    expect(t).toContain('رقم التسجيل الضريبي: 123456789');
    expect(t).toContain('ضريبة القيمة المضافة (14%)');
  });

  it('en: verified + inclusive — the VAT is a caption with its rate, not a summed row', async () => {
    findFirst.mockResolvedValue(order(VERIFIED_INCL));
    const t = text(await InvoiceService.generateInvoice('s1', 'o1', 'en'));
    expect(t).toContain('Incl. VAT (14%) 14 ');
    expect(t).toContain('Taxable amount (excl. VAT) 100 ');
  });
});

describe('invoice email body', () => {
  it('unverified: no VAT wording', () => {
    expect(text(renderInvoiceEmailContent(order() as never, 'en'))).not.toMatch(VAT_WORDS);
  });
  it('verified: Tax invoice + TRN + VAT (14%)', () => {
    const t = text(renderInvoiceEmailContent(order(VERIFIED_EXCL) as never, 'en'));
    expect(t).toContain('Tax invoice');
    expect(t).toContain('Tax registration no.: 123456789');
    expect(t).toMatch(/VAT \(14%\)/);
  });
});

describe('order confirmation email', () => {
  const base = {
    orderNumber: 'ORD-1',
    customerName: 'Sara',
    items: [{ name: 'Tea', quantity: 1, price: 10000 }],
    subtotal: 10000,
    tax: 0,
    shipping: 500,
    total: 10500,
    shippingAddress: {
      firstName: 'S',
      lastName: 'A',
      address1: 'Block 1',
      city: 'Cairo',
      state: 'Cairo',
      postalCode: '00000',
      country: 'EG',
    },
  };
  it.each(['en', 'ar'] as const)('%s: unverified store — no VAT wording', lang => {
    const html = orderConfirmationTemplate[lang](base as never, 'Shop');
    const totalsOnly = html.slice(html.indexOf('<table'));
    expect(text(totalsOnly)).not.toMatch(/VAT|ضريبة القيمة|التسجيل الضريبي/);
  });
  it.each(['en', 'ar'] as const)('%s: verified — VAT (14%) + seller TRN', lang => {
    const html = orderConfirmationTemplate[lang]({ ...base, ...VERIFIED_EXCL } as never, 'Shop');
    expect(html).toContain(lang === 'en' ? 'VAT (14%)' : 'ضريبة القيمة المضافة (14%)');
    expect(html).toContain('123456789');
  });
});
