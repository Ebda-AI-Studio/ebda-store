import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { affiliateService } from '../services/affiliate.service';
import { listAffiliateEvents } from '../services/affiliate-event.service';
import { prisma } from '@force/database';

const router = Router();

// ==========================================
// Validation Schemas
// ==========================================

const applySchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  instagram: z.string().max(100).optional(),
  tiktok: z.string().max(100).optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  instagram: z.string().max(100).optional(),
  tiktok: z.string().max(100).optional(),
  commissionRate: z.number().min(0).max(100).optional(),
  notes: z.string().max(1000).optional(),
});

const updateSchema = z.object({
  commissionRate: z.number().min(0).max(100).optional(),
  notes: z.string().max(1000).optional(),
});

const configSchema = z.object({
  defaultCommissionRate: z.number().min(0).max(100).optional(),
  cookieDurationDays: z.number().int().min(1).max(365).optional(),
  minPayoutAmount: z.number().int().min(0).optional(),
  autoApprove: z.boolean().optional(),
  publicSignupEnabled: z.boolean().optional(),
});

const payoutSchema = z.object({
  amount: z.number().int().positive(),
  method: z.string().max(50).optional(),
  notes: z.string().max(1000).optional(),
});

const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .transform(s => (s ? parseInt(s, 10) : undefined)),
  limit: z
    .string()
    .optional()
    .transform(s => (s ? parseInt(s, 10) : undefined)),
});

// ==========================================
// Admin middleware shorthand
// ==========================================

const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('affiliate'),
];

// ==========================================
// Config routes
// ==========================================

// GET /stores/:storeId/affiliates/config
router.get(
  '/:storeId/affiliates/config',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await affiliateService.getConfig(req.params.storeId);
      res.json({ success: true, data: { config } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/affiliates/config
router.put(
  '/:storeId/affiliates/config',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = configSchema.parse(req.body);
      const config = await affiliateService.upsertConfig(req.params.storeId, data);
      res.json({ success: true, data: { config } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Stats
// ==========================================

// GET /stores/:storeId/affiliates/stats
router.get(
  '/:storeId/affiliates/stats',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await affiliateService.getStats(req.params.storeId);
      res.json({ success: true, data: { stats } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Affiliate CRUD
// ==========================================

// GET /stores/:storeId/affiliates
router.get(
  '/:storeId/affiliates',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit } = paginationSchema.parse(req.query);
      const { status } = req.query;

      const result = await affiliateService.list(storeId, {
        page,
        limit,
        status: status as string | undefined,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/affiliates/:id
router.get(
  '/:storeId/affiliates/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const affiliate = await affiliateService.getById(req.params.storeId, req.params.id);
      res.json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/affiliates (admin invite)
router.post(
  '/:storeId/affiliates',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createSchema.parse(req.body);
      const affiliate = await affiliateService.create(req.params.storeId, data);
      res.status(201).json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/affiliates/:id
router.put(
  '/:storeId/affiliates/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateSchema.parse(req.body);
      const affiliate = await affiliateService.update(req.params.storeId, req.params.id, data);
      res.json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/affiliates/:id
router.delete(
  '/:storeId/affiliates/:id',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await affiliateService.delete(req.params.storeId, req.params.id);
      res.json({ success: true, data: { message: 'Affiliate deleted successfully' } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Status transitions
// ==========================================

// PATCH /stores/:storeId/affiliates/:id/approve
router.patch(
  '/:storeId/affiliates/:id/approve',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const affiliate = await affiliateService.approve(
        req.params.storeId,
        req.params.id,
        req.user!.userId
      );
      res.json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/affiliates/:id/reject
router.patch(
  '/:storeId/affiliates/:id/reject',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const affiliate = await affiliateService.reject(
        req.params.storeId,
        req.params.id,
        req.user!.userId
      );
      res.json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/affiliates/:id/suspend
router.patch(
  '/:storeId/affiliates/:id/suspend',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const affiliate = await affiliateService.suspend(
        req.params.storeId,
        req.params.id,
        req.user!.userId
      );
      res.json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Referrals per affiliate
// ==========================================

// GET /stores/:storeId/affiliates/:id/events - Combined timeline of referrals + payouts
router.get(
  '/:storeId/affiliates/:id/events',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id: affiliateId } = req.params;

      // Verify affiliate belongs to this store
      const affiliate = await affiliateService.getById(storeId, affiliateId);
      if (!affiliate) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Affiliate not found' },
        });
        return;
      }

      const [referrals, payouts] = await Promise.all([
        prisma.affiliateReferral.findMany({
          where: { storeId, affiliateId },
          include: { order: { select: { id: true, orderNumber: true, total: true } } },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        prisma.affiliatePayout.findMany({
          where: { storeId, affiliateId },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
      ]);

      // Normalise into a unified event shape
      interface AffiliateEvent {
        id: string;
        at: string;
        kind: string;
        details: Record<string, any>;
      }

      const events: AffiliateEvent[] = [];

      for (const r of referrals) {
        const kind = r.status === 'converted' ? 'referral.converted' : 'referral.clicked';
        events.push({
          id: `ref-${r.id}`,
          at: (r.convertedAt ?? r.createdAt).toISOString(),
          kind,
          details: {
            referralCode: r.referralCode,
            orderId: r.orderId,
            orderNumber: r.order?.orderNumber,
            orderTotal: r.order?.total ? Number(r.order.total) : undefined,
            commissionAmount: r.commissionAmount ?? undefined,
            status: r.status,
          },
        });
      }

      for (const p of payouts) {
        const kind =
          p.status === 'completed'
            ? 'payout.completed'
            : p.status === 'pending'
              ? 'payout.initiated'
              : `payout.${p.status}`;
        events.push({
          id: `payout-${p.id}`,
          at: (p.paidAt ?? p.createdAt).toISOString(),
          kind,
          details: {
            amount: p.amount,
            method: p.method,
            status: p.status,
            notes: p.notes,
          },
        });
      }

      events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

      res.json({ success: true, data: { events, affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/affiliates/:id/referrals
router.get(
  '/:storeId/affiliates/:id/referrals',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit } = paginationSchema.parse(req.query);
      const result = await affiliateService.getReferrals(req.params.storeId, req.params.id, {
        page,
        limit,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Payouts per affiliate
// ==========================================

// GET /stores/:storeId/affiliates/:id/payouts
router.get(
  '/:storeId/affiliates/:id/payouts',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit } = paginationSchema.parse(req.query);
      const result = await affiliateService.getPayouts(req.params.storeId, req.params.id, {
        page,
        limit,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/affiliates/:id/payouts
router.post(
  '/:storeId/affiliates/:id/payouts',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = payoutSchema.parse(req.body);
      const payout = await affiliateService.createPayout(req.params.storeId, req.params.id, data);
      res.status(201).json({ success: true, data: { payout } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Event history — actual affiliate_events table (append-only audit trail)
// GET /stores/:storeId/affiliates/:id/audit-trail
// Distinct path from /events (which returns combined referrals+payouts view)
// so both routes can be served without one shadowing the other.
// ==========================================

router.get(
  '/:storeId/affiliates/:id/audit-trail',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Verify the affiliate exists and belongs to this store before returning events.
      await affiliateService.getById(req.params.storeId, req.params.id);

      const events = await listAffiliateEvents(req.params.id, req.params.storeId);
      res.json({ success: true, data: { events } });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// Public routes
// ==========================================

// POST /public/:storeId/affiliates/apply
router.post(
  '/:storeId/affiliates/apply',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = applySchema.parse(req.body);
      const affiliate = await affiliateService.apply(req.params.storeId, data);
      res.status(201).json({ success: true, data: { affiliate } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /public/:storeId/affiliates/track?ref=CODE
router.get(
  '/:storeId/affiliates/track',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { ref } = req.query;

      if (!ref || typeof ref !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_REF', message: 'Referral code (ref) is required' },
        });
        return;
      }

      // Use session id from cookie or generate a transient one
      const sessionId =
        (req as any).sessionId ||
        req.cookies?.sessionId ||
        `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const result = await affiliateService.registerClick(storeId, ref, sessionId);

      res.json({
        success: true,
        data: {
          referralCode: ref,
          cookieExpiresAt: result.cookieExpiresAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
