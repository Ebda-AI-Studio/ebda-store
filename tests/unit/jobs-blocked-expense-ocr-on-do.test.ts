/**
 * Ruling CF-JOBS-4B: accounting-expense-ocr-process for a store on its Durable Object. The accounts come from the store's own chart,
 * the draft (number, row, OCR metadata) is the DO op `expenseDraft`, and Postgres THROWS if reached. Double fire: the op is keyed by
 * the receipt, so a retried job gets the first draft back and no second one is made.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DO_STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  drafts: new Map<string, { expenseId: string; args: Record<string, any> }>(),
  keys: [] as Array<string | undefined>,
  accounts: { '1000': 'acc-cash', '5990': 'acc-misc', '5500': 'acc-util' } as Record<
    string,
    string
  >,
  boom: (what: string): object =>
    new Proxy(
      {},
      {
        get: (_t, p) => {
          throw new Error(`Postgres touched: ${what}.${String(p)}`);
        },
      }
    ),
}));
vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: h.boom('prisma'),
    extra: {
      runInStoreScope: (_id: string, fn: () => unknown) => fn(),
      hasTenantContext: () => false,
      runInTenantContext: async () => {
        throw new Error('Postgres touched: runInTenantContext');
      },
    },
  })
);
vi.mock('@api/lib/repo-factory', () => {
  const money = {
    expenseDraft: async (a: Record<string, any>, key?: string) => {
      h.keys.push(key);
      const k = key ?? `n${h.drafts.size}`;
      const existing = h.drafts.get(k);
      if (existing) return { expenseId: existing.expenseId, expenseNumber: 'EXP-2026-000001' };
      const expenseId = `exp-${h.drafts.size + 1}`;
      h.drafts.set(k, { expenseId, args: a });
      return { expenseId, expenseNumber: 'EXP-2026-000001' };
    },
  };
  const db = {
    account: {
      findFirst: async (a: { where: { code: string } }) =>
        h.accounts[a.where.code] ? { id: h.accounts[a.where.code] } : null,
    },
    expense: { findFirst: async (a: { where: { id: string } }) => ({ id: a.where.id }) },
  };
  return { storeRepo: async () => ({ backend: 'do', db, money }) };
});
vi.mock('https', () => ({
  default: {
    get: (_url: string, cb: (r: EventEmitter & { statusCode: number }) => void) => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from('img'));
        res.emit('end');
      });
      return new EventEmitter();
    },
  },
}));
vi.mock('@api/services/accounting/gemini-ai.service', () => ({
  callGemini: async () => ({
    vendor: 'Cairo Electric',
    total: 114,
    taxAmount: 14,
    category: 'utilities',
    currency: 'EGP',
    confidence: 0.92,
  }),
}));
vi.mock('@api/services/sequence.service', () => ({ nextSequence: vi.fn() }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));

import { accountingExpenseOcrProcess } from '@api/lib/inngest/functions/accounting-expense-ocr-process';
import { PORTED_JOBS } from '@api/lib/jobs/job-data';
import { decideRunForStore } from '@api/lib/jobs/do-guard';

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> =>
    JSON.parse(JSON.stringify(await fn())),
};
const event = {
  name: 'accounting/expense-ocr-process',
  data: { storeId: DO_STORE, receiptUrl: 'https://r2.example/receipts/a1.jpg', uploadedBy: 'u1' },
};
const run = (ev = event) =>
  (accountingExpenseOcrProcess as unknown as { handler: (a: unknown) => Promise<any> }).handler({
    event: ev,
    step,
  });

beforeEach(() => {
  h.drafts.clear();
  h.keys.length = 0;
  h.accounts = { '1000': 'acc-cash', '5990': 'acc-misc', '5500': 'acc-util' };
  vi.stubEnv('JOBS_ON_DO', '1');
  vi.stubEnv('STORE_DO_ENABLED_IDS', DO_STORE);
});

describe('accounting-expense-ocr-process on a DO store', () => {
  it('is ported and not refused', () => {
    expect(PORTED_JOBS.has('accounting-expense-ocr-process')).toBe(true);
    expect(decideRunForStore({ id: 'accounting-expense-ocr-process' } as never, DO_STORE)).toEqual({
      run: true,
    });
  });

  it('drafts the parsed receipt through the DO op, OCR metadata included', async () => {
    expect(await run()).toEqual({ expenseId: 'exp-1' });
    const { args } = [...h.drafts.values()][0];
    expect(args).toMatchObject({
      expenseAccountId: 'acc-util',
      paidFromAccountId: 'acc-cash',
      amount: 11400,
      taxAmount: 1400,
      total: 12800,
      currency: 'EGP',
      fxRate: 1,
      createdBy: 'u1',
    });
    expect(args.ocr).toMatchObject({ confidence: 0.92, json: { vendor: 'Cairo Electric' } });
  });

  it('double fire: one draft, the retry gets the first one back', async () => {
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(h.drafts.size).toBe(1);
    expect(new Set(h.keys).size).toBe(1);
  });

  it('a missing chart of accounts fails the job (retried) and writes nothing', async () => {
    h.accounts = {};
    await expect(run()).rejects.toThrow(/seed COA first/);
    expect(h.drafts.size).toBe(0);
  });
});
