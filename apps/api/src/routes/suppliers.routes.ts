import { Router } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { writeLimiter } from '../middleware/security';

import {
  createSupplier,
  updateSupplier,
  listSuppliers,
  getSupplier,
  softDeleteSupplier,
} from '../services/accounting/supplier.service';
import { runInStoreCtx } from '../lib/jobs/store-db';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  paymentTerms: z.enum(['net0', 'net15', 'net30', 'net60', 'custom']).optional(),
  customTermsDays: z.number().int().min(1).max(365).optional(),
  leadTimeDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().optional(),
  notesAr: z.string().optional(),
});

// A PATCH clears a nullable column by sending an explicit `null` (an omitted
// key leaves the stored value — Prisma's convention, which the admin edit form
// follows via `textFieldValue(x, 'update')`). `createSchema.partial()` alone
// leaves these as `z.string().optional()`, which REJECTS null, so every edit of
// a supplier with a blank Arabic name/contact/notes 422'd. Each field nullable
// in the Prisma model is nullable here too.
export const updateSchema = createSchema.partial().extend({
  nameAr: z.string().max(200).nullable().optional(),
  contactName: z.string().max(200).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().nullable().optional(),
  notesAr: z.string().nullable().optional(),
  // null clears custom terms when the supplier moves to a standard term
  // (issue 2262); the admin form sends it via numericFieldValue(…, 'update').
  customTermsDays: z.number().int().min(1).max(365).nullable().optional(),
  isActive: z.boolean().optional(),
});

router.get(
  '/:storeId/suppliers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req, res, next) => {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const data = await runInStoreCtx(req.params.storeId, () =>
        listSuppliers(req.params.storeId, { includeInactive })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/suppliers/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req, res, next) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
        getSupplier(req.params.storeId, req.params.id)
      );
      if (!data) {
        res
          .status(404)
          .json({ success: false, error: { code: 'not_found', message: 'Supplier not found.' } });
        return;
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/suppliers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  writeLimiter,
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
        createSupplier({ storeId: req.params.storeId, ...body.data })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:storeId/suppliers/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  writeLimiter,
  async (req, res, next) => {
    try {
      const body = updateSchema.safeParse(req.body);
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
        updateSupplier(req.params.storeId, req.params.id, body.data)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:storeId/suppliers/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  writeLimiter,
  async (req, res, next) => {
    try {
      await runInStoreCtx(req.params.storeId, () =>
        softDeleteSupplier(req.params.storeId, req.params.id)
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
