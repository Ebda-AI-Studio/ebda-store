import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize, customerUserId } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { LoyaltyService } from '../services/loyalty.service';
import { LoyaltyTransactionType, prisma } from '@ebda/database';
import { tenantContext } from '../middleware/tenant-context';
import { rangeOrLegacyDays } from '../lib/report-range';
import { assertStoreCustomer } from '../lib/store-customer';

// TWO routers, deliberately. The admin half is mounted ONLY at the bare
// '/stores' prefix; the customer half is the only thing mounted at '/public'
// (see routes/index.ts).
//
// DO NOT collapse these back into one router mounted at both prefixes. Two
// global controls in middleware/security.ts are keyed on the PATH PREFIX, not
// on the route's own middleware chain, and a whole-router dual mount defeats
// both for every admin route in the file:
//   - `csrfProtection` returns next() for any path containing '/public/', so
//     PUT /public/:storeId/loyalty/settings and POST .../award would become
//     cookie-authenticated writes with no CSRF token check.
//   - `restrictPlatformOnlyOrigins` denies non-platform origins only under
//     '/api/v1/stores', and CORS allowlists every merchant-registered custom
//     domain with credentials:true — so a merchant-controlled page could lure
//     a signed-in store_admin/super_admin and read the member + transaction
//     lists (customer names, emails, order numbers) cross-origin.
// `authenticate`/`authorize`/`requireStoreAccess` do not close either hole:
// they bound WHICH stores the lured admin reaches, not whether the attacker's
// page gets to use that admin's cookie.
//
// Both routers are mounted at BARE prefixes, so Express does NOT populate
// req.params.storeId at the mount level — every route below declares its own
// '/:storeId/...' path. router.param runs AFTER Express resolves :storeId for
// the matched route, so RLS tenant context is set correctly on either router.
// See F2, docs/plans/2026-07-02-rls-cutover.md.
const router = Router();
router.param('storeId', tenantContext);

const publicRouter = Router();
publicRouter.param('storeId', tenantContext);

// Validation schemas
const tierSchema = z.object({
  minPoints: z.number(),
  multiplier: z.number(),
});

const updateSettingsSchema = z.object({
  loyaltyEnabled: z.boolean().optional(),
  settings: z
    .object({
      pointsPerMajorUnit: z.number().min(1).max(100).optional(),
      signupBonus: z.number().min(0).optional(),
      referralBonus: z.number().min(0).optional(),
      reviewBonus: z.number().min(0).optional(),
      birthdayBonus: z.number().min(0).optional(),
      tiers: z
        .object({
          bronze: tierSchema,
          silver: tierSchema,
          gold: tierSchema,
          platinum: tierSchema,
        })
        .optional(),
      pointsValue: z.number().min(1).optional(),
      minRedeemPoints: z.number().min(0).optional(),
      maxRedeemPercentage: z.number().min(0).max(100).optional(),
      expirationMonths: z.number().min(0).optional(),
    })
    .optional(),
});

const awardPointsSchema = z.object({
  points: z.number().int().min(-1_000_000).max(1_000_000),
  type: z.enum(['earn_manual', 'earn_referral', 'earn_review', 'earn_birthday', 'adjust'] as const),
  description: z.string().optional(),
});

// ==========================================
// Admin Routes
// ==========================================

// GET /stores/:storeId/loyalty/settings - Get loyalty settings
router.get(
  '/:storeId/loyalty/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const result = await LoyaltyService.getSettings(storeId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/loyalty/settings - Update loyalty settings
router.put(
  '/:storeId/loyalty/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = updateSettingsSchema.parse(req.body);

      const result = await LoyaltyService.updateSettings(storeId, data);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/loyalty/stats - Get loyalty program statistics
router.get(
  '/:storeId/loyalty/stats',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const stats = await LoyaltyService.getStats(storeId);

      res.json({
        success: true,
        data: { stats },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/loyalty/members - List loyalty members
router.get(
  '/:storeId/loyalty/members',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, tier, search } = req.query;

      const result = await LoyaltyService.listMembers(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        tier: tier as string | undefined,
        search: search as string | undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/loyalty/members/:customerId - Get customer points
router.get(
  '/:storeId/loyalty/members/:customerId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      await assertStoreCustomer(storeId, customerId); // SEC-CUSTOMER-SCOPE-1
      const points = await LoyaltyService.getCustomerPoints(storeId, customerId);

      if (!points) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Customer loyalty points not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: { points },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/loyalty/transactions - Store-level paginated transaction log (admin)
router.get(
  '/:storeId/loyalty/transactions',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, type, customerId } = req.query;
      // Shared report-range contract (viewer-local days); legacy date-only
      // `from`/`to` still accepted as UTC days. The old parse mixed a UTC
      // start with a server-local end.
      const range = rangeOrLegacyDays(req.query as Record<string, unknown>);
      if (!range.ok) {
        res.status(422).json({
          success: false,
          error: { code: 'validation_failed', message: 'Invalid date range.' },
        });
        return;
      }

      const pageNum = Math.max(1, parseInt((page as string) || '1') || 1);
      const limitNum = Math.min(100, Math.max(1, parseInt((limit as string) || '50') || 50));
      const skip = (pageNum - 1) * limitNum;

      // SEC-CUSTOMER-SCOPE-1: the joined customer PII must belong to this store.
      const where: any = { storeId, customer: { storeId, role: 'customer' } };
      if (type && typeof type === 'string' && type !== 'all') {
        where.type = type as LoyaltyTransactionType;
      }
      if (customerId && typeof customerId === 'string') {
        where.customerId = customerId;
      }
      if (range.from || range.to) {
        where.createdAt = {};
        if (range.from) where.createdAt.gte = range.from;
        if (range.to) where.createdAt.lte = range.to;
      }

      const [transactions, total] = await Promise.all([
        prisma.loyaltyTransaction.findMany({
          where,
          include: {
            customer: { select: { id: true, firstName: true, lastName: true, email: true } },
            order: { select: { id: true, orderNumber: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limitNum,
        }),
        prisma.loyaltyTransaction.count({ where }),
      ]);

      res.json({
        success: true,
        data: {
          transactions,
          meta: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/loyalty/members/:customerId/transactions - Get customer transactions
router.get(
  '/:storeId/loyalty/members/:customerId/transactions',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      const { page, limit } = req.query;

      const result = await LoyaltyService.getTransactionHistory(storeId, customerId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/loyalty/members/:customerId/award - Award bonus points
router.post(
  '/:storeId/loyalty/members/:customerId/award',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('loyalty'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      const data = awardPointsSchema.parse(req.body);

      const result = await LoyaltyService.awardBonusPoints(
        storeId,
        customerId,
        data.points,
        data.type as LoyaltyTransactionType,
        data.description
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public/Customer Routes (publicRouter — the ONLY router mounted at '/public')
// ==========================================

// GET /public/:storeId/loyalty/my-points - Get own points (authenticated customer)
// (resolves via the '/public' mount in routes/index.ts; the path declared
// here has no '/public' prefix of its own — see the header comment above)
publicRouter.get(
  '/:storeId/loyalty/my-points',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Customer-only endpoint reachable from a shared API cookie space.
      // customerUserId() rejects admin/super_admin tokens here so a merchant
      // browsing their dashboard can't accidentally read or join a customer's
      // loyalty record under their own userId.
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }

      const points = await LoyaltyService.getCustomerPoints(storeId, customerId);

      res.json({
        success: true,
        data: { points },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/loyalty/my-transactions - Get own transaction history
publicRouter.get(
  '/:storeId/loyalty/my-transactions',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }
      const { page, limit } = req.query;

      const result = await LoyaltyService.getTransactionHistory(storeId, customerId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /public/:storeId/loyalty/join - Join loyalty program
publicRouter.post(
  '/:storeId/loyalty/join',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Customer account required' },
        });
        return;
      }

      const points = await LoyaltyService.initializeCustomerPoints(storeId, customerId, true);

      res.status(201).json({
        success: true,
        data: { points },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/loyalty/info - Get loyalty program info (public)
publicRouter.get(
  '/:storeId/loyalty/info',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const result = await LoyaltyService.getSettings(storeId);

      if (!result.loyaltyEnabled) {
        res.json({
          success: true,
          data: { enabled: false },
        });
        return;
      }

      // Return public-safe settings info
      res.json({
        success: true,
        data: {
          enabled: true,
          pointsPerMajorUnit: result.settings.pointsPerMajorUnit,
          signupBonus: result.settings.signupBonus,
          pointsValue: result.settings.pointsValue,
          minRedeemPoints: result.settings.minRedeemPoints,
          // The checkout's redemption estimate needs the same cap the server's
          // computeRedemption applies; without it the summary showed a lower
          // total than the order was created and charged at (#181).
          maxRedeemPercentage: result.settings.maxRedeemPercentage,
          tiers: result.settings.tiers,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/** Admin half — mount at the bare '/stores' prefix ONLY. */
export default router;

/** Customer half — the only loyalty routes safe to mount at '/public'. */
export { publicRouter as publicLoyaltyRoutes };
