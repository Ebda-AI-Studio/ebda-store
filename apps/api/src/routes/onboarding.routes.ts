import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireVerifiedEmail } from '../middleware/require-verified-email';
import { tenantContext } from '../middleware/tenant-context';
import { auditLog, writeLimiter } from '../middleware/security';
import { OnboardingService, SELF_SERVE_TEMPLATES } from '../services/onboarding.service';

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

const createStoreSchema = z.object({
  name: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100).optional(),
  slug: z.string().trim().min(1).max(60),
  template: z.enum(SELF_SERVE_TEMPLATES).optional(),
  language: z.enum(['ar', 'en']).optional(),
});

// POST /onboarding/store - create the (inactive, free-plan) store. Verified email only.
router.post(
  '/store',
  ...merchantOnly,
  requireVerifiedEmail,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createStoreSchema.parse(req.body);
      const store = await OnboardingService.createStore(
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
      res.status(201).json({ success: true, data: { store } });
    } catch (error) {
      next(error);
    }
  }
);

const paymentSchema = z.object({ cod: z.boolean() }).strict();

// PUT /onboarding/stores/:storeId/payment-methods - COD on/off (gateways: SP6).
router.put(
  '/stores/:storeId/payment-methods',
  ...merchantOnly,
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = paymentSchema.parse(req.body);
      res.json({
        success: true,
        data: await OnboardingService.setPaymentMethods(req.params.storeId, data),
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
      res.json({ success: true, data: { store } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
