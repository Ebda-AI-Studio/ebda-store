import { prisma } from '@ebda/database';
import { postEntry } from '../journal.service';
import { getSystemAccountIdByCode } from '../account.service';
import logger from '../../../lib/logger';
import { storeMoney } from '../../../lib/repo-factory';

export interface ExpenseJournalInput {
  storeId: string;
  expenseId: string;
}

/**
 * Post the GL journal for an expense.
 *
 *   DR expenseAccount  (total - tax)
 *   DR Input VAT 1300  (tax)          -- only when the chart has 1300 and the tax is > 0
 *   CR paidFromAccount (total)
 *
 * A chart without 1300 (a store not re-seeded yet) keeps the old gross posting:
 *   DR expenseAccount (total) / CR paidFromAccount (total).
 *
 * Idempotent via postEntry's (source, sourceId) check.
 * Guards: skips if expense not found, accounting disabled, or not posted.
 */
/** The store's account for `code`, or null when its chart does not have it yet (never throws). */
async function findAccountIdByCode(storeId: string, code: string): Promise<string | null> {
  try {
    return await getSystemAccountIdByCode(storeId, code);
  } catch {
    return null;
  }
}

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

  // ACCT-AUDIT-10: the VAT on a purchase is recoverable (Input VAT 1300), not part of the expense. A chart with no 1300 yet
  // keeps the old gross posting.
  const tax = Math.min(Math.max(expense.taxAmount ?? 0, 0), total);
  const inputVat = tax > 0 ? await findAccountIdByCode(args.storeId, '1300') : null;
  const line = (accountId: string, debit: number, credit: number, lineMemo: string) => ({
    accountId,
    debit,
    credit,
    lineMemo,
    refTable: 'expenses',
    refId: expense.id,
  });
  const lines = [
    line(
      expense.expenseAccountId,
      inputVat ? total - tax : total,
      0,
      `Expense — ${expense.expenseNumber}`
    ),
    ...(inputVat ? [line(inputVat, tax, 0, `Input VAT — ${expense.expenseNumber}`)] : []),
    line(expense.paidFromAccountId, 0, total, `Paid — ${expense.expenseNumber}`),
  ];

  await postEntry({
    storeId: args.storeId,
    source: 'expense',
    sourceId: expense.id,
    // ACCT-AUDIT-3: dated by the expense itself, never later than now
    postedAt: expense.expenseDate < new Date() ? expense.expenseDate : new Date(),
    memo: `Expense — ${expense.expenseNumber}`,
    memoAr: `مصروف — ${expense.expenseNumber}`,
    lines,
  });

  logger.info({ expenseId: expense.id, total }, 'postExpenseJournal: posted');
}
