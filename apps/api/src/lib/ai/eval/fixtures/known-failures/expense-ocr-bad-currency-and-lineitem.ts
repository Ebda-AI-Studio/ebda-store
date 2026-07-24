import type { KnownFailureCase } from '../types';

/** Currency isn't a valid ISO code and a line item's total doesn't match qty x unitPrice. */
export const expenseOcrBadCurrencyAndLineItem: KnownFailureCase = {
  id: 'expense-ocr-bad-currency-and-lineitem',
  type: 'expense-ocr',
  description:
    'Currency "kd" is not a 3-letter ISO code, and a line item claims lineTotal 5.000 for quantity 2 x unitPrice 1.000 (=2.000).',
  input: { receiptUrl: 'https://example.com/receipts/bad-currency.jpg' },
  output: {
    vendor: 'Corner Shop',
    vendorAr: null,
    invoiceDate: '2026-03-01',
    currency: 'kd',
    subtotal: 5,
    taxAmount: 0,
    total: 5,
    lineItems: [{ description: 'Assorted', quantity: 2, unitPrice: 1, lineTotal: 5 }],
    category: 'Miscellaneous',
    confidence: 0.6,
  },
  expectedFailedChecks: ['currency-iso-code', 'line-item-internal-consistency'],
};
