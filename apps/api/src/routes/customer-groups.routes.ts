/**
 * Customer group CRUD + customer assignment.
 *
 * Deliberately NOT behind a `requireFeature` gate: customer groups are the
 * dependency root for promotion/coupon targeting and group-scoped pricing, so
 * gating them would gate those. They are core commerce structure, like
 * categories — not a sold add-on.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { tenantContext } from '../middleware/tenant-context';
import { CustomerGroupService } from '../services/customer-group.service';
import { assertWholesaleEntitled, enablesWholesale } from '../lib/b2b-invalidate';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so every route
// declares its own '/:storeId/...' path and router.param sets RLS tenant
// context once :storeId resolves. Same shape as tax.routes.ts.
router.param('storeId', tenantContext);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  // B2B pricing (Task 4). Turning any of it ON needs the b2b.wholesale entitlement; turning it off never does.
  pricingMode: z.enum(['none', 'percent_off']).optional(),
  discountBps: z.number().int().min(0).max(9000).optional(),
  requiresApproval: z.boolean().optional(),
  isWholesale: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

const assignSchema = z.object({
  groupId: z.string().uuid().nullable(),
});

// Assign by contact identity — used by the order/user-based customer views,
// which never hold a Customer id. At least one of phone/email is required
// (enforced in the service, not the schema, so the error is a clean 400).
const assignByIdentitySchema = z.object({
  userId: z.string().uuid().nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.string().trim().max(255).nullish(),
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  groupId: z.string().uuid().nullable(),
});

// GET /stores/:storeId/customer-groups
router.get(
  '/:storeId/customer-groups',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const groups = await CustomerGroupService.list(req.params.storeId);
      res.json({ success: true, data: { groups } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/customer-groups/:id
router.get(
  '/:storeId/customer-groups/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const group = await CustomerGroupService.get(req.params.storeId, req.params.id);
      res.json({ success: true, data: { group } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/customer-groups
router.post(
  '/:storeId/customer-groups',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createSchema.parse(req.body);
      if (enablesWholesale(data)) await assertWholesaleEntitled(req.params.storeId);
      const group = await CustomerGroupService.create(req.params.storeId, data);
      res.status(201).json({ success: true, data: { group } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/customer-groups/:id
router.put(
  '/:storeId/customer-groups/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateSchema.parse(req.body);
      if (enablesWholesale(data)) await assertWholesaleEntitled(req.params.storeId);
      const group = await CustomerGroupService.update(req.params.storeId, req.params.id, data);
      res.json({ success: true, data: { group } });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/customer-groups/:id
// Members are not deleted — the FK is ON DELETE SET NULL, so they become ungrouped.
router.delete(
  '/:storeId/customer-groups/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await CustomerGroupService.remove(req.params.storeId, req.params.id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/customers/group-assignment — assign by contact identity.
// Materializes the `customers` row (phone-first, email fallback) so a customer
// from the order/user-based admin views can be grouped. Distinct path from the
// id-based route below, so there is no :customerId capture collision.
router.put(
  '/:storeId/customers/group-assignment',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId, ...identity } = assignByIdentitySchema.parse(req.body);
      const customer = await CustomerGroupService.assignByIdentity(
        req.params.storeId,
        identity,
        groupId
      );
      res.json({ success: true, data: { customer } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/customers/:customerId/group — assign or clear (groupId: null)
router.put(
  '/:storeId/customers/:customerId/group',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId } = assignSchema.parse(req.body);
      const customer = await CustomerGroupService.assignCustomer(
        req.params.storeId,
        req.params.customerId,
        groupId
      );
      res.json({ success: true, data: { customer } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
