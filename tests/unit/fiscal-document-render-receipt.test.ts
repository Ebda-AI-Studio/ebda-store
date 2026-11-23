/**
 * QA-69 / QA-70: the issued receipt page (/stores/:id/invoices/RCT-...) prints the store's configured order barcode,
 * the Arabic copy uses «ج.م» (never "EGP"), shipping is its own totals line (not an item row) and a negative amount
 * keeps its sign with its number in RTL. Rendered from the frozen payload, so the same HTML serves print.
 */
import { describe, it, expect } from 'vitest';
import {
  renderFiscalDocumentHtml,
  type RenderableDocument,
} from '@api/services/fiscal-document-render';

const doc = (over: Partial<RenderableDocument> = {}): RenderableDocument => ({
  docType: 'receipt',
  number: 'RCT-000004',
  status: 'issued',
  issuedAt: '2026-11-19T10:00:00Z',
  currency: 'EGP',
  netAmount: 24000,
  vatAmount: 0,
  totalAmount: 24000,
  vatRateBps: null,
  sellerTrn: null,
  payload: {
    orderNumber: 'ORD-TOQGFX-TIGCO',
    lines: [
      {
        kind: 'item',
        description: 'Shirt',
        descriptionAr: 'قميص',
        quantity: 1,
        unitPrice: 20000,
        amount: 20000,
      },
      {
        kind: 'shipping',
        description: 'Shipping',
        descriptionAr: 'الشحن',
        quantity: 1,
        unitPrice: 6000,
        amount: 6000,
      },
    ],
    discounts: [{ kind: 'coupon', label: 'SAVE', amount: 2000 }],
  },
  ...over,
});

describe('renderFiscalDocumentHtml', () => {
  it('prints the configured order barcode (QA-69)', () => {
    const html = renderFiscalDocumentHtml(doc(), 'ar', 'Africa/Cairo', 'plain');
    expect(html).toContain('class="doc-barcode"');
    expect(html).toContain('<svg');
  });
  it('prints the barcode by default and not when the store turned it off', () => {
    expect(renderFiscalDocumentHtml(doc(), 'en')).toContain('doc-barcode"');
    expect(renderFiscalDocumentHtml(doc(), 'en', 'Africa/Cairo', 'off')).not.toContain(
      'class="doc-barcode"'
    );
  });
  it('Arabic: ج.م, shipping as a totals line, sign isolated with its number (QA-70)', () => {
    const html = renderFiscalDocumentHtml(doc(), 'ar');
    expect(html).not.toContain('EGP');
    expect(html).toContain('ج.م');
    expect(html).toContain('<bdi dir="ltr">−20</bdi>');
    // shipping is a colspan totals row, never an item row with qty and unit price
    expect(html).toMatch(/<tr><td colspan="3">الشحن<\/td><td class="n">/);
    expect(html).not.toMatch(/<td>الشحن/);
  });
  it('English keeps EGP', () => {
    expect(renderFiscalDocumentHtml(doc(), 'en')).toContain('EGP');
  });
});
