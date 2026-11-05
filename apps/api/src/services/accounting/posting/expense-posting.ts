import { prisma } from '@ebda/database';
import { postEntry } from '../journal.service';
import logger from '../../../lib/logger';
import { storeMoney } from '../../../lib/repo-factory';

export interface ExpenseJournalInput {
  storeId: string;
  expenseId: string;
}

/**
 * Post the GL journal for an expense.
 *
 * v1 simplification: tax recovery is deferred until Egypt VAT activates.
 * The full expense total (amount + taxAmount) is debited to the merchant's
 * chosen expense account and credited from the chosen payment account.
 * When VAT becomes applicable, the tax portion should be split into a
 * separate DR to a Tax Recoverable asset account.
 *
 *   DR expenseAccount  (total)
 *   CR paidFromAccount (total)
 *
 * Idempotent via postEntry's (source, sourceId) check.
 * Guards: skips if expense not found, accounting disabled, or not posted.
 */
export async function postExpenseJournal(args: ExpenseJournalInput): Promise<void> {
  // A store on its Durable Object posts in one section there (Ruling CF-JOBS-4); idempotent per source row.
  const money = await storeMoney(args.storeId);
  if (money) {
    await money.journalExpense({ expenseId: args.expenseId });
    return;
  }
  const expense = await prisma.expense.findFirst({
    where: { id: args.expenseId, storeId: args.storeId },
    include: { store: { select: { accountingEnabled: true } } },
  });

  if (!expense) {
    logger.warn(
      { expenseId: args.expenseId, storeId: args.storeId },
      'postExpenseJournal: expense not found'
    );
    return;
  }

  if (!expense.store?.accountingEnabled) {
    logger.info(
      { expenseId: args.expenseId, storeId: args.storeId },
      'postExpenseJournal: accounting disabled'
    );
    return;
  }

  if (expense.status !== 'posted') {
    logger.warn(
      { expenseId: args.expenseId, status: expense.status },
      'postExpenseJournal: expense not in posted status'
    );
    return;
  }

  const total = expense.total;
  if (total === 0) {
    logger.info(
      { expenseId: args.expenseId },
      'postExpenseJournal: zero total — no journal needed'
    );
    return;
  }

  const lines = [
    {
      accountId: expense.expenseAccountId,
      debit: total,
      credit: 0,
      lineMemo: `Expense — ${expense.expenseNumber}`,
      refTable: 'expenses',
      refId: expense.id,
    },
    {
      accountId: expense.paidFromAccountId,
      debit: 0,
      credit: total,
      lineMemo: `Paid — ${expense.expenseNumber}`,
      refTable: 'expenses',
      refId: expense.id,
    },
  ];

  await postEntry({
    storeId: args.storeId,
    source: 'expense',
    sourceId: expense.id,
    memo: `Expense — ${expense.expenseNumber}`,
    memoAr: `مصروف — ${expense.expenseNumber}`,
    lines,
  });

  logger.info({ expenseId: expense.id, total }, 'postExpenseJournal: posted');
}
