/**
 * Finance Routes — Chart of Accounts + General Ledger API
 *
 * Exposes the double-entry accounting primitives to admin clients.
 * All routes are store-scoped (/:storeId/finance/…) and sit behind
 * the standard authenticate → authorize → requireStoreAccess chain.
 *
 * Routes:
 *   GET  /stores/:storeId/finance/accounts          — COA tree (store_admin+)
 *   GET  /stores/:storeId/finance/journal           — paginated entry list (store_admin+)
 *   GET  /stores/:storeId/finance/journal/:entryId  — single entry detail (store_admin+)
 *   POST /stores/:storeId/finance/journal           — manual adjusting entry (super_admin only)
 *   GET  /stores/:storeId/finance/reports/tax-report       — transaction-level tax report (Enterprise)
 *   GET  /stores/:storeId/finance/reports/tax-report.xlsx  — XLSX download (Enterprise)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { DISABLED_VARIANT_STOCK_VALUE_SQL, STOCK_VALUE_SQL } from '../lib/effective-inventory-sql';
import { z } from 'zod';
import { prisma, runInTenantContext } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { ALLOWED_CURRENCIES, convertToKwd, requiresFxRate } from '@force/shared';
import {
  listAccountsTree,
  createChildAccount,
  setAccountActive,
  seedCoaForStore,
} from '../services/accounting/account.service';
import { postEntry } from '../services/accounting/journal.service';
import { trialBalance, profitAndLoss, balanceSheet } from '../services/accounting/reports.service';
import { generateTaxReport } from '../services/accounting/tax-report.service';
import { streamXlsxResponse } from '../lib/exports/xlsx';
import multer from 'multer';
import ExcelJS from 'exceljs';
import {
  importBankStatement,
  runAutoMatch,
  applyManualMatch,
  getReconciliationSummary,
  getReconciliationDifference,
} from '../services/accounting/bank-reconcile.service';

const router = Router({ mergeParams: true });

/**
 * Parse a finance date-range query param into a VALID Date.
 *
 * Accepts both shapes callers actually send: date-only `YYYY-MM-DD` and full
 * ISO timestamps (the admin client sends `Date.toISOString()`, e.g.
 * `2026-06-01T00:00:00.000Z`). For date-only values it pins the requested day
 * boundary; full ISO values are used as-is.
 *
 * Crucially it never returns an Invalid Date: an absent / unparseable value
 * falls back to `fallback`. This guards the whole finance surface — an invalid
 * Date used to reach `trialBalance` and 500 the dashboard, first as Prisma's
 * "Could not convert from JSON date object to PrismaValue", then (after the
 * raw-SQL fix) as `RangeError: Invalid time value` on `.toISOString()`. The
 * original break: the dashboard appended `T23:59:59` to an already-full ISO
 * string, producing `...000ZT23:59:59` → Invalid Date.
 */
export function parseFinanceDate(
  value: unknown,
  fallback: Date,
  boundary: 'start' | 'end' = 'start'
): Date {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(`${s}T${boundary === 'end' ? '23:59:59.999' : '00:00:00.000'}`)
    : new Date(s);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

// ─── GET /:storeId/finance/accounts ──────────────────────────────────────────

/**
 * Chart of Accounts tree grouped by AccountType.
 * Reflects the current store's accounts only (RLS-enforced).
 */
router.get(
  '/:storeId/finance/accounts',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tree = await runInTenantContext(req.params.storeId, () =>
        listAccountsTree(req.params.storeId)
      );
      res.json({ data: tree });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/journal ───────────────────────────────────────────

const listQuerySchema = z.object({
  source: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(200).default(50),
});

/**
 * Paginated journal entry list with line aggregates.
 * Supports filtering by source, from/to date range.
 */
router.get(
  '/:storeId/finance/journal',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = listQuerySchema.parse(req.query);
      const where: any = { storeId: req.params.storeId };
      if (q.source) where.source = q.source;
      if (q.from || q.to) {
        where.postedAt = {};
        if (q.from) where.postedAt.gte = new Date(q.from);
        if (q.to) where.postedAt.lte = new Date(q.to);
      }

      const [items, total] = await runInTenantContext(req.params.storeId, () =>
        Promise.all([
          prisma.journalEntry.findMany({
            where,
            include: {
              lines: {
                include: {
                  account: { select: { code: true, nameEn: true, nameAr: true } },
                },
              },
            },
            orderBy: { postedAt: 'desc' },
            skip: (q.page - 1) * q.perPage,
            take: q.perPage,
          }),
          prisma.journalEntry.count({ where }),
        ])
      );

      res.json({
        data: items,
        meta: {
          page: q.page,
          perPage: q.perPage,
          total,
          totalPages: Math.ceil(total / q.perPage),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/journal/:entryId ───────────────────────────────────

/**
 * Single journal entry detail — includes lines, accounts, reversal links.
 * Returns 404 when the entry does not belong to the store.
 */
router.get(
  '/:storeId/finance/journal/:entryId',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entry = await runInTenantContext(req.params.storeId, () =>
        prisma.journalEntry.findFirst({
          where: { id: req.params.entryId, storeId: req.params.storeId },
          include: {
            lines: { include: { account: true } },
            reversedBy: true,
            reverses: true,
          },
        })
      );

      if (!entry) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Journal entry not found.' },
        });
        return;
      }

      res.json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/finance/journal ──────────────────────────────────────────

const lineSchema = z
  .object({
    accountId: z.string().uuid(),
    /** KWD fils when currency=KWD. Foreign minor units when currency≠KWD. */
    debit: z.number().int().nonnegative(),
    credit: z.number().int().nonnegative(),
    lineMemo: z.string().optional(),
    /** ISO-4217 code. Defaults to 'KWD'. */
    currency: z.enum(ALLOWED_CURRENCIES).optional(),
    /**
     * FX rate: 1 unit of `currency` = fxRate KWD.
     * Required when currency !== 'KWD'. The route converts debit/credit to
     * KWD fils and stores originalAmount before passing to postEntry.
     */
    fxRate: z.number().positive().finite().optional(),
    /** Original amount in foreign minor units (derived from debit|credit when absent). */
    originalAmount: z.number().int().nonnegative().optional(),
  })
  .superRefine((line, ctx) => {
    const currency = (line.currency ?? 'KWD').toUpperCase();
    if (currency !== 'KWD' && line.fxRate === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fxRate'],
        message: `fxRate is required when line currency is ${currency}`,
      });
    }
  });

const manualEntrySchema = z.object({
  memo: z.string().optional(),
  memoAr: z.string().optional(),
  postedAt: z.string().datetime().optional(),
  lines: z.array(lineSchema).min(2),
});

/**
 * Manual adjusting entry (super_admin only).
 * Store admins post via service helpers, not raw GL, in v1.
 * Returns 201 on success; the postEntry service validates DR=CR balance.
 */
router.post(
  '/:storeId/finance/journal',
  authenticate,
  requireMfaEnrolled,
  authorize('super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = manualEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }

      const body = parsed.data;

      // Convert non-KWD lines to KWD fils before passing to postEntry.
      // postEntry only validates DR=CR on KWD amounts; FX metadata is stored
      // alongside but the accounting invariant is always in KWD.
      const resolvedLines = body.lines.map(l => {
        const currency = (l.currency ?? 'KWD').toUpperCase();
        if (!requiresFxRate(currency) || l.fxRate == null) {
          // KWD line or no rate provided — pass through unchanged
          return { ...l, currency: currency };
        }
        const origDebit = l.debit;
        const origCredit = l.credit;
        const kwdDebit = origDebit > 0 ? convertToKwd(origDebit, l.fxRate) : 0;
        const kwdCredit = origCredit > 0 ? convertToKwd(origCredit, l.fxRate) : 0;
        return {
          ...l,
          currency,
          debit: kwdDebit,
          credit: kwdCredit,
          fxRate: l.fxRate,
          originalAmount: l.originalAmount ?? (origDebit || origCredit),
        };
      });

      const entry = await runInTenantContext(req.params.storeId, () =>
        postEntry({
          storeId: req.params.storeId,
          source: 'manual',
          memo: body.memo,
          memoAr: body.memoAr,
          postedAt: body.postedAt ? new Date(body.postedAt) : undefined,
          postedBy: (req as any).user?.id,
          lines: resolvedLines,
        })
      );

      res.status(201).json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/finance/accounts/seed ────────────────────────────────────

/**
 * Seed (or back-fill) the standard Chart of Accounts for an existing store.
 * `seedCoaForStore` is idempotent — it only inserts COA_TEMPLATE codes the
 * store is missing, so this is safe to call repeatedly. Needed because the
 * automatic seed only runs at store-create time; stores that pre-date that code
 * (or were created via DB seeder) have zero accounts, which makes every
 * journal-posting path throw "seed COA first". Returns the count created.
 */
router.post(
  '/:storeId/finance/accounts/seed',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await runInTenantContext(req.params.storeId, () =>
        seedCoaForStore(req.params.storeId)
      );
      res.status(201).json({ data: { created } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/finance/accounts ─────────────────────────────────────────

const createChildSchema = z.object({
  parentId: z.string().uuid(),
  code: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d{4,6}$/, 'Code must be 4-6 digits'),
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().max(120).optional(),
});

/**
 * Create a custom child account under a system parent.
 * Type is inherited from the parent. Only one level of custom children allowed.
 */
router.post(
  '/:storeId/finance/accounts',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createChildSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation',
            message: 'Validation failed.',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const acct = await runInTenantContext(req.params.storeId, () =>
        createChildAccount({ storeId: req.params.storeId, ...body.data })
      );
      res.status(201).json({ data: acct });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /:storeId/finance/accounts/:accountId/active ──────────────────────

const setActiveSchema = z.object({ isActive: z.boolean() });

/**
 * Enable or disable a custom account. System accounts cannot be disabled.
 */
router.patch(
  '/:storeId/finance/accounts/:accountId/active',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = setActiveSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation',
            message: 'Validation failed.',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const acct = await runInTenantContext(req.params.storeId, () =>
        setAccountActive(req.params.storeId, req.params.accountId, body.data.isActive)
      );
      res.json({ data: acct });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/reports/trial-balance ─────────────────────────────

/**
 * Trial balance as of `asOf` (optional ISO datetime query param).
 * Returns all accounts with debit/credit totals and running balance.
 */
router.get(
  '/:storeId/finance/reports/trial-balance',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = req.query.asOf ? parseFinanceDate(req.query.asOf, new Date(), 'end') : undefined;
      const data = await runInTenantContext(req.params.storeId, () =>
        trialBalance(req.params.storeId, asOf)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/reports/pnl ───────────────────────────────────────

/**
 * Profit & loss for the period [from, to].
 * Defaults to last 30 days when query params are omitted.
 */
router.get(
  '/:storeId/finance/reports/pnl',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = parseFinanceDate(
        req.query.from,
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        'start'
      );
      const to = parseFinanceDate(req.query.to, new Date(), 'end');
      const raw = await runInTenantContext(req.params.storeId, () =>
        profitAndLoss(req.params.storeId, from, to)
      );
      // Reshape service output ({ revenue: row[], expenses: row[], totalRevenue, ... })
      // into the { revenue: {accounts, total}, expenses: {accounts, total}, netIncome }
      // shape the frontend renders. Account-level fields renamed code/nameEn/balance
      // for UI clarity (service returns full TrialBalanceRow which carries other fields
      // the frontend doesn't need).
      const data = {
        from: raw.from,
        to: raw.to,
        revenue: {
          accounts: raw.revenue.map(r => ({
            code: r.code,
            nameEn: r.nameEn,
            balance: r.creditTotal - r.debitTotal,
          })),
          total: raw.totalRevenue,
        },
        expenses: {
          accounts: raw.expenses.map(r => ({
            code: r.code,
            nameEn: r.nameEn,
            balance: r.debitTotal - r.creditTotal,
          })),
          total: raw.totalExpenses,
        },
        netIncome: raw.netIncome,
      };
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/reports/balance-sheet ─────────────────────────────

/**
 * Balance sheet snapshot as of `asOf` (default: now).
 * Buckets accounts into assets / liabilities / equity with totals.
 */
router.get(
  '/:storeId/finance/reports/balance-sheet',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = parseFinanceDate(req.query.asOf, new Date(), 'end');
      const raw = await runInTenantContext(req.params.storeId, () =>
        balanceSheet(req.params.storeId, asOf)
      );
      // Reshape service output ({ assets: row[], liabilities: row[], equity: row[], total* })
      // into the { assets: {accounts, total}, ... } shape the frontend renders.
      // Liability + equity balances are credit-natural — negate to display natural sign.
      const data = {
        asOf: raw.asOf,
        assets: {
          accounts: raw.assets.map(r => ({ code: r.code, nameEn: r.nameEn, balance: r.balance })),
          total: raw.totalAssets,
        },
        liabilities: {
          accounts: raw.liabilities.map(r => ({
            code: r.code,
            nameEn: r.nameEn,
            balance: -r.balance,
          })),
          total: raw.totalLiabilities,
        },
        equity: {
          // `kind: 'current_earnings'` marks the computed retained + current
          // earnings row (not a COA account) so the UI can label it in the
          // viewer's language.
          accounts: raw.equity.map(r => ({
            code: r.code,
            nameEn: r.nameEn,
            nameAr: r.nameAr,
            balance: -r.balance,
            ...(r.kind ? { kind: r.kind } : {}),
          })),
          total: raw.totalEquity,
        },
        difference: raw.difference,
      };
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/dashboard ─────────────────────────────────────────

/**
 * Merchant-facing finance dashboard — windowed P&L, cash account balances,
 * stock value, and balance-sheet totals.
 * Accepts optional `from` and `to` ISO date query params to set the P&L
 * window. Defaults to the current calendar month when omitted.
 * Cash accounts are those whose code starts with '10' (asset accounts in the
 * 1000-1099 range per Kuwait COA — bank + petty cash).
 */
router.get(
  '/:storeId/finance/dashboard',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Allow caller to override the P&L window via from/to query params.
      // Both are expected as YYYY-MM-DD strings (date-only, local midnight).
      // When omitted, the endpoint falls back to current-month behaviour.
      const from = parseFinanceDate(req.query.from, monthStart, 'start');
      const to = parseFinanceDate(req.query.to, now, 'end');

      const data = await runInTenantContext(req.params.storeId, async () => {
        const [pnl, bs, stockValueRows, disabledValueRows] = await Promise.all([
          profitAndLoss(req.params.storeId, from, to),
          balanceSheet(req.params.storeId, to),
          // Variant-aware quantity AND cost: `products.inventory` is not
          // stock for a variant product, and a variant is valued at its own
          // cost (falling back to the parent's). See STOCK_VALUE_SQL in
          // lib/effective-inventory-sql.ts.
          prisma.$queryRaw<{ total: bigint }[]>`
            SELECT COALESCE(SUM(${STOCK_VALUE_SQL}), 0) AS total
            FROM public.products p
            WHERE p.store_id = ${req.params.storeId} AND p.deleted_at IS NULL
          `,
          // issue 2146: value on DISABLED variants — not stock, so not in
          // stockValue, but shown beside it rather than vanishing.
          prisma.$queryRaw<{ total: bigint }[]>`
            SELECT COALESCE(SUM(${DISABLED_VARIANT_STOCK_VALUE_SQL}), 0) AS total
            FROM public.products p
            WHERE p.store_id = ${req.params.storeId} AND p.deleted_at IS NULL
          `,
        ]);

        const stockValue = Number(stockValueRows[0]?.total ?? 0);
        const disabledVariantStockValue = Number(disabledValueRows[0]?.total ?? 0);

        return {
          thisMonth: {
            revenue: pnl.totalRevenue,
            expenses: pnl.totalExpenses,
            net: pnl.netIncome,
          },
          cash: bs.assets.filter(a => a.code.startsWith('10')),
          stockValue,
          disabledVariantStockValue,
          balanceSheet: {
            totalAssets: bs.totalAssets,
            totalLiabilities: bs.totalLiabilities,
            totalEquity: bs.totalEquity,
          },
        };
      });

      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── XLSX exports for finance reports ────────────────────────────────────────
// Each mirrors the JSON endpoint above — same auth chain, same data, streamed
// as a formatted Excel workbook (bold header, KWD three-decimal numFmt).

// GET /:storeId/finance/reports/trial-balance.xlsx
router.get(
  '/:storeId/finance/reports/trial-balance.xlsx',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = req.query.asOf ? parseFinanceDate(req.query.asOf, new Date(), 'end') : undefined;
      const rows = await runInTenantContext(req.params.storeId, () =>
        trialBalance(req.params.storeId, asOf)
      );
      const date = (asOf ?? new Date()).toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `trial-balance-${date}.xlsx`,
        sheetName: 'Trial Balance',
        columns: [
          { header: 'Account Code', key: 'code', width: 16 },
          { header: 'Account Name (EN)', key: 'nameEn', width: 34 },
          { header: 'Account Name (AR)', key: 'nameAr', width: 34 },
          { header: 'Debit (KWD)', key: 'debit', width: 16, numFmt: '#,##0.000' },
          { header: 'Credit (KWD)', key: 'credit', width: 16, numFmt: '#,##0.000' },
          { header: 'Balance (KWD)', key: 'balance', width: 16, numFmt: '#,##0.000' },
        ],
        rows: rows.map(r => ({
          code: r.code,
          nameEn: r.nameEn,
          nameAr: r.nameAr ?? '',
          debit: r.debitTotal / 1000,
          credit: r.creditTotal / 1000,
          balance: r.balance / 1000,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /:storeId/finance/reports/pnl.xlsx
router.get(
  '/:storeId/finance/reports/pnl.xlsx',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = parseFinanceDate(
        req.query.from,
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        'start'
      );
      const to = parseFinanceDate(req.query.to, new Date(), 'end');
      const raw = await runInTenantContext(req.params.storeId, () =>
        profitAndLoss(req.params.storeId, from, to)
      );

      // Flatten into a sheet: revenue rows, total revenue, blank, expense rows,
      // total expenses, blank, net income.
      type XlsxRow = { type: string; code: string; name: string; amount: number | string };
      const rows: XlsxRow[] = [
        { type: 'Section', code: '', name: 'Revenue', amount: '' },
        ...raw.revenue.map(r => ({
          type: 'Account',
          code: r.code,
          name: r.nameEn,
          amount: (r.creditTotal - r.debitTotal) / 1000,
        })),
        { type: 'Total', code: '', name: 'Total Revenue', amount: raw.totalRevenue / 1000 },
        { type: '', code: '', name: '', amount: '' },
        { type: 'Section', code: '', name: 'Expenses', amount: '' },
        ...raw.expenses.map(r => ({
          type: 'Account',
          code: r.code,
          name: r.nameEn,
          amount: (r.debitTotal - r.creditTotal) / 1000,
        })),
        { type: 'Total', code: '', name: 'Total Expenses', amount: raw.totalExpenses / 1000 },
        { type: '', code: '', name: '', amount: '' },
        { type: 'Net', code: '', name: 'Net Income', amount: raw.netIncome / 1000 },
      ];

      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `pnl-${fromStr}-to-${toStr}.xlsx`,
        sheetName: 'P&L',
        columns: [
          { header: 'Type', key: 'type', width: 12 },
          { header: 'Account Code', key: 'code', width: 16 },
          { header: 'Account Name', key: 'name', width: 34 },
          { header: 'Amount (KWD)', key: 'amount', width: 18, numFmt: '#,##0.000' },
        ],
        rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /:storeId/finance/reports/balance-sheet.xlsx
router.get(
  '/:storeId/finance/reports/balance-sheet.xlsx',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = parseFinanceDate(req.query.asOf, new Date(), 'end');
      const raw = await runInTenantContext(req.params.storeId, () =>
        balanceSheet(req.params.storeId, asOf)
      );

      type XlsxRow = { section: string; code: string; name: string; amount: number | string };
      const buildSection = (
        label: string,
        totalLabel: string,
        accounts: { code: string; nameEn: string; balance: number }[],
        sign: number
      ): XlsxRow[] => [
        { section: label, code: '', name: label, amount: '' },
        ...accounts.map(r => ({
          section: label,
          code: r.code,
          name: r.nameEn,
          amount: (r.balance * sign) / 1000,
        })),
        {
          section: 'Total',
          code: '',
          name: totalLabel,
          amount: accounts.reduce((s, r) => s + r.balance * sign, 0) / 1000,
        },
        { section: '', code: '', name: '', amount: '' },
      ];

      const rows: XlsxRow[] = [
        ...buildSection('Assets', 'Total Assets', raw.assets, 1),
        ...buildSection('Liabilities', 'Total Liabilities', raw.liabilities, -1),
        ...buildSection('Equity', 'Total Equity', raw.equity, -1),
      ];

      const date = asOf.toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `balance-sheet-${date}.xlsx`,
        sheetName: 'Balance Sheet',
        columns: [
          { header: 'Section', key: 'section', width: 14 },
          { header: 'Account Code', key: 'code', width: 16 },
          { header: 'Account Name', key: 'name', width: 34 },
          { header: 'Amount (KWD)', key: 'amount', width: 18, numFmt: '#,##0.000' },
        ],
        rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Tax Report (Enterprise) ──────────────────────────────────────────────────

const taxReportQuerySchema = z.object({
  from: z.string().min(1, 'from is required'),
  to: z.string().min(1, 'to is required'),
});

/**
 * GET /:storeId/finance/reports/tax-report
 *
 * Transaction-level VAT / sales-tax report.
 * Returns every order in the period that had tax posted to account 2100 (Tax Payable).
 * Gated: accounting.tax_reports (Enterprise plan).
 *
 * Query params:
 *   from  — ISO date string, start of period (inclusive), e.g. 2026-01-01
 *   to    — ISO date string, end of period (inclusive), e.g. 2026-03-31
 */
router.get(
  '/:storeId/finance/reports/tax-report',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.tax_reports'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = taxReportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const from = new Date(parsed.data.from + 'T00:00:00.000Z');
      const to = new Date(parsed.data.to + 'T23:59:59.999Z');
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(422).json({
          success: false,
          error: { code: 'invalid_date', message: 'from and to must be valid dates' },
        });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        generateTaxReport(req.params.storeId, { from, to })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /:storeId/finance/reports/tax-report.xlsx
 *
 * XLSX export of the tax report. Same auth + feature gate as the JSON endpoint.
 * Sheet: "Tax Report" — one row per tax-moving journal entry (Type = Sale /
 * Refund / return; Order Total on the sale row only) + a summary section
 * appended below.
 */
router.get(
  '/:storeId/finance/reports/tax-report.xlsx',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.tax_reports'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = taxReportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const from = new Date(parsed.data.from + 'T00:00:00.000Z');
      const to = new Date(parsed.data.to + 'T23:59:59.999Z');
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(422).json({
          success: false,
          error: { code: 'invalid_date', message: 'from and to must be valid dates' },
        });
        return;
      }
      const report = await runInTenantContext(req.params.storeId, () =>
        generateTaxReport(req.params.storeId, { from, to })
      );

      type XlsxRow = {
        rowType: string;
        date: string;
        orderNumber: string;
        customer: string;
        subtotal: number | string;
        taxRate: string;
        taxCollected: number | string;
        total: number | string;
      };

      // Transaction rows
      // Type tells the sale row from the refund/return rows that share its
      // order number, and Order Total is filled on the sale row only, so the
      // column sums to each order once (#1253).
      const txRows: XlsxRow[] = report.rows.map(r => ({
        rowType: r.kind === 'sale' ? 'Sale' : 'Refund / return',
        date: r.date,
        orderNumber: r.orderNumber,
        customer: r.customerName ?? '',
        subtotal: r.subtotal / 1000,
        taxRate: `${r.taxRate}%`,
        taxCollected: r.taxCollected / 1000,
        total: r.total === null ? '' : r.total / 1000,
      }));

      // Summary section
      const summaryRows: XlsxRow[] = [
        {
          rowType: '',
          date: '',
          orderNumber: '',
          customer: '',
          subtotal: '',
          taxRate: '',
          taxCollected: '',
          total: '',
        },
        {
          rowType: 'Summary',
          date: '',
          orderNumber: `Orders: ${report.summary.orderCount} — Entries (sales + refunds): ${report.summary.transactionCount}`,
          customer: '',
          subtotal: report.summary.totalTaxableSales / 1000,
          taxRate: '',
          taxCollected: report.summary.totalTaxCollected / 1000,
          total: '',
        },
        {
          rowType: '',
          date: '',
          orderNumber: '',
          customer: '',
          subtotal: '',
          taxRate: '',
          taxCollected: '',
          total: '',
        },
      ];
      for (const byRate of report.summary.byRate) {
        summaryRows.push({
          rowType: 'By Rate',
          date: '',
          orderNumber: '',
          customer: `${byRate.taxRate}% — ${byRate.transactionCount} entr${byRate.transactionCount === 1 ? 'y' : 'ies'}`,
          subtotal: byRate.totalSubtotal / 1000,
          taxRate: `${byRate.taxRate}%`,
          taxCollected: byRate.totalTaxCollected / 1000,
          total: '',
        });
      }

      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `tax-report-${fromStr}-to-${toStr}.xlsx`,
        sheetName: 'Tax Report',
        columns: [
          { header: 'Type', key: 'rowType', width: 14 },
          { header: 'Date', key: 'date', width: 14 },
          { header: 'Order Number', key: 'orderNumber', width: 20 },
          { header: 'Customer', key: 'customer', width: 28 },
          { header: 'Taxable Base (KWD)', key: 'subtotal', width: 20, numFmt: '#,##0.000' },
          { header: 'Tax Rate', key: 'taxRate', width: 12 },
          { header: 'Tax Collected (KWD)', key: 'taxCollected', width: 22, numFmt: '#,##0.000' },
          { header: 'Order Total (KWD)', key: 'total', width: 20, numFmt: '#,##0.000' },
        ],
        rows: [...txRows, ...summaryRows],
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── FX Rate Registry (Multi-Currency — Enterprise) ──────────────────────────
//
// Simple merchant-maintained rate log. Merchants record the day's rate for a
// currency pair and the system uses it for non-KWD expense/journal entry
// creation. There is no automatic rate fetch — manual entry is intentional
// (auditable, no external API dependency, correct for small merchants).
//
// Routes:
//   GET  /:storeId/finance/fx-rates        — list recent rates (last 90 days, per-currency)
//   POST /:storeId/finance/fx-rates        — record a rate for a given date

const fxRateCreateSchema = z.object({
  /** ISO-4217 code (must be in ALLOWED_CURRENCIES, not KWD). */
  currency: z.enum(ALLOWED_CURRENCIES.filter(c => c !== 'KWD') as [string, ...string[]]),
  /** Rate: 1 unit of `currency` = rate KWD. Must be positive. */
  rate: z.number().positive().finite(),
  /** Date the rate applies to. ISO date string e.g. "2026-06-15". Defaults to today. */
  rateDate: z.string().optional(),
});

router.get(
  '/:storeId/finance/fx-rates',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.multi_currency'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;
      const where: Record<string, unknown> = {
        storeId: req.params.storeId,
        // Default to last 90 days
        rateDate: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
      };
      if (currency) where.currency = currency.toUpperCase();

      const rates = await runInTenantContext(req.params.storeId, () =>
        prisma.fxRateEntry.findMany({
          where,
          orderBy: { rateDate: 'desc' },
          take: 200,
          select: { id: true, currency: true, rate: true, rateDate: true, createdAt: true },
        })
      );
      res.json({ data: rates });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/finance/fx-rates',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.multi_currency'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = fxRateCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: parsed.error.flatten(),
          },
        });
        return;
      }
      const { currency, rate, rateDate } = parsed.data;
      const rateDateValue = rateDate ? new Date(rateDate) : new Date();

      const entry = await runInTenantContext(req.params.storeId, () =>
        prisma.fxRateEntry.create({
          data: {
            storeId: req.params.storeId,
            currency: currency.toUpperCase(),
            rate,
            rateDate: rateDateValue,
            recordedBy: (req as any).user?.id ?? null,
          },
          select: { id: true, currency: true, rate: true, rateDate: true, createdAt: true },
        })
      );
      res.status(201).json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// Bank Reconciliation Routes (Enterprise — accounting.bank_reconcile)
// ═══════════════════════════════════════════════════════════════════════════════
// All routes gated behind:
//   authenticate → requireMfaEnrolled → authorize(store_admin, super_admin)
//   → requireStoreAccess → requireFeature('accounting.bank_reconcile')

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'text/plain' ||
      file.mimetype === 'application/x-ofx' ||
      file.mimetype === 'application/ofx' ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      name.endsWith('.csv') ||
      name.endsWith('.ofx') ||
      name.endsWith('.xlsx');
    cb(null, ok);
  },
});

const bankRecMiddleware = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.bank_reconcile'),
] as const;

// ─── POST /:storeId/finance/bank-statements ───────────────────────────────────
// Import a bank statement file (CSV or OFX).

const importBodySchema = z.object({
  glAccountId: z.string().uuid(),
});

router.post(
  '/:storeId/finance/bank-statements',
  ...bankRecMiddleware,
  statementUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(422).json({
          success: false,
          error: { code: 'file_required', message: 'Upload a CSV or OFX file' },
        });
        return;
      }

      const bodyParsed = importBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: bodyParsed.error.flatten(),
          },
        });
        return;
      }

      const fileName = req.file.originalname;
      const ext = fileName.toLowerCase().split('.').pop();

      let fileBuffer = req.file.buffer;
      let fileType: 'csv' | 'ofx';

      if (ext === 'ofx') {
        fileType = 'ofx';
      } else if (ext === 'xlsx') {
        // Convert XLSX → CSV so the existing parseStatementCsv logic handles it.
        // Read first sheet, emit header + data rows as comma-separated text.
        const wb = new ExcelJS.Workbook();
        const ab = fileBuffer.buffer.slice(
          fileBuffer.byteOffset,
          fileBuffer.byteOffset + fileBuffer.byteLength
        ) as ArrayBuffer;
        await wb.xlsx.load(ab);
        const sheet = wb.worksheets[0];
        if (!sheet) {
          res.status(422).json({
            success: false,
            error: { code: 'empty_xlsx', message: 'The uploaded XLSX file has no sheets.' },
          });
          return;
        }
        const csvLines: string[] = [];
        sheet.eachRow(row => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: true }, cell => {
            const v = cell.text ?? '';
            cells.push(/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
          });
          csvLines.push(cells.join(','));
        });
        fileBuffer = Buffer.from(csvLines.join('\n'), 'utf-8');
        fileType = 'csv';
      } else {
        fileType = 'csv';
      }

      const result = await importBankStatement({
        storeId: req.params.storeId,
        glAccountId: bodyParsed.data.glAccountId,
        fileName,
        buffer: fileBuffer,
        fileType,
      });

      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/bank-statements ────────────────────────────────────
// Paginated list of imported statements.

const statementsListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['pending', 'reconciling', 'reconciled']).optional(),
});

router.get(
  '/:storeId/finance/bank-statements',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = statementsListSchema.parse(req.query);
      const where: any = { storeId: req.params.storeId };
      if (q.status) where.status = q.status;

      const [items, total] = await runInTenantContext(req.params.storeId, () =>
        Promise.all([
          prisma.bankStatement.findMany({
            where,
            select: {
              id: true,
              fileName: true,
              importedAt: true,
              periodStart: true,
              periodEnd: true,
              status: true,
              glAccount: { select: { code: true, nameEn: true, nameAr: true } },
              _count: { select: { transactions: true } },
            },
            orderBy: { importedAt: 'desc' },
            skip: (q.page - 1) * q.perPage,
            take: q.perPage,
          }),
          prisma.bankStatement.count({ where }),
        ])
      );

      res.json({
        data: items,
        meta: { page: q.page, perPage: q.perPage, total, totalPages: Math.ceil(total / q.perPage) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/bank-statements/:sid ──────────────────────────────
// Statement detail with reconciliation summary.

router.get(
  '/:storeId/finance/bank-statements/:sid',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stmt = await runInTenantContext(req.params.storeId, () =>
        prisma.bankStatement.findFirst({
          where: { id: req.params.sid, storeId: req.params.storeId },
          select: {
            id: true,
            fileName: true,
            importedAt: true,
            periodStart: true,
            periodEnd: true,
            status: true,
            glAccount: { select: { id: true, code: true, nameEn: true, nameAr: true } },
          },
        })
      );

      if (!stmt) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Bank statement not found.' },
        });
        return;
      }

      const [summary, difference] = await Promise.all([
        getReconciliationSummary(req.params.sid, req.params.storeId),
        getReconciliationDifference(req.params.sid, req.params.storeId),
      ]);
      res.json({ data: { ...stmt, summary, difference } });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/bank-statements/:sid/reconciliation-difference ────
// Returns the mismatch panel data: bankBalance, ledgerBalance, delta, where-breakdown,
// and suggested action (EN + AR). Intentionally separate from the statement detail
// so the UI can refresh it live after match/unmatch actions without re-fetching the
// full transaction list.

router.get(
  '/:storeId/finance/bank-statements/:sid/reconciliation-difference',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify statement ownership before running the difference query
      const stmt = await runInTenantContext(req.params.storeId, () =>
        prisma.bankStatement.findFirst({
          where: { id: req.params.sid, storeId: req.params.storeId },
          select: { id: true },
        })
      );
      if (!stmt) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Bank statement not found.' },
        });
        return;
      }

      const difference = await getReconciliationDifference(req.params.sid, req.params.storeId);
      res.json({ data: difference });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /:storeId/finance/bank-statements/:sid/transactions ─────────────────
// Paginated transaction list for a statement with optional match status filter.

const txListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(200).default(50),
  matchStatus: z.enum(['unmatched', 'auto_matched', 'manual_matched', 'ignored']).optional(),
});

router.get(
  '/:storeId/finance/bank-statements/:sid/transactions',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify statement belongs to this store
      const stmt = await runInTenantContext(req.params.storeId, () =>
        prisma.bankStatement.findFirst({
          where: { id: req.params.sid, storeId: req.params.storeId },
          select: { id: true },
        })
      );
      if (!stmt) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Bank statement not found.' },
        });
        return;
      }

      const q = txListSchema.parse(req.query);
      const where: any = { statementId: req.params.sid, storeId: req.params.storeId };
      if (q.matchStatus) where.matchStatus = q.matchStatus;

      const [items, total] = await runInTenantContext(req.params.storeId, () =>
        Promise.all([
          prisma.bankTransaction.findMany({
            where,
            select: {
              id: true,
              date: true,
              description: true,
              amountFils: true,
              direction: true,
              externalRef: true,
              matchStatus: true,
              confidence: true,
              matchedJournalEntryId: true,
              matchedJournalEntry: {
                select: {
                  id: true,
                  entryNumber: true,
                  postedAt: true,
                  memo: true,
                  source: true,
                },
              },
            },
            orderBy: { date: 'asc' },
            skip: (q.page - 1) * q.perPage,
            take: q.perPage,
          }),
          prisma.bankTransaction.count({ where }),
        ])
      );

      res.json({
        data: items,
        meta: { page: q.page, perPage: q.perPage, total, totalPages: Math.ceil(total / q.perPage) },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/finance/bank-statements/:sid/auto-match ──────────────────
// (Re-)run automatic matching for all unmatched transactions.

router.post(
  '/:storeId/finance/bank-statements/:sid/auto-match',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify statement ownership
      const stmt = await runInTenantContext(req.params.storeId, () =>
        prisma.bankStatement.findFirst({
          where: { id: req.params.sid, storeId: req.params.storeId },
          select: { id: true },
        })
      );
      if (!stmt) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Bank statement not found.' },
        });
        return;
      }

      const result = await runAutoMatch(req.params.sid, req.params.storeId);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /:storeId/finance/bank-statements/:sid/transactions/:tid ──────────
// Manual match / unmatch / ignore override.

const manualMatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('match'), journalEntryId: z.string().uuid() }),
  z.object({ action: z.literal('unmatch') }),
  z.object({ action: z.literal('ignore') }),
]);

router.patch(
  '/:storeId/finance/bank-statements/:sid/transactions/:tid',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bodyParsed = manualMatchSchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(422).json({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed.',
            details: bodyParsed.error.flatten(),
          },
        });
        return;
      }

      const body = bodyParsed.data;
      const updated = await applyManualMatch({
        storeId: req.params.storeId,
        transactionId: req.params.tid,
        action: body.action,
        journalEntryId: body.action === 'match' ? body.journalEntryId : undefined,
      });

      res.json({ data: updated });
    } catch (err: any) {
      if (err.statusCode === 404) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Bank transaction or journal entry not found.' },
        });
        return;
      }
      if (err.statusCode === 409) {
        // err.message here is the service's own lower-case discriminant
        // (e.g. "journal_entry_already_matched") — kept as `code` verbatim.
        res.status(409).json({
          success: false,
          error: {
            code: err.message,
            message: 'This journal entry is already matched to a different bank transaction.',
          },
        });
        return;
      }
      if (err.statusCode === 400) {
        res.status(400).json({
          success: false,
          error: { code: 'bad_request', message: err.message },
        });
        return;
      }
      next(err);
    }
  }
);

// ─── DELETE /:storeId/finance/bank-statements/:sid ───────────────────────────
// Delete a statement and all its transactions (cascade).

router.delete(
  '/:storeId/finance/bank-statements/:sid',
  ...bankRecMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stmt = await runInTenantContext(req.params.storeId, () =>
        prisma.bankStatement.findFirst({
          where: { id: req.params.sid, storeId: req.params.storeId },
          select: { id: true },
        })
      );
      if (!stmt) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Bank statement not found.' },
        });
        return;
      }

      await runInTenantContext(req.params.storeId, () =>
        prisma.bankStatement.delete({ where: { id: req.params.sid } })
      );

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
