import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { EtaReceiptService } from '../services/eta-receipt.service';
import { AppError } from '../middleware/error-handler';

const router = Router();
// Mounted at the bare '/stores' prefix (same as tax.routes.ts): every route declares '/:storeId/...'.
router.param('storeId', tenantContext);

const guard = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('eta_ereceipt'),
];

const actor = (req: Request) => ({
  userId: req.user!.userId,
  ip: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

// GET /stores/:storeId/eta/connection - masked connection (secrets never leave the server)
router.get(
  '/:storeId/eta/connection',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: { connection: await EtaReceiptService.getConnection(req.params.storeId) },
      });
    } catch (e) {
      next(e);
    }
  }
);

// PUT /stores/:storeId/eta/connection - save credentials + settings (a masked secret keeps the stored one)
router.put(
  '/:storeId/eta/connection',
  ...guard,
  rejectImpersonated, // BE:S-2 (Ruling FP-3)
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connection = await EtaReceiptService.saveConnection(
        req.params.storeId,
        req.body,
        actor(req)
      );
      res.json({ success: true, data: { connection } });
    } catch (e) {
      next(e);
    }
  }
);

// POST /stores/:storeId/eta/connection/check - authenticate against ETA (no receipt is sent)
router.post(
  '/:storeId/eta/connection/check',
  ...guard,
  rejectImpersonated, // BE:S-2 (Ruling FP-3)
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: await EtaReceiptService.checkConnection(req.params.storeId),
      });
    } catch (e) {
      next(e);
    }
  }
);

// GET /stores/:storeId/orders/:orderId/eta - receipt status for the order page
router.get(
  '/:storeId/orders/:orderId/eta',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: {
          receipts: await EtaReceiptService.listForOrder(req.params.storeId, req.params.orderId),
        },
      });
    } catch (e) {
      next(e);
    }
  }
);

// POST /stores/:storeId/eta/receipts/:id/retry - re-issue a failed/rejected receipt as the next seq
router.post(
  '/:storeId/eta/receipts/:id/retry',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ok = await EtaReceiptService.retry(req.params.storeId, req.params.id);
      if (!ok)
        throw new AppError(
          409,
          'ETA_RETRY_NOT_ALLOWED',
          'only the latest failed or rejected receipt can be re-issued'
        );
      res.json({ success: true, data: { queued: true } });
    } catch (e) {
      next(e);
    }
  }
);

// POST /stores/:storeId/eta/receipts/:id/return-reason - the merchant's ETA reason (I | B) for a price-only refund
router.post(
  '/:storeId/eta/receipts/:id/return-reason',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await EtaReceiptService.setReturnReason(req.params.storeId, req.params.id, req.body?.reason);
      res.json({ success: true, data: { queued: true } });
    } catch (e) {
      next(e);
    }
  }
);

export default router;
