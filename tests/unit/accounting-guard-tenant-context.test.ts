/**
 * #1241 (S2-tenancy-rls, 2026-09-25 security audit).
 *
 * `assertStoreOwns` defaults its `client` param to the bare `prisma`
 * singleton. Under today's BYPASSRLS role that is harmless (the explicit
 * `where: { storeId }` filter still scopes correctly), but four call sites —
 * stock-adjustment / purchase-order / expense's `create*` functions, and
 * bank-reconcile's `importBankStatement` — run this guard OUTSIDE any tenant
 * context at all: their routers are mounted CONTEXT-LESS (bare `/stores`,
 * `routes/index.ts` — "services already self-manage tenant context
 * per-query"), so under the RLS-ENFORCED posture planned for the
 * force_app cutover, a read with no GUC set returns zero rows and the guard
 * 404s every legitimately-owned id.
 *
 * These tests prove each call site now runs the guard in the SAME RLS
 * posture as the writes it protects: wrapped in its own
 * `runInTenantContext(storeId, …)` for the three `withMoneyTx` services, or
 * against the `withRlsBypass` transaction client for bank-reconcile.
 *
 * Each test makes `assertStoreOwns` throw a sentinel the instant it is
 * called, so execution never reaches the real (unmocked) Prisma calls further
 * down each function — the only thing under test is WHERE, relative to the
 * tenant-context boundary, the guard runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const order: string[] = [];
const STOP = new Error('stop-after-guard');

const mockAssertStoreOwns = vi.fn(async () => {
  order.push('assertStoreOwns');
  throw STOP;
});

vi.mock('@api/services/accounting/assert-store-owns', () => ({
  assertStoreOwns: (...args: unknown[]) => mockAssertStoreOwns(...args),
}));

const mockRunInTenantContext = vi.fn(
  async (_storeId: string | undefined, fn: () => Promise<unknown>) => {
    order.push('runInTenantContext:enter');
    try {
      return await fn();
    } finally {
      order.push('runInTenantContext:exit');
    }
  }
);

const mockTx = { marker: 'rls-bypass-tx' };
const mockWithRlsBypass = vi.fn(async (fn: (tx: typeof mockTx) => unknown) => {
  order.push('withRlsBypass:enter');
  try {
    return await fn(mockTx);
  } finally {
    order.push('withRlsBypass:exit');
  }
});

vi.mock('@force/database', () => ({
  prisma: {},
  Prisma: {},
  withMoneyTx: vi.fn(),
  withRlsBypass: (...args: unknown[]) => mockWithRlsBypass(...(args as [(tx: unknown) => unknown])),
  runInTenantContext: (...args: unknown[]) =>
    mockRunInTenantContext(...(args as [string, () => Promise<unknown>])),
}));

vi.mock('@api/services/sequence.service', () => ({ nextSequence: vi.fn() }));
vi.mock('@api/services/accounting/account.service', () => ({
  getSystemAccountIdByCode: vi.fn(),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/warehouse.service', () => ({ WarehouseService: {} }));
vi.mock('@api/lib/effective-inventory', () => ({ effectiveInventory: vi.fn() }));
vi.mock('@api/services/accounting/bank-statement-parser', () => ({
  parseStatementCsv: vi.fn(() => ({ rows: [], skipped: 0, errors: [] })),
  parseStatementOfx: vi.fn(() => ({ rows: [], skipped: 0, errors: [] })),
}));

const STORE_ID = 'store-1';

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe('#1241 — the tenant-ownership guard runs INSIDE a tenant-scoped context', () => {
  it('stock-adjustment.createAdjustment wraps assertStoreOwns in runInTenantContext', async () => {
    const { createAdjustment } = await import('@api/services/accounting/stock-adjustment.service');

    await expect(
      createAdjustment({
        storeId: STORE_ID,
        type: 'cycle_count',
        items: [{ productId: 'p-1', newQty: 5 }],
      })
    ).rejects.toBe(STOP);

    expect(mockRunInTenantContext).toHaveBeenCalledWith(STORE_ID, expect.any(Function));
    expect(order).toEqual([
      'runInTenantContext:enter',
      'assertStoreOwns',
      'runInTenantContext:exit',
    ]);
  });

  it('purchase-order.createPurchaseOrder wraps assertStoreOwns in runInTenantContext', async () => {
    const { createPurchaseOrder } = await import('@api/services/accounting/purchase-order.service');

    await expect(
      createPurchaseOrder({
        storeId: STORE_ID,
        supplierId: 'sup-1',
        items: [{ productId: 'p-1', qty: 1, unitCost: 100 }],
      })
    ).rejects.toBe(STOP);

    expect(mockRunInTenantContext).toHaveBeenCalledWith(STORE_ID, expect.any(Function));
    expect(order).toEqual([
      'runInTenantContext:enter',
      'assertStoreOwns',
      'runInTenantContext:exit',
    ]);
  });

  it('expense.createExpense wraps assertStoreOwns in runInTenantContext', async () => {
    const { createExpense } = await import('@api/services/accounting/expense.service');

    await expect(
      createExpense({
        storeId: STORE_ID,
        supplierId: 'sup-1',
        expenseAccountId: 'acct-1',
        paidFromAccountId: 'acct-2',
        amount: 1000,
        currency: 'KWD',
        date: new Date(),
      } as never)
    ).rejects.toBe(STOP);

    expect(mockRunInTenantContext).toHaveBeenCalledWith(STORE_ID, expect.any(Function));
    expect(order).toEqual([
      'runInTenantContext:enter',
      'assertStoreOwns',
      'runInTenantContext:exit',
    ]);
  });

  it('bank-reconcile.importBankStatement runs assertStoreOwns against the withRlsBypass tx, not the bare client', async () => {
    const { importBankStatement } = await import('@api/services/accounting/bank-reconcile.service');

    await expect(
      importBankStatement({
        storeId: STORE_ID,
        glAccountId: 'acct-1',
        fileName: 'statement.csv',
        buffer: Buffer.from(''),
        fileType: 'csv',
      } as never)
    ).rejects.toBe(STOP);

    expect(mockWithRlsBypass).toHaveBeenCalled();
    expect(order).toEqual(['withRlsBypass:enter', 'assertStoreOwns', 'withRlsBypass:exit']);
    // Third argument is the transaction client `withRlsBypass` handed in —
    // not the module-level `prisma` singleton.
    expect(mockAssertStoreOwns).toHaveBeenCalledWith(STORE_ID, { accountIds: ['acct-1'] }, mockTx);
  });
});
