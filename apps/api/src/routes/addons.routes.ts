/**
 * Merchant add-on + AI pack purchase (SELF-SERVICE A8 + A9, money). Mounted by billing.routes.ts at
 * /stores/:storeId/billing/addons, so it inherits `billingRouteContext` (writes run under a store scope and never hold
 * the request transaction across the gateway). Owner only: `store_admin` passes `requireStoreAccess` solely for the
 * store it owns, staff are a different role and are refused by `authorize`; super_admin keeps the override.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog } from '../middleware/security';
import { idempotencyKeyOf } from '../lib/money-idempotency';
import { AppError } from '../middleware/error-handler';
import { instapayReceiptFieldsSchema } from '@ebda/shared';
import { addonInstapayInstructions, submitAddonReceipt } from '../services/billing/addon-instapay';
import {
  cancelAddon,
  listAddonHistory,
  listAddons,
  previewAddon,
  purchaseAddon,
  resumeAddon,
} from '../services/billing/addons.service';

const router = Router({ mergeParams: true });

const read = [
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
];
// Money writes refuse an impersonated support session (same rule as every billing write).
const write = [
  authenticate,
  requireMfaEnrolled,
  rejectImpersonated,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
];

const skuSchema = z.string().min(3).max(64);
const previewSchema = z.object({ sku: skuSchema }).strict();
const checkoutSchema = z
  .object({ sku: skuSchema, confirmToken: z.string().min(10).max(2000) })
  .strict();

const audit = (req: Request, action: string, details: Record<string, unknown>) =>
  auditLog({
    action,
    userId: req.user!.userId,
    storeId: req.params.storeId,
    resourceType: 'store_addon',
    resourceId: String(details.sku),
    details,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

router.get('/', ...read, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await listAddons(req.params.storeId) });
  } catch (err) {
    next(err);
  }
});

/** The merchant's own add-on purchases, renewals, failures and refunds (receipt data; no provider fields). */
router.get('/history', ...read, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { items: await listAddonHistory(req.params.storeId) } });
  } catch (err) {
    next(err);
  }
});

/** Step 1 of 2: the exact charge + a single-use token bound to it. Nothing is charged or written. */
router.post('/preview', ...write, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sku } = previewSchema.parse(req.body);
    const out = await previewAddon({ storeId: req.params.storeId, userId: req.user!.userId, sku });
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

/** Step 2 of 2: the explicit yes. Needs the token and an Idempotency-Key; answers the hosted card page. */
router.post('/checkout', ...write, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sku, confirmToken } = checkoutSchema.parse(req.body);
    const idempotencyKey = idempotencyKeyOf(req.header('idempotency-key'));
    if (!idempotencyKey)
      throw new AppError(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'This purchase needs an Idempotency-Key header'
      );
    const out = await purchaseAddon({
      storeId: req.params.storeId,
      userId: req.user!.userId,
      sku,
      confirmToken,
      idempotencyKey,
    });
    await audit(req, 'billing.addon_checkout_started', { sku, billingEventId: out.billingEventId });
    res.status(201).json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

/** InstaPay for one add-on: handle, QR, the exact total and the reference. Read-only; nothing is created. */
router.get('/:sku/instapay', ...read, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sku = skuSchema.parse(req.params.sku);
    res.json({ success: true, data: await addonInstapayInstructions(req.params.storeId, sku) });
  } catch (err) {
    next(err);
  }
});

/**
 * The merchant's checked receipt for an add-on paid by InstaPay (the screenshot goes up through the existing
 * POST /billing/receipts). Opens an entry in the super-admin approval queue and NEVER turns anything on.
 */
router.post(
  '/:sku/instapay/receipts/:receiptId/submit',
  ...write,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sku = skuSchema.parse(req.params.sku);
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const fields = instapayReceiptFieldsSchema.parse(req.body);
      const out = await submitAddonReceipt({
        storeId: req.params.storeId,
        sku,
        receiptId,
        fields,
      });
      await audit(req, 'billing.addon_instapay_claimed', { sku, claimId: out.claim.id });
      res.status(201).json({
        success: true,
        data: { claim: { id: out.claim.id, status: out.claim.status }, receipt: out.receipt },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/:sku/cancel', ...write, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sku = skuSchema.parse(req.params.sku);
    const out = await cancelAddon({ storeId: req.params.storeId, sku });
    await audit(req, 'billing.addon_cancelled', { sku, effectiveAt: out.effectiveAt });
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

router.post('/:sku/resume', ...write, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sku = skuSchema.parse(req.params.sku);
    const out = await resumeAddon({ storeId: req.params.storeId, sku });
    await audit(req, 'billing.addon_resumed', { sku });
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

export default router;
