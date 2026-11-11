import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { requireFeature } from '../middleware/feature-gate';
import { uploadLimiter, dailyUploadLimiter } from '../middleware/security';
import { StorageService } from '../services/storage.service';
import { enforceMaxDimensions } from '../services/image-resize.service';
import { sniffImage, IMAGE_EXT, renameByKind, uploadContentError } from '../lib/upload-sniff';

import { inngest } from '../lib/inngest/client';
import { ALLOWED_CURRENCIES, REGION } from '@ebda/shared';
import logger from '../lib/logger';
import {
  createExpense,
  approveExpense,
  postExpense,
  rejectExpense,
  listExpenses,
  getExpense,
} from '../services/accounting/expense.service';
import { runInStoreCtx } from '../lib/jobs/store-db';
import {
  PRIVATE_RECEIPT_PREFIX,
  privateReceiptKey,
} from '../services/accounting/expense-ocr.service';

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
      cb(
        new AppError(
          400,
          'INVALID_FILE_TYPE',
          `Unsupported file type: ${file.mimetype}. Allowed: jpeg, png, webp`
        )
      );
    }
  },
});

const createSchema = z
  .object({
    supplierId: z.string().uuid().optional(),
    expenseAccountId: z.string().uuid(),
    paidFromAccountId: z.string().uuid(),
    amount: z.number().int().positive(),
    taxAmount: z.number().int().nonnegative().optional(),
    // Accept both a full ISO-8601 datetime ("2026-06-15T00:00:00.000Z") and a
    // bare date string ("2026-06-15") produced by <input type="date">.
    // z.coerce.date() converts either form to a Date; the service stores it as a
    // DB timestamp so both are safe. Fixes the 422 on every manual expense save.
    expenseDate: z.coerce.date(),
    /** ISO-4217 currency code. Defaults to 'EGP' when absent. */
    currency: z
      .enum(ALLOWED_CURRENCIES)
      .optional()
      .transform(v => v?.toUpperCase() ?? REGION.currency),
    /**
     * FX rate: 1 unit of `currency` = fxRate EGP.
     * Required when currency !== 'EGP'. Positive finite number.
     */
    fxRate: z.number().positive().finite().optional(),
    /**
     * Original amount in the foreign currency's minor units.
     * When absent, the API treats `amount` as the raw foreign amount.
     */
    originalAmount: z.number().int().nonnegative().optional(),
    receiptImageUrl: z.string().url().optional(),
    notes: z.string().max(1000).optional(),
    notesAr: z.string().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    const currency = (data.currency ?? REGION.currency).toUpperCase();
    // fxRate is required for non-EGP currencies when the expense is NOT an
    // OCR-created draft (those omit fxRate and store a placeholder).
    // We enforce this at the API boundary so callers don't silently store
    // a 1:1 rate for a genuinely non-EGP amount.
    if (currency !== REGION.currency && data.fxRate === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fxRate'],
        message: `fxRate is required when currency is ${currency}`,
      });
    }
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
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const page = Number(req.query.page ?? 1);
      const perPage = Number(req.query.perPage ?? 50);
      // `expenseDate` is a CALENDAR date (the form posts `YYYY-MM-DD`, stored
      // as that day's UTC midnight), so the filter is whole UTC days — with an
      // explicit `Z`, so the result no longer depends on the server's TZ.
      const day = (v: unknown, time: string) => {
        if (!v) return undefined;
        const d = new Date(`${String(v).slice(0, 10)}T${time}Z`);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };
      const from = day(req.query.from, '00:00:00.000');
      const to = day(req.query.to, '23:59:59.999');
      // `hasOcr=true` — only receipt-upload drafts (the finance
      // dashboard's "Pending OCR drafts" card). It was sent but never read, so
      // that card counted every draft.
      const hasOcr = req.query.hasOcr === 'true' ? true : undefined;
      const result = await runInStoreCtx(req.params.storeId, () =>
        listExpenses(req.params.storeId, { status, page, perPage, from, to, hasOcr })
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
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
        getExpense(req.params.storeId, req.params.id)
      );
      if (!data) {
        res
          .status(404)
          .json({ success: false, error: { code: 'not_found', message: 'Expense not found.' } });
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
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
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
      const data = await runInStoreCtx(req.params.storeId, () =>
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
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
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
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
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
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      // reason is accepted but not stored on the model (v1 — no rejection reason column yet)
      const body = rejectSchema.safeParse(req.body);
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
      const data = await runInStoreCtx(req.params.storeId, () =>
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
  requireFeature('accounting.expenses'),
  uploadLimiter,
  dailyUploadLimiter,
  receiptUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { code: 'no_file', message: 'No file uploaded. Send field name: file' },
        });
        return;
      }

      if (!StorageService.isAvailable()) {
        res.status(503).json({
          success: false,
          error: { code: 'storage_unavailable', message: 'R2 storage is not configured.' },
        });
        return;
      }

      // Same unconditional ceiling as product uploads — a receipt photographed
      // on a phone is a 10 MB camera original otherwise, and this route accepts
      // up to exactly that. 2000px on the longest side is BELOW a typical
      // 3000-4000px receipt photo, so it was measured rather than assumed
      // (issue 1049, Ruling DRM-2): the OCR model (Gemini Flash Lite, which
      // downsamples internally anyway) extracted identical totals and 22/22
      // line totals from a 3024x4032 receipt photo and its 2000px version,
      // blurred and skewed, 3 runs each. Stored bytes drop ~95%.
      // The bytes decide (B0-46): the declared mime the filter above checked is the client's.
      const receiptKind = sniffImage(req.file!.buffer);
      if (
        receiptKind !== 'image/jpeg' &&
        receiptKind !== 'image/png' &&
        receiptKind !== 'image/webp'
      ) {
        const e = uploadContentError('receipt');
        throw new AppError(400, e.code, e.message, e.details);
      }
      const receiptBuffer = await enforceMaxDimensions(req.file!.buffer);
      // Named and typed by the bytes actually stored, never the client's filename or mime.
      const storedKind = sniffImage(receiptBuffer) ?? receiptKind;

      // Private bucket: not part of the public-uploads usage the plan ceiling counts, so no assertStorageRoom here.

      // Receipts are merchant financial documents: PRIVATE bucket only, under stores/<storeId>/receipts/, never a
      // public URL. They are read back through GET /:storeId/expenses/:expenseId/receipt (authorised).
      const { key } = await StorageService.putPrivate(receiptBuffer, {
        storeId: req.params.storeId,
        folder: 'receipts',
        ext: IMAGE_EXT[storedKind],
        contentType: storedKind,
      });
      const uploaded = { url: `${PRIVATE_RECEIPT_PREFIX}${key}` };

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

// GET /:storeId/expenses/:expenseId/receipt: stream the private receipt image to an authorised store admin.
router.get(
  '/:storeId/expenses/:expenseId/receipt',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.expenses'),
  async (req, res, next) => {
    try {
      const exp = await runInStoreCtx(req.params.storeId, () =>
        getExpense(req.params.storeId, req.params.expenseId)
      );
      const key = exp?.receiptImageUrl
        ? privateReceiptKey(exp.receiptImageUrl, req.params.storeId)
        : null;
      if (!key) throw new AppError(404, 'NOT_FOUND', 'Receipt not found');
      const { body, contentType } = await StorageService.getPrivate(key);
      res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.send(body);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
