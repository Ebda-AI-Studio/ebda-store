import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { uploadLimiter, dailyUploadLimiter } from '../middleware/security';
import { StorageService } from '../services/storage.service';
import { runInTenantContext } from '@force/database';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import {
  createExpense,
  approveExpense,
  postExpense,
  rejectExpense,
  listExpenses,
  getExpense,
} from '../services/accounting/expense.service';

const router = Router();

// Multer for receipt image uploads (memory storage, same pattern as upload.routes.ts)
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (allowed.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp`));
    }
  },
});

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

// POST /:storeId/expenses/upload-receipt — upload a receipt image to R2 and
// queue async OCR extraction via Inngest. Returns 202 immediately; the expense
// draft appears in the list once the OCR job completes (typically <10 seconds).
router.post(
  '/:storeId/expenses/upload-receipt',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  uploadLimiter,
  dailyUploadLimiter,
  receiptUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res
          .status(400)
          .json({ error: 'no_file', message: 'No file uploaded. Send field name: file' });
        return;
      }

      if (!StorageService.isAvailable()) {
        res
          .status(503)
          .json({ error: 'storage_unavailable', message: 'R2 storage is not configured.' });
        return;
      }

      // Upload to R2 under stores/<storeId>/receipts/
      const uploaded = await runInTenantContext(req.params.storeId, () =>
        StorageService.upload(req.file!.buffer, req.file!.originalname, {
          folder: 'misc', // misc is on the ALLOWED_FOLDERS list in storage.service.ts
          storeId: req.params.storeId,
          contentType: req.file!.mimetype,
          allowedTypes: ['image/jpeg', 'image/png', 'image/webp'],
        })
      );

      // Fire async OCR job — non-blocking
      try {
        await inngest.send({
          name: 'accounting/expense-ocr-process',
          data: {
            storeId: req.params.storeId,
            receiptUrl: uploaded.url,
            uploadedBy: req.user?.userId,
          },
        });
      } catch (inngestErr) {
        // Log but don't fail the upload — the URL is already in R2
        logger.error(
          { err: inngestErr, storeId: req.params.storeId, url: uploaded.url },
          'upload-receipt: failed to enqueue OCR job'
        );
      }

      res.status(202).json({
        jobAccepted: true,
        receiptUrl: uploaded.url,
        message: 'Processing — your expense draft will appear shortly.',
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
