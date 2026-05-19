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
import { listAccountsTree } from '../services/accounting/account.service';
import { postEntry } from '../services/accounting/journal.service';

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

export default router;
