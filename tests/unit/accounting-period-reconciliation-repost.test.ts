/**
 * ACCT-AUDIT-5: the nightly period reconciliation re-posts journals whose trigger was lost, and the expense expense-posted
 * trigger that cannot be enqueued posts the journal inline instead of leaving a posted expense with no entry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';
const h = vi.hoisted(() => ({
  repost: vi.fn(async (_a: { includeExpenses?: boolean }) => ({
    expenses: 1,
    stockAdjustments: 0,
    purchaseOrders: 2,
  })),
  expensesOn: true,
  sendAlert: vi.fn(async () => 'sent'),
}));

vi.mock('@ebda/database', async () =>
  (await import('./helpers/database-mock')).databaseMock({
    prisma: {},
    extra: { storeDirectory: async () => [{ id: STORE, name: 'Demo', slug: 'demo' }] },
  })
);
vi.mock('@api/lib/repo-factory', () => ({
  storeMoney: async () => ({
    journalRepostMissing: h.repost,
    periodGlCredits: async () => ({ total: 0 }),
  }),
  storeDb: async () => ({ order: { aggregate: async () => ({ _sum: { total: 0 } }) } }),
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    send: vi.fn(),
    createFunction: (options: unknown, handler: unknown) => ({ options, handler }),
  },
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: h.sendAlert }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => h.expensesOn },
}));

import { accountingPeriodReconciliation } from '@api/lib/inngest/functions/accounting-period-reconciliation';

const step = {
  run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> =>
    JSON.parse(JSON.stringify(await fn())),
};
const run = () =>
  (accountingPeriodReconciliation as unknown as { handler: (a: unknown) => Promise<any> }).handler({
    event: { name: 'cron' },
    step,
  });

beforeEach(() => {
  h.repost.mockClear();
  h.expensesOn = true;
});

describe('accounting-period-reconciliation: lost-trigger sweep', () => {
  it('re-posts for the store and reports how many journals it healed', async () => {
    const r = await run();
    expect(h.repost).toHaveBeenCalledWith({ includeExpenses: true });
    expect(r).toMatchObject({ stores: 1, reposted: 3 });
  });

  it('keeps expenses out of the sweep while accounting.expenses is off', async () => {
    h.expensesOn = false;
    await run();
    expect(h.repost).toHaveBeenCalledWith({ includeExpenses: false });
  });
});
