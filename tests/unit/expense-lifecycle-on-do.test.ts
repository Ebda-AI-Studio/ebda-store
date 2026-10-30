/**
 * Ruling CF-EXP-1: approve / post / reject / list / get of an expense on a store on its Durable Object read and write the DO (one
 * conditional `expenseTransition` section), never Postgres (whose copy is sealed), and posting fires `accounting/expense-posted`
 * so the (ported) journal job books the GL entry on the DO. A Postgres store keeps its original path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  backend: 'do' as 'do' | 'pg',
  row: { id: 'e1', status: 'draft', createdBy: 'creator' } as Record<string, unknown>,
  transitions: [] as any[],
  sent: [] as any[],
  twoStep: false,
  pgExpense: {
    findFirst: vi.fn(async () => ({ id: 'e1', status: 'approved', createdBy: null })),
    update: vi.fn(async () => ({ id: 'e1', status: 'posted' })),
  },
}));
vi.mock('@ebda/database', async () => {
  const mock = await import('./helpers/database-mock');
  return mock.databaseMock({
    prisma: {
      expense: h.pgExpense,
      store: { findUnique: async () => ({ expenseTwoStepApproval: h.twoStep }) },
    },
    extra: {},
  });
});
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeRepo: async () =>
    h.backend === 'do'
      ? {
          backend: 'do',
          db: {
            expense: {
              findFirst: async () => ({ ...h.row }),
              findMany: async () => [{ ...h.row }],
              count: async () => 1,
            },
          },
          money: {
            expenseTransition: async (a: any) => {
              h.transitions.push(a);
              const from = String(h.row.status);
              const ok =
                a.action === 'post' ? from === 'approved' : ['draft', 'pending'].includes(from);
              if (ok)
                h.row.status =
                  a.action === 'post'
                    ? 'posted'
                    : a.action === 'reject'
                      ? 'rejected'
                      : a.pending
                        ? 'pending'
                        : 'approved';
              return { found: true, changed: ok, status: String(h.row.status) };
            },
          },
        }
      : { backend: 'pg', db: {}, money: null },
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: async (e: unknown) => void h.sent.push(e) },
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  approveExpense,
  getExpense,
  listExpenses,
  postExpense,
  rejectExpense,
} from '../../apps/api/src/services/accounting/expense.service';

const STORE = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

beforeEach(() => {
  vi.clearAllMocks();
  h.backend = 'do';
  h.row = { id: 'e1', status: 'draft', createdBy: 'creator' };
  h.transitions.length = 0;
  h.sent.length = 0;
  h.twoStep = false;
});

describe('expense lifecycle on a DO store (Ruling CF-EXP-1)', () => {
  it('draft -> approved -> posted, and posting fires the journal event for the DO store', async () => {
    await approveExpense(STORE, 'e1', 'approver');
    expect(h.row.status).toBe('approved');
    expect(h.sent).toEqual([]);
    await postExpense(STORE, 'e1');
    expect(h.row.status).toBe('posted');
    expect(h.sent).toEqual([
      { name: 'accounting/expense-posted', data: { storeId: STORE, expenseId: 'e1' } },
    ]);
    expect(h.pgExpense.findFirst).not.toHaveBeenCalled();
    expect(h.pgExpense.update).not.toHaveBeenCalled();
  });

  it('the two-step rule: the creator approving their own expense leaves it pending', async () => {
    h.twoStep = true;
    await approveExpense(STORE, 'e1', 'creator');
    expect(h.transitions[0]).toMatchObject({ action: 'approve', pending: true });
    expect(h.row.status).toBe('pending');
    h.row.status = 'draft';
    await approveExpense(STORE, 'e1', 'someone-else');
    expect(h.transitions[1]).toMatchObject({ action: 'approve', pending: false });
  });

  it('posting an unapproved expense throws the Postgres error text and fires no event', async () => {
    await expect(postExpense(STORE, 'e1')).rejects.toThrow(
      'Expense e1 must be approved before posting (status=draft)'
    );
    expect(h.sent).toEqual([]);
  });

  it('rejecting a posted expense is refused; a draft is rejected', async () => {
    await rejectExpense(STORE, 'e1');
    expect(h.row.status).toBe('rejected');
    await expect(rejectExpense(STORE, 'e1')).rejects.toThrow(
      'cannot be rejected (status=rejected)'
    );
  });

  it('list and get read the DO, never Postgres', async () => {
    const list = await listExpenses(STORE, { status: 'draft' });
    expect(list.total).toBe(1);
    expect((await getExpense(STORE, 'e1'))?.id).toBe('e1');
    expect(h.pgExpense.findFirst).not.toHaveBeenCalled();
  });

  it('a Postgres store keeps its own path', async () => {
    h.backend = 'pg';
    await postExpense(STORE, 'e1');
    expect(h.pgExpense.update).toHaveBeenCalled();
    expect(h.transitions).toEqual([]);
  });
});
