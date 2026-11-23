/**
 * Receipts / invoices / credit notes print the order barcode with the typeable digits under it (BC1) and
 * show money and variants in the document's own language (RC1). The receipt RCT-000001 view
 * (/invoices/<docId>) showed no barcode and "4,850 EGP" in an Arabic document.
 */
import { describe, it, expect } from 'vitest';
import { scanCodeFor } from '@ebda/shared';
import { renderFiscalDocumentHtml } from '@api/services/fiscal-document-render';
import { cleanArabicReasoning } from '@api/lib/ai/arabic-sentence-check';

const ORDER = 'ORD-T5JK9Q-AB3XY';
const doc = (over: Record<string, unknown> = {}) => ({
  docType: 'receipt',
  number: 'RCT-000001',
  status: 'issued',
  issuedAt: '2026-11-17T09:00:00Z',
  currency: 'EGP',
  netAmount: 485000,
  vatAmount: 0,
  totalAmount: 485000,
  vatRateBps: null,
  sellerTrn: null,
  payload: {
    orderNumber: ORDER,
    lines: [
      {
        kind: 'item',
        description: 'Ring · Size 7',
        descriptionAr: 'خاتم · مقاس 7',
        quantity: 1,
        unitPrice: 485000,
        amount: 485000,
      },
    ],
  },
  ...over,
});

describe('fiscal document print view', () => {
  it('prints the order barcode, the big order number and the typeable scan digits', () => {
    const html = renderFiscalDocumentHtml(doc(), 'ar', 'Africa/Cairo', 'plain');
    expect(html).toContain('class="doc-barcode"');
    expect(html).toContain('<svg');
    expect(html).toContain(`class="doc-barcode-num" dir="ltr">${ORDER}<`);
    expect(html).toContain(`class="doc-barcode-digits" dir="ltr">${scanCodeFor(ORDER)}<`);
    expect(scanCodeFor(ORDER)).toMatch(/^\d{18}$/);
  });

  it('is off for shape off and absent without an order number; an unset shape prints the plain default (QA-69)', () => {
    expect(renderFiscalDocumentHtml(doc(), 'en', 'Africa/Cairo', 'off')).not.toContain(
      'doc-barcode"'
    );
    expect(renderFiscalDocumentHtml(doc(), 'en')).toContain('class="doc-barcode"');
    expect(
      renderFiscalDocumentHtml(doc({ payload: { lines: [] } }), 'en', 'Africa/Cairo', 'plain')
    ).not.toContain('doc-barcode"');
  });

  it('an Arabic document shows money in Arabic (ج.م) and an English one in English (EGP)', () => {
    const ar = renderFiscalDocumentHtml(doc(), 'ar');
    expect(ar).toContain('ج.م');
    expect(ar).not.toMatch(/EGP/);
    // main's moneyHtml isolates the number: `<bdi dir="ltr">4,850</bdi> EGP`
    expect(renderFiscalDocumentHtml(doc(), 'en')).toMatch(/<bdi dir="ltr">4,850(\.00)?<\/bdi> EGP/);
  });

  it('the Arabic line shows the Arabic variant', () => {
    expect(renderFiscalDocumentHtml(doc(), 'ar')).toContain('خاتم · مقاس 7');
  });
});

describe('cleanArabicReasoning (RO2)', () => {
  it('drops the glitch from the reorder cards and other malformed generated sentences', () => {
    expect(cleanArabicReasoning('اطلب بـ 10 وحد مع مورد قريب')).toBeNull();
    expect(cleanArabicReasoning('المخزون وحد وحد وحد')).toBeNull();
    expect(cleanArabicReasoning('عدد غريب �')).toBeNull();
    expect(cleanArabicReasoning('reorder 10 units')).toBeNull();
    expect(cleanArabicReasoning('   ')).toBeNull();
    expect(cleanArabicReasoning(null)).toBeNull();
  });
  it('keeps a well-formed sentence, including the full word وحدة and واحد', () => {
    const ok = 'المخزون المتاح 3 وحدات بس، والمبيعات واحد في اليوم، فاطلب 10 وحدة.';
    expect(cleanArabicReasoning(ok)).toBe(ok);
  });
});
