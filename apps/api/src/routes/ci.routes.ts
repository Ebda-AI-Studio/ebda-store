import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { auditLog } from '../middleware/security';
import { parseInput } from '../lib/parse-input';
import {
  ciOverview,
  courierSuggestion,
  orderCodRisk,
  setCiSharing,
} from '../services/ci-hints.service';

/**
 * Customer Intelligence for the merchant (CI-3, Ruling CI-10). Mounted at the bare '/stores' prefix:
 *
 *   GET /stores/:storeId/ci/overview             status, sharing opt-in, COD-amount card, hint counts
 *   PUT /stores/:storeId/ci/sharing              the cross-store opt-in (default OFF)
 *   GET /stores/:storeId/ci/orders/:orderId/hint COD risk note for one order   (needs `customer_intelligence`)
 *   GET /stores/:storeId/ci/courier              courier ranking for an area   (needs `customer_intelligence`)
 *
 * These endpoints only ADVISE. No checkout, order-create or booking handler calls them; the admin UI does.
 */
const router = Router();
router.param('storeId', tenantContext);

const base = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];
const hints = [...base, requireFeature('customer_intelligence')];

const AREA = /^EG(-[A-Za-z0-9]{1,16}){0,1}(-[a-z0-9-]{1,48})?$/;
const courierQuery = z.object({
  areaKey: z.string().regex(AREA).max(64).optional(),
  carriers: z
    .string()
    .max(400)
    .transform(s =>
      s
        .split(',')
        .map(c => c.trim())
        .filter(Boolean)
    )
    .pipe(
      z
        .array(z.string().regex(/^[a-z0-9_-]{1,32}$/))
        .min(1)
        .max(12)
    ),
});
const sharingBody = z.object({ ciSharing: z.boolean() }).strict();
const orderParams = z.object({ orderId: z.string().uuid() });

router.get(
  '/:storeId/ci/overview',
  ...base,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await ciOverview(req.params.storeId) });
    } catch (e) {
      next(e);
    }
  }
);

router.put(
  '/:storeId/ci/sharing',
  ...base,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ciSharing } = parseInput(sharingBody, req.body);
      await setCiSharing(req.params.storeId, ciSharing);
      await auditLog({
        action: 'store.ci_sharing_changed',
        userId: req.user!.userId,
        storeId: req.params.storeId,
        resourceType: 'store',
        resourceId: req.params.storeId,
        details: { ciSharing },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { ciSharing } });
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  '/:storeId/ci/orders/:orderId/hint',
  ...hints,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId } = parseInput(orderParams, req.params);
      res.json({ success: true, data: await orderCodRisk(req.params.storeId, orderId) });
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  '/:storeId/ci/courier',
  ...hints,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = parseInput(courierQuery, req.query);
      res.json({
        success: true,
        data: await courierSuggestion(req.params.storeId, q.areaKey ?? null, q.carriers),
      });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
