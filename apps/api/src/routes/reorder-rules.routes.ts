/**
 * Reorder rules CRUD (M-107): the merchant's per-product / per-variant restock thresholds the reorder scan and the
 * low-stock report read. No money effect. Store-scoped, same gate chain as the reorder-suggestion routes
 * (authenticate -> MFA -> store_admin|super_admin -> requireStoreAccess); every write is audit-logged.
 *
 *   GET    /:storeId/stock/reorder-rules
 *   POST   /:storeId/stock/reorder-rules        409 REORDER_RULE_EXISTS on a duplicate (product, variant)
 *   PATCH  /:storeId/stock/reorder-rules/:id
 *   DELETE /:storeId/stock/reorder-rules/:id
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { runInStoreCtx } from '../lib/jobs/store-db';
import {
  createReorderRule,
  deleteReorderRule,
  listReorderRules,
  updateReorderRule,
} from '../services/accounting/reorder-rule.service';

const router = Router({ mergeParams: true });

const fields = {
  minQty: z.number().int().min(0).max(1_000_000),
  reorderQty: z.number().int().min(1).max(1_000_000),
  leadTimeDays: z.number().int().min(0).max(365),
  safetyStockDays: z.number().int().min(0).max(365),
  preferredSupplierId: z.string().uuid().nullable(),
  isActive: z.boolean(),
};

const createSchema = z
  .object({
    productId: z.string().uuid(),
    variantId: z.string().uuid().nullable().optional(),
    minQty: fields.minQty,
    reorderQty: fields.reorderQty,
    leadTimeDays: fields.leadTimeDays.optional(),
    safetyStockDays: fields.safetyStockDays.optional(),
    preferredSupplierId: fields.preferredSupplierId.optional(),
    isActive: fields.isActive.optional(),
  })
  .strict();

// product + variant are the rule's identity: they cannot be edited (delete and re-create instead).
const updateSchema = z
  .object({
    minQty: fields.minQty.optional(),
    reorderQty: fields.reorderQty.optional(),
    leadTimeDays: fields.leadTimeDays.optional(),
    safetyStockDays: fields.safetyStockDays.optional(),
    preferredSupplierId: fields.preferredSupplierId.optional(),
    isActive: fields.isActive.optional(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'Nothing to update.' });

const idSchema = z.string().uuid();

function invalid(res: Response, issues: unknown) {
  res.status(422).json({
    success: false,
    error: {
      code: 'validation_failed',
      message: 'Validation failed.',
      details: { issues },
    },
  });
}

const gate = [authenticate, requireMfaEnrolled, authorize('store_admin', 'super_admin')] as const;

router.get(
  '/:storeId/stock/reorder-rules',
  ...gate,
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await runInStoreCtx(req.params.storeId, () =>
        listReorderRules(req.params.storeId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/stock/reorder-rules',
  ...gate,
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) return invalid(res, body.error.issues);
      const { storeId } = req.params;
      const data = await runInStoreCtx(storeId, () => createReorderRule(storeId, body.data));
      await auditLog({
        action: 'reorder_rule.created',
        userId: req.user?.userId,
        storeId,
        resourceType: 'reorder_rule',
        resourceId: data.id,
        details: { ...body.data },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:storeId/stock/reorder-rules/:id',
  ...gate,
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) return invalid(res, id.error.issues);
      const body = updateSchema.safeParse(req.body);
      if (!body.success) return invalid(res, body.error.issues);
      const { storeId } = req.params;
      const data = await runInStoreCtx(storeId, () =>
        updateReorderRule(storeId, id.data, body.data)
      );
      await auditLog({
        action: 'reorder_rule.updated',
        userId: req.user?.userId,
        storeId,
        resourceType: 'reorder_rule',
        resourceId: id.data,
        details: { ...body.data },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:storeId/stock/reorder-rules/:id',
  ...gate,
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) return invalid(res, id.error.issues);
      const { storeId } = req.params;
      await runInStoreCtx(storeId, () => deleteReorderRule(storeId, id.data));
      await auditLog({
        action: 'reorder_rule.deleted',
        userId: req.user?.userId,
        storeId,
        resourceType: 'reorder_rule',
        resourceId: id.data,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
