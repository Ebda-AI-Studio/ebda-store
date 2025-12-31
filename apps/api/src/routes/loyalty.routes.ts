import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { LoyaltyService } from '../services/loyalty.service';
import { LoyaltyTransactionType } from '@force/database';

const router = Router();

// Validation schemas
const tierSchema = z.object({
  minPoints: z.number(),
  multiplier: z.number(),
});

const updateSettingsSchema = z.object({
  loyaltyEnabled: z.boolean().optional(),
  settings: z.object({
    pointsPerDinar: z.number().min(1).max(100).optional(),
    signupBonus: z.number().min(0).optional(),
    referralBonus: z.number().min(0).optional(),
    reviewBonus: z.number().min(0).optional(),
    birthdayBonus: z.number().min(0).optional(),
    tiers: z.object({
      bronze: tierSchema,
      silver: tierSchema,
      gold: tierSchema,
      platinum: tierSchema,
    }).optional(),
    pointsValue: z.number().min(1).optional(),
    minRedeemPoints: z.number().min(0).optional(),
    maxRedeemPercentage: z.number().min(0).max(100).optional(),
    expirationMonths: z.number().min(0).optional(),
  }).optional(),
});

const awardPointsSchema = z.object({
  points: z.number().int(),
  type: z.enum([
    'earn_manual',
    'earn_referral',
    'earn_review',
    'earn_birthday',
    'adjust',
  ] as const),
  description: z.string().optional(),
});

// ==========================================
// Admin Routes
// ==========================================

// GET /stores/:storeId/loyalty/settings - Get loyalty settings
router.get('/:storeId/loyalty/settings', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
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
});

// PUT /stores/:storeId/loyalty/settings - Update loyalty settings
router.put('/:storeId/loyalty/settings', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
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
});

// GET /stores/:storeId/loyalty/stats - Get loyalty program statistics
router.get('/:storeId/loyalty/stats', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
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
});

// GET /stores/:storeId/loyalty/members - List loyalty members
router.get('/:storeId/loyalty/members', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
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
});

// GET /stores/:storeId/loyalty/members/:customerId - Get customer points
router.get('/:storeId/loyalty/members/:customerId', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, customerId } = req.params;
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
});

// GET /stores/:storeId/loyalty/members/:customerId/transactions - Get customer transactions
router.get('/:storeId/loyalty/members/:customerId/transactions', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
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
});

// POST /stores/:storeId/loyalty/members/:customerId/award - Award bonus points
router.post('/:storeId/loyalty/members/:customerId/award', authenticate, authorize('store_admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
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
});

// ==========================================
// Public/Customer Routes
// ==========================================

// GET /public/:storeId/loyalty/my-points - Get own points (authenticated customer)
router.get('/public/:storeId/loyalty/my-points', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const customerId = (req as any).user.id;

    const points = await LoyaltyService.getCustomerPoints(storeId, customerId);

    res.json({
      success: true,
      data: { points },
    });
  } catch (error) {
    next(error);
  }
});

// GET /public/:storeId/loyalty/my-transactions - Get own transaction history
router.get('/public/:storeId/loyalty/my-transactions', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const customerId = (req as any).user.id;
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
});

// POST /public/:storeId/loyalty/join - Join loyalty program
router.post('/public/:storeId/loyalty/join', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const customerId = (req as any).user.id;

    const points = await LoyaltyService.initializeCustomerPoints(storeId, customerId, true);

    res.status(201).json({
      success: true,
      data: { points },
    });
  } catch (error) {
    next(error);
  }
});

// GET /public/:storeId/loyalty/info - Get loyalty program info (public)
router.get('/public/:storeId/loyalty/info', async (req: Request, res: Response, next: NextFunction) => {
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
        pointsPerDinar: result.settings.pointsPerDinar,
        signupBonus: result.settings.signupBonus,
        pointsValue: result.settings.pointsValue,
        minRedeemPoints: result.settings.minRedeemPoints,
        tiers: result.settings.tiers,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
