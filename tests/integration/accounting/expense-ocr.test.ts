import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@force/database';

// vi.mock is hoisted by vitest before imports — must appear at module top-level.
//
// Strategy: mock callGemini to return a well-formed OCR result.
// The service calls `fetchBuffer` (an internal https.get helper) before Gemini,
// so we also mock the built-in `https` module to avoid a real network hit.
vi.mock('../../../apps/api/src/services/accounting/gemini-ai.service', () => ({
  callGemini: vi.fn(async () => ({
    vendor: 'Test Vendor',
    vendorAr: null,
    invoiceDate: new Date().toISOString(),
    currency: 'EGP',
    subtotal: 50,
    taxAmount: 0,
    total: 50,
    lineItems: [{ description: 'Test', quantity: 1, unitPrice: 50, lineTotal: 50 }],
    category: 'marketing',
    confidence: 0.92,
  })),
  callGeminiBatch: vi.fn(async () => []),
}));

// Mock node's https.get so the service never makes a real network request.
// The service's fetchBuffer uses https.get → we return a minimal 1-pixel PNG buffer.
vi.mock('https', () => {
  const EventEmitter = require('events');
  const validPngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  return {
    default: {
      get: vi.fn((_url: string, cb: (res: any) => void) => {
        const res = new EventEmitter();
        (res as any).statusCode = 200;
        process.nextTick(() => {
          res.emit('data', validPngBuffer);
          res.emit('end');
        });
        cb(res);
        return { on: vi.fn() };
      }),
    },
    get: vi.fn((_url: string, cb: (res: any) => void) => {
      const res = new EventEmitter();
      (res as any).statusCode = 200;
      process.nextTick(() => {
        res.emit('data', validPngBuffer);
        res.emit('end');
      });
      cb(res);
      return { on: vi.fn() };
    }),
  };
});

import { seedCoaForStore } from '../../../apps/api/src/services/accounting/account.service';
import { processExpenseReceipt } from '../../../apps/api/src/services/accounting/expense-ocr.service';

// Isolated OWNER — '...0022' is not used by any other accounting test suite.
const OWNER = '00000000-0000-0000-0000-000000000022';
const RECEIPT_URL = 'https://test.r2.dev/fake.jpg';
let storeId: string;

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `expense-ocr-${Date.now()}@x.test`,
      passwordHash: 'x',
      firstName: 'E',
      lastName: 'O',
    },
  });

  const s = await prisma.store.create({
    data: {
      name: `expense-ocr-test-${Date.now()}`,
      slug: `expense-ocr-test-${Date.now()}`,
      ownerId: OWNER,
      aiFeaturesEnabled: true,
    },
  });
  storeId = s.id;
  // COA must be seeded so getSystemAccountIdByCode resolves 5200 (Marketing) and 1000 (Cash).
  await seedCoaForStore(storeId);
});

afterAll(async () => {
  await prisma.expense.deleteMany({ where: { storeId } });
  await prisma.account.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('expense ocr', () => {
  it('creates a draft Expense with the receipt URL attached', async () => {
    const { expenseId } = await processExpenseReceipt({
      storeId,
      receiptUrl: RECEIPT_URL,
      uploadedBy: OWNER,
    });

    expect(expenseId).toBeTruthy();

    const exp = await prisma.expense.findUnique({ where: { id: expenseId } });
    expect(exp).not.toBeNull();
    expect(exp!.status).toBe('draft');
    expect(exp!.receiptImageUrl).toBe(RECEIPT_URL);
  });

  it('attaches OCR metadata when Gemini succeeds', async () => {
    const { expenseId } = await processExpenseReceipt({
      storeId,
      receiptUrl: RECEIPT_URL,
      uploadedBy: OWNER,
    });

    const exp = await prisma.expense.findUnique({ where: { id: expenseId } });
    expect(exp).not.toBeNull();

    // Mocked Gemini returns category='marketing' → COA 5200 → expenseAccountId set.
    // ocrJson + confidence must be populated from the mock response.
    expect(exp!.ocrJson).not.toBeNull();
    expect(exp!.categoryAiConfidence).toBeCloseTo(0.92, 2);

    // Amount: total=50 EGP → 50*100 = 5000 piastres (currencyExponent: 2 decimals).
    expect(exp!.amount).toBe(5_000);
  });
});
