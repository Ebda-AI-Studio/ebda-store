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
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, runInTenantContext } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import {
  listAccountsTree,
  createChildAccount,
  setAccountActive,
} from '../services/accounting/account.service';
import { postEntry } from '../services/accounting/journal.service';
import { trialBalance, profitAndLoss, balanceSheet } from '../services/accounting/reports.service';
import { streamXlsxResponse } from '../lib/exports/xlsx';

const router = Router({ mergeParams: true });

// ─── GET /:storeId/finance/accounts ──────────────────────────────────────────

/**
 * Chart of Accounts tree grouped by AccountType.
 * Reflects the current store's accounts only (RLS-enforced).
 */
router.get(
  '/:storeId/finance/accounts',
  authenticate,
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
        res.status(404).json({ error: 'not_found' });
        return;
      }

      res.json({ data: entry });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /:storeId/finance/journal ──────────────────────────────────────────

const manualEntrySchema = z.object({
  memo: z.string().optional(),
  memoAr: z.string().optional(),
  postedAt: z.string().datetime().optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        debit: z.number().int().nonnegative(),
        credit: z.number().int().nonnegative(),
        lineMemo: z.string().optional(),
      })
    )
    .min(2),
});

/**
 * Manual adjusting entry (super_admin only).
 * Store admins post via service helpers, not raw GL, in v1.
 * Returns 201 on success; the postEntry service validates DR=CR balance.
 */
router.post(
  '/:storeId/finance/journal',
  authenticate,
  authorize('super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = manualEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({
          error: 'validation_failed',
          details: parsed.error.flatten(),
        });
        return;
      }

      const body = parsed.data;
      const entry = await runInTenantContext(req.params.storeId, () =>
        postEntry({
          storeId: req.params.storeId,
          source: 'manual',
          memo: body.memo,
          memoAr: body.memoAr,
          postedAt: body.postedAt ? new Date(body.postedAt) : undefined,
          postedBy: (req as any).user?.id,
          lines: body.lines,
        })
      );

      res.status(201).json({ data: entry });
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createChildSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = setActiveSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = new Date(
        String(req.query.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      );
      const to = new Date(String(req.query.to ?? new Date().toISOString()));
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
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
          accounts: raw.equity.map(r => ({ code: r.code, nameEn: r.nameEn, balance: -r.balance })),
          total: raw.totalEquity,
        },
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
      const from = req.query.from ? new Date(String(req.query.from) + 'T00:00:00') : monthStart;
      const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : now;

      const data = await runInTenantContext(req.params.storeId, async () => {
        const [pnl, bs, stockValueRows] = await Promise.all([
          profitAndLoss(req.params.storeId, from, to),
          balanceSheet(req.params.storeId, to),
          prisma.$queryRawUnsafe<{ total: bigint }[]>(
            `SELECT COALESCE(SUM(inventory * COALESCE(cost_price, 0)), 0) AS total
             FROM public.products
             WHERE store_id = $1 AND deleted_at IS NULL`,
            req.params.storeId
          ),
        ]);

        const stockValue = Number(stockValueRows[0]?.total ?? 0);

        return {
          thisMonth: {
            revenue: pnl.totalRevenue,
            expenses: pnl.totalExpenses,
            net: pnl.netIncome,
          },
          cash: bs.assets.filter(a => a.code.startsWith('10')),
          stockValue,
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : undefined;
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = new Date(
        String(req.query.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      );
      const to = new Date(String(req.query.to ?? new Date().toISOString()));
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
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

export default router;
