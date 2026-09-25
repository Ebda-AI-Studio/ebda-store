import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, Prisma } from '@force/database';
import {
  CAMPAIGN_MAX_SCHEDULE_DAYS,
  CAMPAIGN_RECIPIENT_STATUSES,
  campaignAiDraftSchema,
  campaignDraftSchema,
  campaignSendSchema,
  isCampaignContentComplete,
  isCampaignSendable,
} from '@force/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { auditLog, writeLimiter } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { sanitizeNewsletterHtml } from '../lib/email-html-sanitizer';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { ResendService } from '../services/resend.service';
import { AIService } from '../services/ai.service';
import {
  CAMPAIGN_STORE_SELECT,
  buildCampaignAudience,
  campaignDailyCap,
  pickCampaignContent,
  renderCampaignEmail,
  sentInLast24h,
  type CampaignStoreContext,
} from '../services/campaign.service';

/**
 * Email campaigns — merchant admin API (D2). Mounted at
 * `/stores/:storeId/campaigns` with `tenantContext` (routes/index.ts).
 * Plan: docs/plans/2026-09-25-email-campaigns.md.
 *
 * Every route: authenticate → authorize(store_admin, super_admin) →
 * requireStoreAccess → requireFeature('email_campaigns'). The feature is in no
 * plan baseline, so for every store it is OFF until a super-admin enables it,
 * and while it is off every route here answers 403 FEATURE_DISABLED.
 *
 * The ONLY route that can cause subscriber email is `POST /:campaignId/send`.
 * `POST /:campaignId/test` mails the signed-in admin's own address and nobody
 * else.
 */
const router = Router({ mergeParams: true });

router.use(
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('email_campaigns')
);

const idParam = z.object({ campaignId: z.string().uuid() });

const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const recipientsQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(CAMPAIGN_RECIPIENT_STATUSES).optional(),
});

const CAMPAIGN_LIST_SELECT = {
  id: true,
  name: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  recipientCount: true,
  sentCount: true,
  failedCount: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CAMPAIGN_DETAIL_SELECT = {
  ...CAMPAIGN_LIST_SELECT,
  subject: true,
  subjectAr: true,
  bodyHtml: true,
  bodyHtmlAr: true,
  localeStrategy: true,
  audience: true,
} as const;

async function findCampaignOr404(storeId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, storeId },
    select: CAMPAIGN_DETAIL_SELECT,
  });
  if (!campaign) throw new AppError(404, 'NOT_FOUND', 'Campaign not found');
  return campaign;
}

/** Sanitize both bodies on write — the stored row never holds active content. */
function draftData(input: z.infer<typeof campaignDraftSchema>) {
  return {
    name: input.name,
    subject: input.subject,
    subjectAr: input.subjectAr?.trim() ? input.subjectAr.trim() : null,
    bodyHtml: sanitizeNewsletterHtml(input.bodyHtml),
    bodyHtmlAr: input.bodyHtmlAr?.trim() ? sanitizeNewsletterHtml(input.bodyHtmlAr) : null,
    localeStrategy: input.localeStrategy,
    audience: input.audience as Prisma.InputJsonValue,
  };
}

// GET /stores/:storeId/campaigns — newest first, cursor-paginated.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { cursor, limit } = listQuery.parse(req.query);
    const rows = await prisma.campaign.findMany({
      where: { storeId },
      select: CAMPAIGN_LIST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const campaigns = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      success: true,
      data: { campaigns, nextCursor: hasMore ? campaigns[campaigns.length - 1].id : null },
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/campaigns/audience — who a campaign would reach now.
router.get('/audience', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const [audience, sent24h] = await Promise.all([
      buildCampaignAudience(storeId),
      sentInLast24h(storeId),
    ]);
    const cap = campaignDailyCap();
    res.json({
      success: true,
      data: {
        count: audience.length,
        dailyCap: cap,
        sentLast24h: sent24h,
        remainingToday: Math.max(0, cap - sent24h),
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/campaigns — create a draft. Sends nothing.
router.post('/', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const input = campaignDraftSchema.parse(req.body);
    const campaign = await prisma.campaign.create({
      data: { storeId, ...draftData(input) },
      select: CAMPAIGN_DETAIL_SELECT,
    });
    await auditLog({
      action: 'campaign.created',
      userId: req.user?.userId,
      storeId,
      resourceType: 'campaign',
      resourceId: campaign.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ success: true, data: { campaign } });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/campaigns/ai-draft — Gemini writes subject + body in
// EN and AR from a short brief. Returns text only; persists nothing.
router.post('/ai-draft', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { brief } = campaignAiDraftSchema.parse(req.body);
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true, description: true, descriptionAr: true },
    });
    if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
    const result = await AIService.suggestCampaignDraft({
      storeId,
      brief,
      storeName: store.name,
      storeNameAr: store.nameAr,
      storeDescription: store.description,
      storeDescriptionAr: store.descriptionAr,
    });
    res.json({
      success: true,
      data: {
        ...result,
        suggestion: {
          ...result.suggestion,
          bodyHtml: sanitizeNewsletterHtml(result.suggestion.bodyHtml),
          bodyHtmlAr: sanitizeNewsletterHtml(result.suggestion.bodyHtmlAr),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/campaigns/:campaignId — detail + live status counts.
router.get('/:campaignId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { campaignId } = idParam.parse(req.params);
    const campaign = await findCampaignOr404(storeId, campaignId);
    const groups = await prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId, storeId },
      _count: { _all: true },
    });
    const statusCounts = Object.fromEntries(
      CAMPAIGN_RECIPIENT_STATUSES.map(s => [s, groups.find(g => g.status === s)?._count._all ?? 0])
    );
    res.json({ success: true, data: { campaign, statusCounts } });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/campaigns/:campaignId/recipients — per-recipient status.
router.get('/:campaignId/recipients', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { campaignId } = idParam.parse(req.params);
    const { cursor, limit, status } = recipientsQuery.parse(req.query);
    await findCampaignOr404(storeId, campaignId);
    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId, storeId, ...(status ? { status } : {}) },
      select: {
        id: true,
        email: true,
        locale: true,
        status: true,
        error: true,
        sentAt: true,
        unsubscribedAt: true,
        customerId: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const recipients = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      success: true,
      data: { recipients, nextCursor: hasMore ? recipients[recipients.length - 1].id : null },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /stores/:storeId/campaigns/:campaignId — edit, drafts only.
router.put(
  '/:campaignId',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const input = campaignDraftSchema.parse(req.body);
      const updated = await prisma.campaign.updateMany({
        where: { id: campaignId, storeId, status: 'draft' },
        data: draftData(input),
      });
      if (updated.count === 0) {
        await findCampaignOr404(storeId, campaignId);
        throw new AppError(409, 'CAMPAIGN_NOT_EDITABLE', 'Only a draft campaign can be edited');
      }
      const campaign = await findCampaignOr404(storeId, campaignId);
      res.json({ success: true, data: { campaign } });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/campaigns/:campaignId — draft, cancelled or failed
// only. A sent or in-flight campaign is send history and stays.
router.delete(
  '/:campaignId',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const deleted = await prisma.campaign.deleteMany({
        where: { id: campaignId, storeId, status: { in: ['draft', 'cancelled', 'failed'] } },
      });
      if (deleted.count === 0) {
        await findCampaignOr404(storeId, campaignId);
        throw new AppError(
          409,
          'CAMPAIGN_NOT_DELETABLE',
          'Only a draft, cancelled or failed campaign can be deleted'
        );
      }
      await auditLog({
        action: 'campaign.deleted',
        userId: req.user?.userId,
        storeId,
        resourceType: 'campaign',
        resourceId: campaignId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/campaigns/:campaignId/test — send the campaign to the
// signed-in admin's OWN email (both languages when both are complete). The
// recipient address comes from the session user, never from the request body.
router.post(
  '/:campaignId/test',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const campaign = await findCampaignOr404(storeId, campaignId);
      if (!isCampaignSendable(campaign)) {
        throw new AppError(
          422,
          'CAMPAIGN_INCOMPLETE',
          'Add a subject and a body in at least one language first'
        );
      }
      const [user, store] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user!.userId }, select: { email: true } }),
        prisma.store.findUnique({ where: { id: storeId }, select: CAMPAIGN_STORE_SELECT }),
      ]);
      if (!user?.email) throw new AppError(422, 'NO_ADMIN_EMAIL', 'Your account has no email');
      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

      const locales = (['en', 'ar'] as const).filter(l => isCampaignContentComplete(campaign, l));
      for (const locale of locales) {
        const content = pickCampaignContent(campaign, locale);
        const { subject, html } = renderCampaignEmail({
          store: store as CampaignStoreContext,
          locale: content.locale,
          subject: `[TEST] ${content.subject}`,
          bodyHtml: content.bodyHtml,
          unsubscribeUrl: null,
        });
        await ResendService.sendMarketingEmail(store as CampaignStoreContext, {
          to: user.email,
          subject,
          html,
        });
      }
      res.json({ success: true, data: { sentTo: user.email, locales } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/campaigns/:campaignId/send — THE merchant action that
// sends. `scheduledAt` absent = now. Flips draft → scheduled and enqueues the
// Inngest job; the job does all sending.
router.post(
  '/:campaignId/send',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const body = campaignSendSchema.parse(req.body ?? {});
      const campaign = await findCampaignOr404(storeId, campaignId);
      if (campaign.status !== 'draft') {
        throw new AppError(409, 'CAMPAIGN_NOT_DRAFT', 'This campaign has already been sent');
      }
      if (!isCampaignSendable(campaign)) {
        throw new AppError(
          422,
          'CAMPAIGN_INCOMPLETE',
          'Add a subject and a body in at least one language first'
        );
      }

      const now = Date.now();
      let scheduledAt = new Date(now);
      if (body.scheduledAt) {
        scheduledAt = new Date(body.scheduledAt);
        const maxAhead = CAMPAIGN_MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000;
        if (scheduledAt.getTime() <= now || scheduledAt.getTime() - now > maxAhead) {
          throw new AppError(
            422,
            'INVALID_SCHEDULE',
            `Schedule must be in the future and within ${CAMPAIGN_MAX_SCHEDULE_DAYS} days`
          );
        }
      }

      const [audience, sent24h] = await Promise.all([
        buildCampaignAudience(storeId),
        sentInLast24h(storeId),
      ]);
      if (audience.length === 0) {
        throw new AppError(422, 'EMPTY_AUDIENCE', 'No subscribers have opted in yet');
      }
      const remaining = Math.max(0, campaignDailyCap() - sent24h);
      // Checked here for immediate feedback on a send-now; the job re-checks
      // at send time, which is what governs a scheduled campaign.
      if (!body.scheduledAt && audience.length > remaining) {
        throw new AppError(
          422,
          'DAILY_CAP_EXCEEDED',
          `This campaign would reach ${audience.length} people but only ${remaining} more can be sent in the next 24 hours`
        );
      }

      const flipped = await prisma.campaign.updateMany({
        where: { id: campaignId, storeId, status: 'draft' },
        data: { status: 'scheduled', scheduledAt, recipientCount: audience.length },
      });
      if (flipped.count === 0) {
        throw new AppError(409, 'CAMPAIGN_NOT_DRAFT', 'This campaign has already been sent');
      }

      // Queue-then-send fails fast. If the enqueue throws we answer 503, and
      // a 5xx ROLLS BACK this request's transaction (request-transaction.ts),
      // so the flip above is undone: the campaign is back to `draft`, never
      // `scheduled` with no job behind it (Ruling EC-3).
      try {
        await inngest.send({
          name: 'campaign/send-requested',
          data: { campaignId, storeId, scheduledAt: scheduledAt.toISOString() },
        });
      } catch (err) {
        logger.error(
          { campaignId, storeId, err: err instanceof Error ? err.message : 'unknown' },
          '[CAMPAIGN] enqueue failed'
        );
        res.status(503).json({
          success: false,
          error: {
            code: 'CAMPAIGN_QUEUE_UNREACHABLE',
            message: 'Could not queue the campaign right now. Nothing was sent. Try again.',
          },
        });
        return;
      }

      await auditLog({
        action: 'campaign.send_requested',
        userId: req.user?.userId,
        storeId,
        resourceType: 'campaign',
        resourceId: campaignId,
        details: { audience: audience.length, scheduledAt: scheduledAt.toISOString() },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(202).json({
        success: true,
        data: { status: 'scheduled', scheduledAt, audience: audience.length },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/campaigns/:campaignId/cancel — stops a scheduled
// campaign before it starts, or a sending one before its next batch.
router.post(
  '/:campaignId/cancel',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const cancelled = await prisma.campaign.updateMany({
        where: { id: campaignId, storeId, status: { in: ['scheduled', 'sending'] } },
        data: { status: 'cancelled' },
      });
      if (cancelled.count === 0) {
        await findCampaignOr404(storeId, campaignId);
        throw new AppError(
          409,
          'CAMPAIGN_NOT_CANCELLABLE',
          'Only a scheduled or sending campaign can be cancelled'
        );
      }
      await auditLog({
        action: 'campaign.cancelled',
        userId: req.user?.userId,
        storeId,
        resourceType: 'campaign',
        resourceId: campaignId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { status: 'cancelled' } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
