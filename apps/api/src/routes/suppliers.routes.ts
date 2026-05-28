import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { runInTenantContext } from '@force/database';
import {
  createSupplier,
  updateSupplier,
  listSuppliers,
  getSupplier,
  softDeleteSupplier,
} from '../services/accounting/supplier.service';

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
  notes: z.string().optional(),
  notesAr: z.string().optional(),
});

const updateSchema = createSchema.partial().extend({ isActive: z.boolean().optional() });

router.get(
  '/:storeId/suppliers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req, res, next) => {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const data = await runInTenantContext(req.params.storeId, () =>
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
      const data = await runInTenantContext(req.params.storeId, () =>
        getSupplier(req.params.storeId, req.params.id)
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

router.post(
  '/:storeId/suppliers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('accounting.basic'),
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
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
  async (req, res, next) => {
    try {
      const body = updateSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
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
  async (req, res, next) => {
    try {
      await runInTenantContext(req.params.storeId, () =>
        softDeleteSupplier(req.params.storeId, req.params.id)
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

export default router;
