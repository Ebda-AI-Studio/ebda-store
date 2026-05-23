import { prisma } from '@force/database';
import type { Expense } from '@prisma/client';
import { nextSequence } from '../sequence.service';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';

export interface CreateExpenseInput {
  storeId: string;
  supplierId?: string;
  expenseAccountId: string;
  paidFromAccountId: string;
  amount: number;
  taxAmount?: number;
  expenseDate: Date | string;
  currency?: string;
  receiptImageUrl?: string;
  notes?: string;
  notesAr?: string;
  createdBy?: string;
}

export type ExpenseWithRelations = Expense & {
  supplier: { id: string; name: string; nameAr: string | null } | null;
  expenseAccount: { id: string; nameEn: string; nameAr: string | null; code: string };
  paidFromAccount: { id: string; nameEn: string; nameAr: string | null; code: string };
};

/**
 * Create a draft Expense. total = amount + taxAmount.
 * Status is always 'draft' on creation.
 */
export async function createExpense(input: CreateExpenseInput): Promise<ExpenseWithRelations> {
  const expenseNumber = await nextSequence(input.storeId, 'expense');
  const taxAmount = input.taxAmount ?? 0;
  const total = input.amount + taxAmount;

  return prisma.expense.create({
    data: {
      storeId: input.storeId,
      expenseNumber,
      supplierId: input.supplierId ?? null,
      expenseAccountId: input.expenseAccountId,
      paidFromAccountId: input.paidFromAccountId,
      amount: input.amount,
      taxAmount,
      total,
      currency: input.currency ?? 'KWD',
      expenseDate: new Date(input.expenseDate),
      status: 'draft',
      receiptImageUrl: input.receiptImageUrl ?? null,
      notes: input.notes ?? null,
      notesAr: input.notesAr ?? null,
      createdBy: input.createdBy ?? null,
    },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });
}

/**
 * Approve a draft (or pending) expense.
 *
 * Two-step approval rule: if the store has `expenseTwoStepApproval = true`
 * AND the approver is the same user who created the expense, the status
 * transitions to 'pending' (waiting for a second approver). In all other
 * cases, it transitions directly to 'approved'.
 */
export async function approveExpense(
  storeId: string,
  id: string,
  userId?: string
): Promise<ExpenseWithRelations> {
  const expense = await prisma.expense.findFirst({
    where: { id, storeId },
    include: { store: { select: { expenseTwoStepApproval: true } } },
  });

  if (!expense) throw new Error(`Expense ${id} not found in store ${storeId}`);
  if (!['draft', 'pending'].includes(expense.status)) {
    throw new Error(`Expense ${id} cannot be approved (status=${expense.status})`);
  }

  const twoStep = expense.store?.expenseTwoStepApproval ?? false;
  const selfApproval = twoStep && userId != null && userId === expense.createdBy;
  const nextStatus = selfApproval ? 'pending' : 'approved';

  return prisma.expense.update({
    where: { id },
    data: {
      status: nextStatus,
      approvedBy: nextStatus === 'approved' ? (userId ?? null) : null,
      approvedAt: nextStatus === 'approved' ? new Date() : null,
    },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });
}

/**
 * Post an approved expense: transitions approved → posted, sets postedAt,
 * then fires `accounting/expense-posted` so the GL journal posts async.
 */
export async function postExpense(storeId: string, id: string): Promise<ExpenseWithRelations> {
  const expense = await prisma.expense.findFirst({ where: { id, storeId } });

  if (!expense) throw new Error(`Expense ${id} not found in store ${storeId}`);
  if (expense.status !== 'approved') {
    throw new Error(`Expense ${id} must be approved before posting (status=${expense.status})`);
  }

  const updated = await prisma.expense.update({
    where: { id },
    data: { status: 'posted', postedAt: new Date() },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });

  // Fire async journal posting — non-blocking; journal service is idempotent
  try {
    await inngest.send({
      name: 'accounting/expense-posted',
      data: { storeId, expenseId: id },
    });
  } catch (err) {
    logger.error({ err, expenseId: id, storeId }, 'postExpense: failed to fire inngest event');
  }

  return updated;
}

/**
 * Reject a draft or pending expense.
 */
export async function rejectExpense(storeId: string, id: string): Promise<ExpenseWithRelations> {
  const expense = await prisma.expense.findFirst({ where: { id, storeId } });

  if (!expense) throw new Error(`Expense ${id} not found in store ${storeId}`);
  if (!['draft', 'pending'].includes(expense.status)) {
    throw new Error(`Expense ${id} cannot be rejected (status=${expense.status})`);
  }

  return prisma.expense.update({
    where: { id },
    data: { status: 'rejected' },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });
}

export interface ListExpensesOptions {
  status?: string;
  page?: number;
  perPage?: number;
  from?: Date;
  to?: Date;
}

/**
 * Paginated list of expenses for a store with optional status + date filters.
 */
export async function listExpenses(
  storeId: string,
  opts: ListExpensesOptions = {}
): Promise<{ items: ExpenseWithRelations[]; total: number; page: number; perPage: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 50));
  const skip = (page - 1) * perPage;

  const where: any = {
    storeId,
    ...(opts.status ? { status: opts.status as any } : {}),
  };

  if (opts.from || opts.to) {
    where.expenseDate = {};
    if (opts.from) where.expenseDate.gte = opts.from;
    if (opts.to) where.expenseDate.lte = opts.to;
  }

  const include = {
    supplier: { select: { id: true, name: true, nameAr: true } },
    expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
  } as const;

  const [items, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { expenseDate: 'desc' },
      skip,
      take: perPage,
      include,
    }),
    prisma.expense.count({ where }),
  ]);

  return { items: items as unknown as ExpenseWithRelations[], total, page, perPage };
}

/**
 * Full detail for a single expense.
 */
export async function getExpense(
  storeId: string,
  id: string
): Promise<ExpenseWithRelations | null> {
  return prisma.expense.findFirst({
    where: { id, storeId },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });
}
