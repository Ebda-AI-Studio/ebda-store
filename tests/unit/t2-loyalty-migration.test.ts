/** FP-2: the one-off Postgres -> DO loyalty ledger migration. Dry run by default; apply sends each customer's rows once. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany, money } = vi.hoisted(() => ({
  findMany: vi.fn(),
  money: {
    loyaltyStats: vi.fn(),
    loyaltyImport: vi.fn(),
  },
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  prisma: { loyaltyTransaction: { findMany } },
}));
const storeMoney = vi.fn();
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: (...a: unknown[]) => storeMoney(...a),
  storeUpdate: vi.fn(),
}));
vi.mock('@api/services/feature.service', () => ({ featureService: {} }));
vi.mock('@api/lib/store-customer', () => ({ assertStoreCustomer: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { LoyaltyService } from '@api/services/loyalty.service';

const t = (id: string, customerId: string, points: number) => ({
  id,
  customerId,
  orderId: null,
  type: 'earn_manual',
  points,
  description: null,
  expiresAt: null,
  createdAt: new Date(1000),
});

beforeEach(() => {
  vi.clearAllMocks();
  storeMoney.mockResolvedValue(money);
  money.loyaltyStats.mockResolvedValue({ totalMembers: 1 });
  money.loyaltyImport.mockResolvedValue({ inserted: 2, skipped: 0, newBalance: 0 });
  findMany.mockResolvedValue([t('a', 'c1', 10), t('b', 'c1', 20), t('c', 'c2', 5)]);
});

describe('LoyaltyService.migrateLedgerToDo', () => {
  it('is a dry run by default: reports, writes nothing', async () => {
    const r = await LoyaltyService.migrateLedgerToDo('s1');
    expect(r).toMatchObject({ dryRun: true, customers: 2, rows: 3, pgPoints: 35, inserted: 0 });
    expect(r.doStatsAfter).toBeNull();
    expect(money.loyaltyImport).not.toHaveBeenCalled();
  });

  it('applies one import per customer with epoch-ms times and reports the DO stats after', async () => {
    const r = await LoyaltyService.migrateLedgerToDo('s1', { dryRun: false });
    expect(money.loyaltyImport).toHaveBeenCalledTimes(2);
    expect(money.loyaltyImport.mock.calls[0][0]).toMatchObject({
      customerId: 'c1',
      rows: [
        expect.objectContaining({ id: 'a', createdAt: 1000 }),
        expect.objectContaining({ id: 'b' }),
      ],
    });
    expect(r.inserted).toBe(4);
    expect(r.doStatsAfter).not.toBeNull();
  });

  it('refuses a store that is not on its Durable Object', async () => {
    storeMoney.mockResolvedValue(null);
    await expect(LoyaltyService.migrateLedgerToDo('s1')).rejects.toMatchObject({
      code: 'NOT_A_DO_STORE',
    });
  });
});

describe('LoyaltyService.ensureDoHistory (FP-2: no DO answer without the customer history)', () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    Object.assign(money, {
      loyaltyImportState: vi.fn(async () => (calls.push('state'), { done: false })),
      loyaltyImport: vi.fn(
        async () => (calls.push('import'), { inserted: 1, skipped: 0, newBalance: 0 })
      ),
      loyaltyCustomerPoints: vi.fn(async () => (calls.push('read'), null)),
    });
    findMany.mockResolvedValue([t('a', 'c1', 10)]);
  });

  it('imports (and marks done on the last batch) BEFORE the first read, once per isolate', async () => {
    await LoyaltyService.ensureDoHistory('s-lazy', 'c-lazy', money as never);
    expect(calls).toEqual(['state', 'import']);
    expect(money.loyaltyImport).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'c-lazy', markDone: true })
    );
    await LoyaltyService.ensureDoHistory('s-lazy', 'c-lazy', money as never);
    expect(calls).toEqual(['state', 'import']); // second touch: nothing
  });

  it('a customer already flagged done is not read from Postgres again', async () => {
    (money.loyaltyImportState as any).mockResolvedValueOnce({ done: true });
    await LoyaltyService.ensureDoHistory('s-lazy', 'c-done', money as never);
    expect(findMany).not.toHaveBeenCalled();
    expect(money.loyaltyImport).not.toHaveBeenCalled();
  });

  it('a customer with no Postgres rows still gets the done flag', async () => {
    findMany.mockResolvedValue([]);
    await LoyaltyService.ensureDoHistory('s-lazy', 'c-empty', money as never);
    expect(money.loyaltyImport).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'c-empty', rows: [], markDone: true })
    );
  });

  it('getCustomerPoints imports first, then reads', async () => {
    const { featureService } = await import('@api/services/feature.service');
    (featureService as any).isFeatureEnabled = vi.fn(async () => true);
    await LoyaltyService.getCustomerPoints('s-read', 'c-read');
    expect(calls).toEqual(['state', 'import', 'read']);
  });
});
