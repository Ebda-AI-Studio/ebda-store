import type { GoldenCase } from '../types';

/**
 * Golden expense-OCR extractions — realistic receipts whose arithmetic and
 * format are internally consistent. Each MUST pass every deterministic check
 * for `expense-ocr`. (The image-grounding judge dimensions run only nightly.)
 */
export const ACCOUNTING_GOLDEN: GoldenCase[] = [
  {
    id: 'expense-ocr-kwd-no-tax',
    type: 'expense-ocr',
    input: { receiptUrl: 'https://example.com/receipts/sultan-center.jpg' },
    output: {
      vendor: 'The Sultan Center',
      vendorAr: 'المركز سلطان',
      invoiceDate: '2026-05-20',
      currency: 'KWD',
      subtotal: 1.15,
      taxAmount: 0,
      total: 1.15,
      lineItems: [
        { description: 'Milk 1L', quantity: 2, unitPrice: 0.45, lineTotal: 0.9 },
        { description: 'Bread', quantity: 1, unitPrice: 0.25, lineTotal: 0.25 },
      ],
      category: 'Groceries',
      confidence: 0.94,
    },
  },
  {
    id: 'expense-ocr-aed-with-vat',
    type: 'expense-ocr',
    input: { receiptUrl: 'https://example.com/receipts/carrefour.jpg' },
    output: {
      vendor: 'Carrefour',
      vendorAr: null,
      invoiceDate: '2026-04-10',
      currency: 'AED',
      subtotal: 25,
      taxAmount: 1.25, // 5% VAT
      total: 26.25,
      lineItems: [
        { description: 'Water 24pk', quantity: 1, unitPrice: 10, lineTotal: 10 },
        { description: 'Chips', quantity: 3, unitPrice: 5, lineTotal: 15 },
      ],
      category: 'Groceries',
      confidence: 0.88,
    },
  },
];
