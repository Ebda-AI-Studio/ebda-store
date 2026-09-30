import { assertStoreOwnsInTenantScope } from './assert-store-owns';
import { prisma, hasTenantContext, runInTenantContext } from '@force/database';
import type { Expense } from '@prisma/client';
import {
  isCashOrBankAccount,
  convertToKwd,
  requiresFxRate,
  ALLOWED_CURRENCIES,
} from '@force/shared';
import { nextSequence } from '../sequence.service';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';

export interface CreateExpenseInput {
  storeId: string;
  supplierId?: string;
  expenseAccountId: string;
  paidFromAccountId: string;
  /**
   * When currency=KWD (or absent): amount in KWD fils.
   * When currency≠KWD: amount in the FOREIGN currency's minor units (e.g. USD cents).
   *   The service converts to KWD fils using fxRate and stores both.
   */
  amount: number;
  taxAmount?: number;
  expenseDate: Date | string;
  /** ISO-4217 code. Defaults to 'KWD'. */
  currency?: string;
  /**
   * FX rate: 1 unit of `currency` = fxRate KWD.
   * Required when currency !== 'KWD'. Stored as Decimal (exact; no float drift).
   * For non-KWD OCR drafts where the rate is unknown, omit and the service
   * stores fxRate=1 as a placeholder; the merchant must update before posting.
   */
  fxRate?: number;
  /**
   * Pre-computed original amount in foreign minor units.
   * When absent, defaults to `amount` (the caller's raw input).
   */
  originalAmount?: number;
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
  // Issue 2291: with no ambient tenant transaction (the expense-OCR Inngest
  // job) the guard below opened its own transient transaction, but every
  // statement after it — the paid-from lookup and the INSERT, both on STRICT
  // RLS tables — ran GUC-less: under force_app the lookup reads nothing (a
  // misleading 400 INVALID_PAID_FROM) and the insert is rejected. The whole
  // body now runs in ONE store-scoped transaction, which also closes the
  // guard-vs-write window. The HTTP route already wraps it, so there it joins.
  if (!hasTenantContext()) {
    return runInTenantContext(input.storeId, () => createExpenseInScope(input));
  }
  return createExpenseInScope(input);
}

async function createExpenseInScope(input: CreateExpenseInput): Promise<ExpenseWithRelations> {
  // paidFromAccountId is validated against this store a few lines down, but
  // supplierId and expenseAccountId were written straight from the body — the
  // asymmetry is the bug. A foreign account/supplier id leaks its code and
  // name back through the read path.
  //
  // #1241 / issue 2057: the guard must run under the store's RLS GUC —
  // on the ambient request transaction when there is one, in its own
  // tenant-scoped transaction when there is not (Inngest callers). See
  // assertStoreOwnsInTenantScope.
  await assertStoreOwnsInTenantScope(input.storeId, {
    supplierIds: [input.supplierId],
    accountIds: [input.expenseAccountId],
  });

  // Money guard: the "paid from" account MUST be a cash/bank account so the
  // double-entry is correct (debit expense, credit cash). Paying out of
  // Inventory / Fixed Assets / AR would post a wrong credit. We validate the
  // account belongs to THIS store (tenant isolation) and is in the cash/bank
  // band before creating the draft.
  const paidFrom = await prisma.account.findFirst({
    where: { id: input.paidFromAccountId, storeId: input.storeId },
    select: { code: true, type: true },
  });
  if (!paidFrom) {
    throw new AppError(400, 'INVALID_PAID_FROM', 'Paid-from account not found for this store.');
  }
  if (!isCashOrBankAccount(paidFrom)) {
    throw new AppError(
      400,
      'INVALID_PAID_FROM',
      'Paid-from account must be a cash or bank account (codes 1000–1099).'
    );
  }

  const expenseNumber = await nextSequence(input.storeId, 'expense');
  const currency = (input.currency ?? 'KWD').toUpperCase();

  // Validate currency against the allowed set
  if (!ALLOWED_CURRENCIES.includes(currency as (typeof ALLOWED_CURRENCIES)[number])) {
    throw new AppError(422, 'INVALID_CURRENCY', `Currency '${currency}' is not supported.`);
  }

  // ── Multi-currency FX conversion ──────────────────────────────────────────
  // When currency is KWD: input.amount is already in KWD fils — no conversion.
  // When currency is non-KWD:
  //   - input.amount is in the FOREIGN currency's minor units (e.g. USD cents).
  //   - fxRate converts: 1 foreign unit → fxRate KWD.
  //   - If fxRate is not provided, we store fxRate=1 as a placeholder and flag
  //     the expense so the merchant reviews before posting.
  let amountKwd: number;
  let taxAmountKwd: number;
  let fxRateToStore: number;
  let originalAmountToStore: number;
  let originalTaxAmountToStore: number;

  if (!requiresFxRate(currency)) {
    // KWD path — identical to before
    amountKwd = input.amount;
    taxAmountKwd = input.taxAmount ?? 0;
    fxRateToStore = 1;
    originalAmountToStore = input.amount;
    originalTaxAmountToStore = input.taxAmount ?? 0;
  } else {
    // Non-KWD path
    const rate = input.fxRate ?? 1; // placeholder if not supplied
    if (rate <= 0 || !isFinite(rate)) {
      throw new AppError(422, 'INVALID_FX_RATE', 'fxRate must be a finite positive number.');
    }
    const rawAmount = input.originalAmount ?? input.amount;
    const rawTax = input.taxAmount ?? 0;
    amountKwd = convertToKwd(rawAmount, rate);
    taxAmountKwd = convertToKwd(rawTax, rate);
    fxRateToStore = rate;
    originalAmountToStore = rawAmount;
    originalTaxAmountToStore = rawTax;
  }

  const total = amountKwd + taxAmountKwd;
  const taxAmount = taxAmountKwd;

  return prisma.expense.create({
    data: {
      storeId: input.storeId,
      expenseNumber,
      supplierId: input.supplierId ?? null,
      expenseAccountId: input.expenseAccountId,
      paidFromAccountId: input.paidFromAccountId,
      amount: amountKwd,
      taxAmount,
      total,
      currency,
      fxRate: fxRateToStore,
      // originalAmount stores the TOTAL original foreign amount (amount + tax in foreign units)
      // so it mirrors how `total` mirrors (amount + tax) in KWD fils.
      originalAmount: originalAmountToStore + originalTaxAmountToStore,
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
  /**
   * Only expenses that came from a receipt (the upload → OCR path). Keyed on
   * the receipt, not `ocrProcessedAt`: an upload whose OCR was skipped or
   * failed still creates a draft that needs the same review.
   */
  hasOcr?: boolean;
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
    ...(opts.hasOcr ? { receiptImageUrl: { not: null } } : {}),
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
