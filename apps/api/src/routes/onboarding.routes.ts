import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireVerifiedEmail } from '../middleware/require-verified-email';
import { tenantContext } from '../middleware/tenant-context';
import { auditLog, writeLimiter } from '../middleware/security';
import { OnboardingService } from '../services/onboarding.service';
import { createStoreSchema } from './onboarding.schemas';
import { applyOnboardingInstapay } from '../services/onboarding-instapay';
import { toSafeStoreResponse } from '../lib/store-response';

/**
 * Self-serve onboarding, mounted at `/onboarding`.
 *
 * Authorization on every route: authenticate -> authorize -> (store routes)
 * requireStoreAccess. Store creation and go-live additionally need a verified
 * email (`requireVerifiedEmail`, checked against the DB). Public signup and
 * email verification live in merchant-signup.routes.ts / auth.routes.ts.
 */
const router = Router();
router.param('storeId', tenantContext);

const merchantOnly = [authenticate, authorize('store_admin', 'super_admin')];

// GET /onboarding/state - where this merchant is in the funnel (resume point).
router.get('/state', ...merchantOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await OnboardingService.state(req.user!.userId) });
  } catch (error) {
    next(error);
  }
});

// GET /onboarding/slug-check?slug=amelia - live availability for the stepper.
// Authenticated (and rate limited) so it is not an open scraper of taken names.
router.get(
  '/slug-check',
  ...merchantOnly,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = z.object({ slug: z.string().min(1).max(60) }).parse(req.query);
      res.json({
        success: true,
        data: await OnboardingService.checkSlug(slug, {
          allowProtected: req.user!.role === 'super_admin',
        }),
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /onboarding/store - create the (inactive) store on the Growth trial. Verified email only.
router.post(
  '/store',
  ...merchantOnly,
  requireVerifiedEmail,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createStoreSchema.parse(req.body);
      const { store, lookApplied } = await OnboardingService.createStore(
        { userId: req.user!.userId, isSuperAdmin: req.user!.role === 'super_admin' },
        data
      );
      await auditLog({
        action: 'store.self_serve_created',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: store.id,
        details: { slug: store.slug },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res
        .status(201)
        .json({ success: true, data: { store: toSafeStoreResponse(store), lookApplied } });
    } catch (error) {
      next(error);
    }
  }
);

const paymentSchema = z
  .object({
    cod: z.boolean(),
    // Optional so a COD-only client (the original contract) keeps working. When
    // `enabled`, a handle or phone is required (validated by the shared InstaPay schema).
    instapay: z
      .object({
        enabled: z.boolean(),
        handle: z.string().trim().max(120).optional(),
        phone: z.string().trim().max(32).optional(),
        accountName: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// PUT /onboarding/stores/:storeId/payment-methods - COD and InstaPay on/off (card gateways are
// set up later in Settings > Payments).
router.put(
  '/stores/:storeId/payment-methods',
  ...merchantOnly,
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cod, instapay } = paymentSchema.parse(req.body);
      // InstaPay first: `setPaymentMethods` then sees the new state when it enforces
      // "at least one method stays on". An error rolls the whole request transaction back.
      const instapayResult = instapay
        ? await applyOnboardingInstapay(req.params.storeId, instapay)
        : undefined;
      const data = await OnboardingService.setPaymentMethods(req.params.storeId, { cod });
      if (instapayResult?.configId) {
        await auditLog({
          action: 'store_payment_config.updated',
          userId: req.user!.userId,
          resourceType: 'payment_config',
          resourceId: instapayResult.configId,
          details: { storeId: req.params.storeId, provider: 'instapay', via: 'onboarding' },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      res.json({
        success: true,
        data: instapayResult ? { ...data, instapay: instapayResult.instapay } : data,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /onboarding/stores/:storeId/go-live - inactive -> active.
router.post(
  '/stores/:storeId/go-live',
  ...merchantOnly,
  requireStoreAccess,
  requireVerifiedEmail,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await OnboardingService.goLive(req.params.storeId);
      await auditLog({
        action: 'store.went_live',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: store.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { store: toSafeStoreResponse(store) } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
