import type { KnownFailureCase } from '../types';

/** OCR misread (or fabricated) the total: subtotal + tax do not add up to the stated total. */
export const expenseOcrTotalMismatch: KnownFailureCase = {
  id: 'expense-ocr-total-mismatch',
  type: 'expense-ocr',
  description:
    'Stated total (30.00) does not equal subtotal (25.00) + tax (1.25 = 26.25) — a misread/hallucinated total on a money document.',
  input: { receiptUrl: 'https://example.com/receipts/bad-total.jpg' },
  output: {
    vendor: 'Carrefour',
    vendorAr: null,
    invoiceDate: '2026-04-10',
    currency: 'AED',
    subtotal: 25,
    taxAmount: 1.25,
    total: 30,
    lineItems: [
      { description: 'Water 24pk', quantity: 1, unitPrice: 10, lineTotal: 10 },
      { description: 'Chips', quantity: 3, unitPrice: 5, lineTotal: 15 },
    ],
    category: 'Groceries',
    confidence: 0.71,
  },
  expectedFailedChecks: ['total-reconciles'],
};
