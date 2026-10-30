import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderTaxPlacement } from '@ebda/shared';

/**
 * Issue 2210 — the post-purchase order surfaces printed an INCLUSIVE `tax`
 * as a summed row between Subtotal and Total, so an inclusive order read
 * Subtotal 50.00 + Tax 2.38 + Shipping 5.00 against a printed Total of
 * 55.00. Every surface now takes the placement from `orderTaxPlacement`.
 */

const mockFindFirst = vi.fn();
vi.mock('@ebda/database', () => ({
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn((await import('./helpers/invoice-repo-mock')).platformTx()),
  prisma: {
    fiscalDocument: { findMany: async () => [] }, // legacy order: no fiscal document (MONEYB-1)
    order: { findFirst: (...a: unknown[]) => mockFindFirst(...a) },
  },
}));
vi.mock('@api/lib/repo-factory', async () =>
  (await import('./helpers/invoice-repo-mock')).repoFactoryMock()
);
vi.mock('@api/lib/jobs/store-db', async () =>
  (await import('./helpers/invoice-repo-mock')).storeDbMock()
);

import { InvoiceService } from '@api/services/invoice.service';

function invoiceOrder(overrides: Record<string, unknown>) {
  return {
    id: 'o1',
    orderNumber: 'ORD-1',
    locale: 'en',
    status: 'confirmed',
    paymentStatus: 'paid',
    paymentMethod: 'cod',
    createdAt: new Date('2026-09-30T10:00:00Z'),
    subtotal: 5000,
    discount: 0,
    tax: 238,
    shipping: 500,
    total: 5500,
    taxIncludedInPrice: true,
    couponCode: null,
    notes: null,
    shippingAddress: null,
    billingAddress: null,
    customer: null,
    items: [],
    payments: [],
    appliedPromotion: null,
    store: { name: 'S', currency: 'EGP', theme: null, timezone: 'Africa/Cairo' },
    ...overrides,
  };
}

describe('orderTaxPlacement', () => {
  it('exclusive → summed row, no caption (unchanged for every existing order)', () => {
    expect(orderTaxPlacement({ tax: 250, taxIncludedInPrice: false })).toEqual({
      taxRow: 250,
      includedTaxCaption: null,
    });
    expect(orderTaxPlacement({ tax: 250 })).toEqual({ taxRow: 250, includedTaxCaption: null });
  });

  it('inclusive → no row, caption with the included amount', () => {
    expect(orderTaxPlacement({ tax: 238, taxIncludedInPrice: true })).toEqual({
      taxRow: null,
      includedTaxCaption: 238,
    });
  });

  it('inclusive with zero tax → nothing at all', () => {
    expect(orderTaxPlacement({ tax: 0, taxIncludedInPrice: true })).toEqual({
      taxRow: null,
      includedTaxCaption: null,
    });
  });
});

describe('invoice — inclusive VAT placement', () => {
  beforeEach(() => mockFindFirst.mockReset());

  it('inclusive order: no summed Tax row; "Incl. VAT" caption after the grand total', async () => {
    mockFindFirst.mockResolvedValue(invoiceOrder({}));
    const html = await InvoiceService.generateInvoice('s1', 'o1', 'en');
    expect(html).not.toMatch(/<span class="label">Tax<\/span>/);
    const grand = html.indexOf('row grand');
    const caption = html.indexOf('row tax-included');
    expect(caption).toBeGreaterThan(grand);
    expect(html).toContain('Incl. VAT');
    expect(html).toContain('2.38 EGP');
  });

  it('inclusive order in Arabic uses the Arabic caption', async () => {
    mockFindFirst.mockResolvedValue(invoiceOrder({ locale: 'ar' }));
    const html = await InvoiceService.generateInvoice('s1', 'o1', 'ar');
    expect(html).toContain('شامل ضريبة القيمة المضافة');
    expect(html).not.toMatch(/<span class="label">الضريبة<\/span>/);
  });

  it('exclusive order: Tax stays a summed row, no caption', async () => {
    mockFindFirst.mockResolvedValue(
      invoiceOrder({ taxIncludedInPrice: false, tax: 250, total: 5750 })
    );
    const html = await InvoiceService.generateInvoice('s1', 'o1', 'en');
    expect(html).toMatch(/<span class="label">Tax<\/span><span class="val">2\.50 EGP/);
    expect(html).not.toContain('row tax-included');
  });
});

describe('storefront order detail reads the same placement', () => {
  it('OrderDetailClient renders tax through orderTaxPlacement, not a raw order.tax row', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/app/account/orders/[id]/OrderDetailClient.tsx'),
      'utf8'
    );
    expect(src).toContain('const taxPlacement = orderTaxPlacement(order);');
    expect(src).toContain('taxPlacement.includedTaxCaption !== null');
    expect(src).not.toMatch(/\{order\.tax > 0 && \(/);
  });
});
