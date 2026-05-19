import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { runInTenantContext } from '@force/database';
import {
  createExpense,
  approveExpense,
  postExpense,
  rejectExpense,
  listExpenses,
  getExpense,
} from '../services/accounting/expense.service';

const router = Router();

const createSchema = z.object({
  supplierId: z.string().uuid().optional(),
  expenseAccountId: z.string().uuid(),
  paidFromAccountId: z.string().uuid(),
  amount: z.number().int().positive(),
  taxAmount: z.number().int().nonnegative().optional(),
  expenseDate: z.string().datetime(),
  currency: z.string().length(3).optional(),
  receiptImageUrl: z.string().url().optional(),
  notes: z.string().max(1000).optional(),
  notesAr: z.string().max(1000).optional(),
});

const rejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

// GET /:storeId/expenses — paginated list with optional status filter
router.get(
  '/:storeId/expenses',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const page = Number(req.query.page ?? 1);
      const perPage = Number(req.query.perPage ?? 50);
      const result = await runInTenantContext(req.params.storeId, () =>
        listExpenses(req.params.storeId, { status, page, perPage })
      );
      res.json({
        data: result.items,
        meta: {
          page: result.page,
          perPage: result.perPage,
          total: result.total,
          totalPages: Math.ceil(result.total / result.perPage),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /:storeId/expenses/:id — full detail
router.get(
  '/:storeId/expenses/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        getExpense(req.params.storeId, req.params.id)
      );
      if (!data) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /:storeId/expenses — create draft
router.post(
  '/:storeId/expenses',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        createExpense({
          storeId: req.params.storeId,
          createdBy: req.user?.userId,
          ...body.data,
        })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /:storeId/expenses/:id/approve — draft → approved (or pending on self-approval with two-step enabled)
router.post(
  '/:storeId/expenses/:id/approve',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        approveExpense(req.params.storeId, req.params.id, req.user?.userId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /:storeId/expenses/:id/post — approved → posted + fires inngest journal event
router.post(
  '/:storeId/expenses/:id/post',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        postExpense(req.params.storeId, req.params.id)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /:storeId/expenses/:id/reject — draft/pending → rejected
router.post(
  '/:storeId/expenses/:id/reject',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      // reason is accepted but not stored on the model (v1 — no rejection reason column yet)
      const body = rejectSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        rejectExpense(req.params.storeId, req.params.id)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// POST /:storeId/expenses/upload-receipt — receipt OCR deferred to Batch 3.
// This stub stores the URL and returns it; the merchant attaches it via the
// create endpoint. Full R2 upload + OCR extraction ships in Batch 3.
router.post(
  '/:storeId/expenses/upload-receipt',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (_req, res, _next) => {
    res.status(501).json({
      error: 'not_implemented',
      message:
        'Receipt upload is scheduled for Batch 3 (OCR pipeline). Pass receiptImageUrl directly on expense creation for now.',
    });
  }
);

export default router;
