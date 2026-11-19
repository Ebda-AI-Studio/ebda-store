import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma, runInTenantContext } from '@ebda/database';
import {
  CAMPAIGN_RECIPIENT_STATUSES,
  campaignAiDraftSchema,
  campaignDraftSchema,
  campaignSendSchema,
  isCampaignContentComplete,
  isCampaignSendable,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { auditLog, writeLimiter } from '../middleware/security';
import { storeScopeContext } from '../middleware/tenant-context';
import { AppError } from '../middleware/error-handler';
import { storeDb, storeRepo, storeWriter } from '../lib/repo-factory';
import { sanitizeNewsletterHtml } from '../lib/email-html-sanitizer';
import { StoreMailer } from '../services/store-mailer.service';
import { storeHidesPoweredBy } from '../services/email.service';
import { AIService } from '../services/ai.service';
import { requireAiEnabled } from '../lib/store-ai-switch';
import {
  CAMPAIGN_LIST_SELECT,
  CAMPAIGN_STORE_SELECT,
  CampaignQueueUnreachable,
  audienceCount,
  cancelCampaign,
  createCampaignDraft,
  draftData,
  findCampaignOr404,
  requestCampaignSend,
  storeCampaignDailyCap,
  pickCampaignContent,
  renderCampaignEmail,
  sentInLast24h,
  type CampaignStoreContext,
} from '../services/campaign.service';

/**
 * Email campaigns — merchant admin API (D2). Mounted at
 * `/stores/:storeId/campaigns` with `tenantContext` (routes/index.ts).
 * Plan: docs/plans/done/2026-09-25-email-campaigns.md.
 *
 * Every route: authenticate → authorize(store_admin, super_admin) →
 * requireStoreAccess → requireFeature('email_campaigns'). The feature is in the
 * Growth + Business baselines (not Basic), so on a Basic store it is OFF until
 * the store upgrades or a super-admin enables it, and while it is off every
 * route here answers 403 FEATURE_DISABLED.
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

// GET /stores/:storeId/campaigns — newest first, cursor-paginated.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { cursor, limit } = listQuery.parse(req.query);
    const rows = await (
      await storeDb(storeId)
    ).campaign.findMany({
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
    // #1953: count-only — this route never used the actual rows.
    const [count, sent24h, cap] = await Promise.all([
      audienceCount(storeId),
      sentInLast24h(storeId),
      storeCampaignDailyCap(storeId),
    ]);
    res.json({
      success: true,
      data: {
        count,
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
    const campaign = await createCampaignDraft(storeId, input);
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

// POST /stores/:storeId/campaigns/ai-draft — moved to `campaignAiDraftRouter`
// below (EBDA-API-2G): it awaits Gemini and must not hold the request
// transaction (30s expiry) open while it does.

// GET /stores/:storeId/campaigns/:campaignId — detail + live status counts.
router.get('/:campaignId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { campaignId } = idParam.parse(req.params);
    const campaign = await findCampaignOr404(storeId, campaignId);
    const groups = await (
      await storeDb(storeId)
    ).campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId, storeId },
      _count: { _all: true },
    });
    const statusCounts = Object.fromEntries(
      CAMPAIGN_RECIPIENT_STATUSES.map(s => [s, groups.find(g => g.status === s)?._count._all ?? 0])
    );
    // The exact predicate DELETE refuses on (`sentAt` set on any recipient) —
    // a bounced/unsubscribed row can carry it too, so no status count stands in
    // for it. Lets the admin hide a Delete that can only 409 (issue 2082).
    const hasSendHistory =
      (await (
        await storeDb(storeId)
      ).campaignRecipient.findFirst({
        where: { campaignId, storeId, sentAt: { not: null } },
        select: { id: true },
      })) !== null;
    res.json({ success: true, data: { campaign, statusCounts, hasSendHistory } });
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
    const rows = await (
      await storeDb(storeId)
    ).campaignRecipient.findMany({
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
      const updated = await (
        await storeWriter(storeId)
      ).campaign.updateMany({
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
// only, AND only when it never actually sent any mail. A cancelled or failed
// campaign can still have `sent` recipient rows from before it stopped
// (#1951): `campaign_recipients.campaign_id` cascades on delete, so deleting
// such a campaign would destroy the only record that mail went out AND
// silently shrink `sentInLast24h` (campaign.service.ts), the platform-wide
// rolling send-reputation cap — letting a merchant re-open cap headroom by
// deleting, rather than waiting out, a campaign that already spent it. The
// `recipients: { none: { sentAt: { not: null } } }` clause makes this atomic
// (a single DELETE ... WHERE ... NOT EXISTS) rather than a check-then-delete
// that could race a still-draining send.
router.delete(
  '/:campaignId',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const deleted = await (
        await storeWriter(storeId)
      ).campaign.deleteMany({
        where: {
          id: campaignId,
          storeId,
          status: { in: ['draft', 'cancelled', 'failed'] },
          recipients: { none: { sentAt: { not: null } } },
        },
      });
      if (deleted.count === 0) {
        const campaign = await findCampaignOr404(storeId, campaignId);
        if (!(['draft', 'cancelled', 'failed'] as string[]).includes(campaign.status)) {
          throw new AppError(
            409,
            'CAMPAIGN_NOT_DELETABLE',
            'Only a draft, cancelled or failed campaign can be deleted'
          );
        }
        throw new AppError(
          409,
          'CAMPAIGN_HAS_SEND_HISTORY',
          'A campaign that already sent mail is send history and cannot be deleted'
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

// POST /stores/:storeId/campaigns/:campaignId/test — moved to
// `campaignTestSendRouter` below (#1954): it makes external Resend calls and
// must not hold the request transaction open while it does.

router.post(
  '/:campaignId/send',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const body = campaignSendSchema.parse(req.body ?? {});
      let sent;
      try {
        sent = await requestCampaignSend(storeId, campaignId, body.scheduledAt);
      } catch (err) {
        if (!(err instanceof CampaignQueueUnreachable)) throw err;
        res.status(503).json({
          success: false,
          error: {
            code: 'CAMPAIGN_QUEUE_UNREACHABLE',
            message: 'Could not queue the campaign right now. Nothing was sent. Try again.',
          },
        });
        return;
      }
      const { audience: audienceSize, scheduledAt } = sent;

      await auditLog({
        action: 'campaign.send_requested',
        userId: req.user?.userId,
        storeId,
        resourceType: 'campaign',
        resourceId: campaignId,
        details: { audience: audienceSize, scheduledAt: scheduledAt.toISOString() },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(202).json({
        success: true,
        data: { status: 'scheduled', scheduledAt, audience: audienceSize },
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
      await cancelCampaign(storeId, campaignId);
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

/**
 * POST /stores/:storeId/campaigns/:campaignId/test — send the campaign to the
 * signed-in admin's OWN email (both languages when both are complete). The
 * recipient address comes from the session user, never from the request body.
 *
 * This router is mounted WITHOUT `tenantContext` (routes/index.ts, #1954): the
 * route awaits up to two Resend HTTP calls, and inside the per-request
 * interactive transaction those held a pooled Postgres connection open across
 * a third-party round-trip (a hung Resend → a 30s transaction timeout 500).
 * So the three reads run in their own short `runInTenantContext` transaction,
 * which COMMITS before the first send; the sends then run with no
 * transaction open — which also requires the mount to sit ABOVE the
 * prefix-capturing `/stores/:storeId` mount, or the request arrives already
 * inside the per-request transaction (see the mount comment in routes/index.ts).
 * The response is still only sent after every send
 * returned, so `{ sentTo, locales }` remains an honest report of what Resend
 * accepted, and a failed send still surfaces as the error the merchant sees.
 *
 * It carries the SAME chain every campaign route has (authenticate →
 * authorize → requireStoreAccess → requireFeature('email_campaigns')) on the
 * route itself, so it adds nothing to any other `/campaigns` request that
 * passes through this router on its way to the tenant-scoped one.
 */
export const campaignTestSendRouter = Router({ mergeParams: true });

campaignTestSendRouter.post(
  '/:campaignId/test',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('email_campaigns'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { campaignId } = idParam.parse(req.params);
      const userId = req.user!.userId;
      const repo = await storeRepo(storeId);
      // A store on its Durable Object (NEON-ZERO): no Postgres transaction; the store is the split record on the DO read client
      // and the admin's address is the session's (merchants sign in at the identity service, Ruling ID-1: no Store `users` row).
      const { campaign, user, store } =
        repo.backend === 'do'
          ? {
              campaign: await findCampaignOr404(storeId, campaignId),
              user: { email: req.user!.email },
              store: await repo.db.store.findUnique({
                where: { id: storeId },
                select: CAMPAIGN_STORE_SELECT,
              }),
            }
          : await runInTenantContext(
              storeId,
              async () => {
                const found = await findCampaignOr404(storeId, campaignId);
                const [u, s] = await Promise.all([
                  prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
                  prisma.store.findUnique({
                    where: { id: storeId },
                    select: CAMPAIGN_STORE_SELECT,
                  }),
                ]);
                return { campaign: found, user: u, store: s };
              },
              userId
            );
      if (!isCampaignSendable(campaign)) {
        throw new AppError(
          422,
          'CAMPAIGN_INCOMPLETE',
          'Add a subject and a body in at least one language first'
        );
      }
      if (!user?.email) throw new AppError(422, 'NO_ADMIN_EMAIL', 'Your account has no email');
      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

      // No transaction is open past this point.
      const locales = (['en', 'ar'] as const).filter(l => isCampaignContentComplete(campaign, l));
      const hidePoweredBy = await storeHidesPoweredBy(store.id);
      for (const locale of locales) {
        const content = pickCampaignContent(campaign, locale);
        const { subject, html } = renderCampaignEmail({
          store: store as CampaignStoreContext,
          locale: content.locale,
          subject: `[TEST] ${content.subject}`,
          bodyHtml: content.bodyHtml,
          unsubscribeUrl: null,
          hidePoweredBy,
        });
        await StoreMailer.sendMarketingEmail(store as CampaignStoreContext, {
          toMerchant: true,
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

/**
 * `POST /:storeId/campaigns/ai-draft` — Gemini writes a draft from a brief.
 *
 * Mounted WITHOUT `tenantContext` for the reason #1954 gave the test send: a
 * slow third-party call inside the per-request interactive transaction. Prisma
 * expires that transaction 30s after BEGIN, and a Gemini call that ran long
 * made `recordUsage`'s `aiUsage.create` and the COMMIT fail on an expired
 * transaction (EBDA-API-2G, 66772ms against a 30000ms timeout). Here every
 * query runs in its own short tenant transaction (`storeScopeContext`), so
 * nothing is held open across the model call — but ONLY if no earlier mount
 * already opened one: the prisma proxy prefers an open transaction over a
 * store scope, so this router must stay above the prefix-capturing
 * `/stores/:storeId` mount (see the mount comment in routes/index.ts).
 *
 * Same chain as every campaign route (authenticate → authorize →
 * requireStoreAccess → requireFeature('email_campaigns')) on the route itself,
 * so it adds nothing to any other `/campaigns` request passing through.
 */
export const campaignAiDraftRouter = Router({ mergeParams: true });

// POST /stores/:storeId/campaigns/ai-draft — Gemini writes subject + body in
// EN and AR from a short brief. Returns text only; persists nothing.
campaignAiDraftRouter.post(
  '/ai-draft',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('email_campaigns'),
  requireAiEnabled,
  storeScopeContext,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
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
  }
);
