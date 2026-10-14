/**
 * Issue 2429 — a paged list sorted by a NON-UNIQUE key is not a stable pager. Page 1 and page 2 are
 * independent top-N sorts, so rows that tie on the key can swap sides and one row shows twice while
 * another never shows. `expenses.expenseDate` is a calendar day (UTC midnight): every expense of a
 * day ties byte-for-byte. Each of these lists needs a unique tiebreaker (`id`) as the LAST key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { expenseFindMany, poFindMany } = vi.hoisted(() => ({
  expenseFindMany: vi.fn(),
  poFindMany: vi.fn(),
}));

vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    prisma: {
      expense: { findMany: expenseFindMany, count: vi.fn().mockResolvedValue(0) },
      purchaseOrder: { findMany: poFindMany, count: vi.fn().mockResolvedValue(0) },
    },
  };
});

import { listExpenses } from '@api/services/accounting/expense.service';
import { listPurchaseOrders } from '@api/services/accounting/purchase-order.service';

const lastKeyIsId = (orderBy: unknown) => {
  expect(Array.isArray(orderBy)).toBe(true);
  const keys = orderBy as Record<string, unknown>[];
  expect(Object.keys(keys[keys.length - 1])).toEqual(['id']);
  expect(keys.length).toBeGreaterThan(1);
};

describe('paged lists end their sort with a unique key (issue 2429)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expenseFindMany.mockResolvedValue([]);
    poFindMany.mockResolvedValue([]);
  });

  it('listExpenses sorts expenseDate desc, then id', async () => {
    await listExpenses('store-1', { page: 2, perPage: 10 });
    const arg = expenseFindMany.mock.calls[0][0];
    expect(arg.orderBy[0]).toEqual({ expenseDate: 'desc' });
    lastKeyIsId(arg.orderBy);
    expect(arg.skip).toBe(10);
  });

  it('listPurchaseOrders sorts createdAt desc, then id', async () => {
    await listPurchaseOrders('store-1', { page: 1, perPage: 5 });
    lastKeyIsId(poFindMany.mock.calls[0][0].orderBy);
  });

  it('listPurchaseOrders searches PO number and supplier name server-side (issue 2430)', async () => {
    await listPurchaseOrders('store-1', { q: 'acme' });
    expect(poFindMany.mock.calls[0][0].where.OR).toEqual([
      { poNumber: { contains: 'acme', mode: 'insensitive' } },
      { supplier: { name: { contains: 'acme', mode: 'insensitive' } } },
    ]);
    await listPurchaseOrders('store-1', {});
    expect(poFindMany.mock.calls[1][0].where.OR).toBeUndefined();
  });

  // Route/service call sites that need a DB-backed router to exercise; pinned at source level.
  const ROOT = resolve(__dirname, '../..');
  const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
  const cases: [string, string, RegExp][] = [
    [
      'apps/api/src/routes/finance.routes.ts',
      'journal',
      /orderBy: \[\{ postedAt: 'desc' \}, \{ id: 'desc' \}\]/,
    ],
    [
      'apps/api/src/routes/finance.routes.ts',
      'bank statements',
      /orderBy: \[\{ importedAt: 'desc' \}, \{ id: 'desc' \}\]/,
    ],
    [
      'apps/api/src/routes/finance.routes.ts',
      'bank transactions',
      /orderBy: \[\{ date: 'asc' \}, \{ id: 'asc' \}\]/,
    ],
    [
      'apps/api/src/routes/smart-layer.routes.ts',
      'reorder suggestions',
      /orderBy: \[\{ urgencyDays: 'asc' \}, \{ id: 'asc' \}\]/,
    ],
    [
      'apps/api/src/services/loyalty.service.ts',
      'loyalty members',
      /orderBy: \[\{ totalEarned: 'desc' \}, \{ id: 'desc' \}\]/,
    ],
  ];
  for (const [file, name, re] of cases) {
    it(`${name} list has an id tiebreaker`, () => {
      expect(read(file)).toMatch(re);
    });
  }
});
