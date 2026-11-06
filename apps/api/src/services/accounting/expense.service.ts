import { assertStoreOwnsInTenantScope } from './assert-store-owns';
import { prisma, hasTenantContext, runInTenantContext, withStore } from '@ebda/database';
import type { Expense } from '@prisma/client';
import {
  isCashOrBankAccount,
  convertToBase,
  requiresFxRate,
  ALLOWED_CURRENCIES,
  REGION,
} from '@ebda/shared';
import { createHash } from 'node:crypto';
import { nextSequence } from '../sequence.service';
import { storeRepo } from '../../lib/repo-factory';
import { inngest } from '../../lib/inngest/client';
import logger from '../../lib/logger';
import { AppError } from '../../middleware/error-handler';

export interface CreateExpenseInput {
  storeId: string;
  supplierId?: string;
  expenseAccountId: string;
  paidFromAccountId: string;
  /**
   * When currency=EGP (or absent): amount in EGP piastres.
   * When currency≠EGP: amount in the FOREIGN currency's minor units (e.g. USD cents).
   *   The service converts to EGP piastres using fxRate and stores both.
   */
  amount: number;
  taxAmount?: number;
  expenseDate: Date | string;
  /** ISO-4217 code. Defaults to 'EGP'. */
  currency?: string;
  /**
   * FX rate: 1 unit of `currency` = fxRate EGP.
   * Required when currency !== 'EGP'. Stored as Decimal (exact; no float drift).
   * For non-EGP OCR drafts where the rate is unknown, omit and the service
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
  /**
   * OCR metadata of a receipt draft. A store on its Durable Object stores it in the same atomic section as the draft; a Postgres
   * store ignores it here (the OCR service attaches it with its own non-fatal update, as before).
   */
  ocr?: { json: unknown; confidence: number | null; modelVersion: string; processedAtMs: number };
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
  // A store on its Durable Object (Ruling CF-JOBS-4B): the draft is one DO section (guards, number, row).
  const repo = await storeRepo(input.storeId);
  if (repo.backend === 'do') return createExpenseOnDo(input, repo);
  // Issue 2291: with no ambient tenant transaction (the expense-OCR Inngest
  // job) the guard below opened its own transient transaction, but every
  // statement after it — the paid-from lookup and the INSERT, both on STRICT
  // RLS tables — ran GUC-less: under ebda_app the lookup reads nothing (a
  // misleading 400 INVALID_PAID_FROM) and the insert is rejected. The whole
  // body now runs in ONE store-scoped transaction, which also closes the
  // guard-vs-write window. The HTTP route already wraps it, so there it joins.
  if (!hasTenantContext()) {
    return runInTenantContext(input.storeId, () => createExpenseInScope(input));
  }
  return createExpenseInScope(input);
}

/**
 * The base-currency amounts of a draft: EGP is stored as given; a foreign amount is converted with the rate, or with the
 * placeholder 1 when the caller has none (the merchant corrects it before posting). Pure; shared by both backends.
 */
function expenseAmounts(input: CreateExpenseInput) {
  const currency = (input.currency ?? REGION.currency).toUpperCase();
  if (!ALLOWED_CURRENCIES.includes(currency as (typeof ALLOWED_CURRENCIES)[number])) {
    throw new AppError(422, 'INVALID_CURRENCY', `Currency '${currency}' is not supported.`);
  }
  if (!requiresFxRate(currency)) {
    return {
      currency,
      amountBase: input.amount,
      taxAmountBase: input.taxAmount ?? 0,
      fxRate: 1,
      original: input.amount + (input.taxAmount ?? 0),
    };
  }
  const rate = input.fxRate ?? 1;
  if (rate <= 0 || !isFinite(rate)) {
    throw new AppError(422, 'INVALID_FX_RATE', 'fxRate must be a finite positive number.');
  }
  const rawAmount = input.originalAmount ?? input.amount;
  const rawTax = input.taxAmount ?? 0;
  return {
    currency,
    amountBase: convertToBase(rawAmount, rate, currency),
    taxAmountBase: convertToBase(rawTax, rate, currency),
    fxRate: rate,
    original: rawAmount + rawTax,
  };
}

async function createExpenseOnDo(
  input: CreateExpenseInput,
  repo: Awaited<ReturnType<typeof storeRepo>>
): Promise<ExpenseWithRelations> {
  if (!repo.money) throw new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'No money client');
  const a = expenseAmounts(input);
  let made;
  try {
    made = await repo.money.expenseDraft(
      {
        supplierId: input.supplierId ?? null,
        expenseAccountId: input.expenseAccountId,
        paidFromAccountId: input.paidFromAccountId,
        amount: a.amountBase,
        taxAmount: a.taxAmountBase,
        total: a.amountBase + a.taxAmountBase,
        currency: a.currency,
        fxRate: a.fxRate,
        originalAmount: a.original,
        expenseDate: new Date(input.expenseDate).getTime(),
        receiptImageUrl: input.receiptImageUrl ?? null,
        notes: input.notes ?? null,
        notesAr: input.notesAr ?? null,
        createdBy: input.createdBy ?? null,
        ...(input.ocr ? { ocr: input.ocr } : {}),
      },
      // a retried job (same receipt) gets the first draft back instead of a second one
      input.receiptImageUrl
        ? `expense-draft:${createHash('sha256').update(input.receiptImageUrl).digest('hex').slice(0, 40)}`
        : undefined
    );
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string };
    if (e.code && e.status && e.status < 500)
      throw new AppError(e.status, e.code, e.message ?? e.code);
    throw err;
  }
  const row = await repo.db.expense.findFirst({
    where: { id: made.expenseId, storeId: input.storeId },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });
  if (!row)
    throw new AppError(
      500,
      'EXPENSE_NOT_FOUND',
      'The draft expense was not found after it was created.'
    );
  return row as unknown as ExpenseWithRelations;
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
  const currency = (input.currency ?? REGION.currency).toUpperCase();

  // Validate currency against the allowed set
  if (!ALLOWED_CURRENCIES.includes(currency as (typeof ALLOWED_CURRENCIES)[number])) {
    throw new AppError(422, 'INVALID_CURRENCY', `Currency '${currency}' is not supported.`);
  }

  // ── Multi-currency FX conversion ──────────────────────────────────────────
  // When currency is EGP: input.amount is already in EGP piastres — no conversion.
  // When currency is non-EGP:
  //   - input.amount is in the FOREIGN currency's minor units (e.g. USD cents).
  //   - fxRate converts: 1 foreign unit → fxRate EGP.
  //   - If fxRate is not provided, we store fxRate=1 as a placeholder and flag
  //     the expense so the merchant reviews before posting.
  let amountBase: number;
  let taxAmountBase: number;
  let fxRateToStore: number;
  let originalAmountToStore: number;
  let originalTaxAmountToStore: number;

  if (!requiresFxRate(currency)) {
    // EGP path — identical to before
    amountBase = input.amount;
    taxAmountBase = input.taxAmount ?? 0;
    fxRateToStore = 1;
    originalAmountToStore = input.amount;
    originalTaxAmountToStore = input.taxAmount ?? 0;
  } else {
    // Non-EGP path
    const rate = input.fxRate ?? 1; // placeholder if not supplied
    if (rate <= 0 || !isFinite(rate)) {
      throw new AppError(422, 'INVALID_FX_RATE', 'fxRate must be a finite positive number.');
    }
    const rawAmount = input.originalAmount ?? input.amount;
    const rawTax = input.taxAmount ?? 0;
    amountBase = convertToBase(rawAmount, rate, currency);
    taxAmountBase = convertToBase(rawTax, rate, currency);
    fxRateToStore = rate;
    originalAmountToStore = rawAmount;
    originalTaxAmountToStore = rawTax;
  }

  const total = amountBase + taxAmountBase;
  const taxAmount = taxAmountBase;

  return prisma.expense.create({
    data: {
      storeId: input.storeId,
      expenseNumber,
      supplierId: input.supplierId ?? null,
      expenseAccountId: input.expenseAccountId,
      paidFromAccountId: input.paidFromAccountId,
      amount: amountBase,
      taxAmount,
      total,
      currency,
      fxRate: fxRateToStore,
      // originalAmount stores the TOTAL original foreign amount (amount + tax in foreign units)
      // so it mirrors how `total` mirrors (amount + tax) in EGP piastres.
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

const EXPENSE_INCLUDE = {
  supplier: { select: { id: true, name: true, nameAr: true } },
  expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
  paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
} as const;

/** A store on its Durable Object (Ruling CF-EXP-1): the repo, or null for a Postgres store (whose code below is unchanged). */
async function doRepoOf(storeId: string) {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return null;
  if (!repo.money) throw new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'No money client');
  return { db: repo.db, money: repo.money };
}

/** The status step on the DO, then the row re-read with its relations. Errors read like the Postgres twin's. */
async function expenseStepOnDo(
  r: NonNullable<Awaited<ReturnType<typeof doRepoOf>>>,
  storeId: string,
  id: string,
  action: 'approve' | 'post' | 'reject',
  extra: { userId?: string | null; pending?: boolean } = {}
): Promise<ExpenseWithRelations> {
  const out = await r.money.expenseTransition({ expenseId: id, action, ...extra });
  if (!out.found)
    throw new AppError(404, 'EXPENSE_NOT_FOUND', `Expense ${id} not found in store ${storeId}`);
  if (!out.changed) {
    if (action === 'post')
      throw new AppError(
        409,
        'EXPENSE_INVALID_STATUS',
        `Expense ${id} must be approved before posting (status=${out.status})`
      );
    throw new AppError(
      409,
      'EXPENSE_INVALID_STATUS',
      `Expense ${id} cannot be ${action === 'approve' ? 'approved' : 'rejected'} (status=${out.status})`
    );
  }
  const row = await r.db.expense.findFirst({
    where: { id, storeId },
    include: EXPENSE_INCLUDE,
  });
  if (!row)
    throw new AppError(404, 'EXPENSE_NOT_FOUND', `Expense ${id} not found in store ${storeId}`);
  return row as unknown as ExpenseWithRelations;
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
  const onDo = await doRepoOf(storeId);
  if (onDo) {
    const row = await onDo.db.expense.findFirst({
      where: { id, storeId },
      select: { createdBy: true },
    });
    if (!row)
      throw new AppError(404, 'EXPENSE_NOT_FOUND', `Expense ${id} not found in store ${storeId}`);
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { expenseTwoStepApproval: true } })
    );
    const selfApproval =
      (store?.expenseTwoStepApproval ?? false) && userId != null && userId === row.createdBy;
    return expenseStepOnDo(onDo, storeId, id, 'approve', { userId, pending: selfApproval });
  }
  const expense = await prisma.expense.findFirst({
    where: { id, storeId },
    include: { store: { select: { expenseTwoStepApproval: true } } },
  });

  if (!expense)
    throw new AppError(404, 'EXPENSE_NOT_FOUND', `Expense ${id} not found in store ${storeId}`);
  if (!['draft', 'pending'].includes(expense.status)) {
    throw new AppError(
      409,
      'EXPENSE_INVALID_STATUS',
      `Expense ${id} cannot be approved (status=${expense.status})`
    );
  }

  const twoStep = expense.store?.expenseTwoStepApproval ?? false;
  const selfApproval = twoStep && userId != null && userId === expense.createdBy;
  const nextStatus = selfApproval ? 'pending' : 'approved';

  return prisma.expense.update({
    where: { id, storeId },
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
  const onDo = await doRepoOf(storeId);
  if (onDo) {
    const posted = await expenseStepOnDo(onDo, storeId, id, 'post');
    await fireExpensePosted(storeId, id);
    return posted;
  }
  const expense = await prisma.expense.findFirst({ where: { id, storeId } });

  if (!expense)
    throw new AppError(404, 'EXPENSE_NOT_FOUND', `Expense ${id} not found in store ${storeId}`);
  if (expense.status !== 'approved') {
    throw new AppError(
      409,
      'EXPENSE_INVALID_STATUS',
      `Expense ${id} must be approved before posting (status=${expense.status})`
    );
  }

  const updated = await prisma.expense.update({
    where: { id, storeId },
    data: { status: 'posted', postedAt: new Date() },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });

  await fireExpensePosted(storeId, id);

  return updated;
}

/** Fire async journal posting: non-blocking, and the journal job is idempotent per source row. */
async function fireExpensePosted(storeId: string, id: string): Promise<void> {
  try {
    await inngest.send({
      name: 'accounting/expense-posted',
      data: { storeId, expenseId: id },
    });
  } catch (err) {
    logger.error({ err, expenseId: id, storeId }, 'postExpense: failed to fire inngest event');
  }
}

/**
 * Reject a draft or pending expense.
 */
export async function rejectExpense(storeId: string, id: string): Promise<ExpenseWithRelations> {
  const onDo = await doRepoOf(storeId);
  if (onDo) return expenseStepOnDo(onDo, storeId, id, 'reject');
  const expense = await prisma.expense.findFirst({ where: { id, storeId } });

  if (!expense)
    throw new AppError(404, 'EXPENSE_NOT_FOUND', `Expense ${id} not found in store ${storeId}`);
  if (!['draft', 'pending'].includes(expense.status)) {
    throw new AppError(
      409,
      'EXPENSE_INVALID_STATUS',
      `Expense ${id} cannot be rejected (status=${expense.status})`
    );
  }

  return prisma.expense.update({
    where: { id, storeId },
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

  const include = EXPENSE_INCLUDE;

  // A store on its Durable Object reads its own expenses (Ruling CF-EXP-1); the Postgres reads below are unchanged.
  const onDo = await doRepoOf(storeId);
  const rows = onDo ? onDo.db.expense : prisma.expense;

  const [items, total] = await Promise.all([
    rows.findMany({
      where,
      // `expenseDate` is a calendar day (UTC midnight), so same-day rows tie byte-for-byte; `id`
      // makes the order total so page N+1 never repeats or skips a row of page N (issue 2429).
      orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }],
      skip,
      take: perPage,
      include,
    }),
    rows.count({ where }),
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
  const onDo = await doRepoOf(storeId);
  return (onDo ? onDo.db.expense : prisma.expense).findFirst({
    where: { id, storeId },
    include: {
      supplier: { select: { id: true, name: true, nameAr: true } },
      expenseAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
      paidFromAccount: { select: { id: true, nameEn: true, nameAr: true, code: true } },
    },
  });
}
