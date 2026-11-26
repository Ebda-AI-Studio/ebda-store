/** CodeQL js/reflected-xss on the fiscal-document html routes: stored/echoed values never render as markup, and the response forbids script. */
import { describe, it, expect, vi } from 'vitest';
import { renderFiscalDocumentHtml } from '@api/services/fiscal-document-render';
import { sendFiscalHtml } from '@api/routes/fiscal-document.routes';

const X = '<script>alert(1)</script>"\'';
describe('fiscal document html is inert', () => {
  it('escapes every payload text field', () => {
    const html = renderFiscalDocumentHtml(
      {
        docType: 'receipt',
        number: X,
        status: 'issued',
        issuedAt: '2026-11-19T10:00:00Z',
        currency: 'EGP',
        netAmount: 1,
        vatAmount: 0,
        totalAmount: 1,
        vatRateBps: null,
        sellerTrn: X,
        payload: {
          orderNumber: X,
          reason: X,
          buyerName: X,
          seller: { name: X, legalName: X },
          lines: [
            { kind: 'item', description: X, quantity: X, unitPrice: 1, amount: 1, priceLabel: X },
          ],
          discounts: [{ label: X, amount: 1 }],
        },
      } as never,
      'en'
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });
  it('sends html with CSP, nosniff and no-store', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v), send: vi.fn() };
    sendFiscalHtml(res as never, '<p>x</p>');
    expect(headers['Content-Security-Policy']).toMatch(/default-src 'none'/);
    expect(headers['Content-Security-Policy']).not.toMatch(/script-src/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(res.send).toHaveBeenCalledWith('<p>x</p>');
  });
});
