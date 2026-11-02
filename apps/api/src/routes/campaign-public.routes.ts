import { Router, Request, Response, NextFunction } from 'express';
import { runInTenantContext, withStore } from '@ebda/database';
import { storeRepo } from '../lib/repo-factory';
import { inCampaignStore } from '../services/campaign.service';
import { publicLimiter } from '../middleware/security';
import {
  verifyUnsubscribeToken,
  verifySubscriberUnsubscribeToken,
} from '../lib/campaign-unsubscribe-token';
import logger from '../lib/logger';

/**
 * Public, login-free campaign unsubscribe (D2). Mounted at
 * `/public/campaigns` (routes/index.ts). `/public/` paths skip CSRF.
 *
 *   GET  /public/campaigns/unsubscribe?token=…  → validates only. Link
 *        scanners and mail-client previews prefetch GETs, so a GET must never
 *        unsubscribe anyone.
 *   POST /public/campaigns/unsubscribe?token=…  → performs it. This is also
 *        the RFC 8058 one-click target in the `List-Unsubscribe` header: the
 *        mailbox provider POSTs `List-Unsubscribe=One-Click` as a form body,
 *        with the token in the URL. The storefront page POSTs the same.
 *
 * The token carries the store id under its signature, so all work runs in
 * `runInTenantContext(storeId)` — no RLS bypass. Deliberately NOT gated on the
 * `email_campaigns` feature: if a super-admin turns the feature off after a
 * campaign went out, its unsubscribe links must keep working.
 *
 * Rate-limited with the storefront `publicLimiter` rather than the 5/min
 * newsletter limiter: one-click POSTs arrive from the mailbox provider's own
 * servers, so a big campaign concentrates many legitimate requests on a few
 * IPs. The token is a 256-bit HMAC, so the limiter is not what stops guessing.
 */
const router = Router();

function tokenFrom(req: Request): unknown {
  const q = req.query.token;
  if (typeof q === 'string') return q;
  const b = (req.body as Record<string, unknown> | undefined)?.token;
  return typeof b === 'string' ? b : undefined;
}

/** `a***@example.com` — enough for a subscriber to recognise their address,
 *  not enough to hand a forwarded link's viewer the full address. */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Broadcast (non-campaign) unsubscribe — token names the subscriber row
 * (NEWSLETTER-UNSUB-1). Store-scoped: every query carries the store id from the
 * signed token, inside that store's tenant context.
 */
async function respondSubscriberInfo(
  res: Response,
  ids: { storeId: string; subscriberId: string }
): Promise<void> {
  // The list is the store's own (Ruling CF-R4-4): its Durable Object, or Postgres inside the tenant context as before.
  const repo = await storeRepo(ids.storeId);
  const read = async () => {
    const subscriber = await repo.db.newsletterSubscriber.findFirst({
      where: { id: ids.subscriberId, storeId: ids.storeId },
      select: { email: true, isActive: true },
    });
    if (!subscriber) return null;
    const store = await withStore(ids.storeId, tx =>
      tx.store.findUnique({ where: { id: ids.storeId }, select: { name: true, nameAr: true } })
    );
    return { subscriber, store };
  };
  const found = await (repo.backend === 'do' ? read() : runInTenantContext(ids.storeId, read));
  if (!found) {
    res.status(404).json({ success: false, error: { code: 'INVALID_TOKEN' } });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    data: {
      email: maskEmail(found.subscriber.email),
      storeName: found.store?.name ?? null,
      storeNameAr: found.store?.nameAr ?? null,
      alreadyUnsubscribed: !found.subscriber.isActive,
    },
  });
}

/** Idempotent: an already-unsubscribed subscriber answers the same success. */
async function unsubscribeSubscriber(
  res: Response,
  ids: { storeId: string; subscriberId: string }
): Promise<void> {
  const repo = await storeRepo(ids.storeId);
  const write = async () => {
    const subscriber = await repo.db.newsletterSubscriber.findFirst({
      where: { id: ids.subscriberId, storeId: ids.storeId },
      select: { id: true },
    });
    if (!subscriber) return false;
    await repo.writer.newsletterSubscriber.updateMany({
      where: { id: ids.subscriberId, storeId: ids.storeId, isActive: true },
      data: { isActive: false, unsubscribedAt: new Date() },
    });
    return true;
  };
  const exists = await (repo.backend === 'do' ? write() : runInTenantContext(ids.storeId, write));
  if (!exists) {
    res.status(404).json({ success: false, error: { code: 'INVALID_TOKEN' } });
    return;
  }
  logger.info(
    { storeId: ids.storeId, subscriberId: ids.subscriberId },
    '[NEWSLETTER] unsubscribed'
  );
  res.json({ success: true, data: { unsubscribed: true } });
}

router.get(
  '/unsubscribe',
  publicLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sub = verifySubscriberUnsubscribeToken(tokenFrom(req));
      if (sub) {
        await respondSubscriberInfo(res, sub);
        return;
      }
      const ids = verifyUnsubscribeToken(tokenFrom(req));
      if (!ids) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN' } });
        return;
      }
      const found = await inCampaignStore(ids.storeId, async db => {
        const recipient = await db.campaignRecipient.findFirst({
          where: { id: ids.recipientId, storeId: ids.storeId },
          select: { email: true, status: true },
        });
        if (!recipient) return null;
        const store = await withStore(ids.storeId, tx =>
          tx.store.findUnique({ where: { id: ids.storeId }, select: { name: true, nameAr: true } })
        );
        return { recipient, store };
      });
      if (!found) {
        res.status(404).json({ success: false, error: { code: 'INVALID_TOKEN' } });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: {
          email: maskEmail(found.recipient.email),
          storeName: found.store?.name ?? null,
          storeNameAr: found.store?.nameAr ?? null,
          alreadyUnsubscribed: found.recipient.status === 'unsubscribed',
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/unsubscribe',
  publicLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sub = verifySubscriberUnsubscribeToken(tokenFrom(req));
      if (sub) {
        await unsubscribeSubscriber(res, sub);
        return;
      }
      const ids = verifyUnsubscribeToken(tokenFrom(req));
      if (!ids) {
        res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN' } });
        return;
      }
      const done = await inCampaignStore(ids.storeId, async (db, w) => {
        const recipient = await db.campaignRecipient.findFirst({
          where: { id: ids.recipientId, storeId: ids.storeId },
          select: { id: true, email: true, subscriberId: true },
        });
        if (!recipient) return false;
        const now = new Date();
        // Withdraw consent on the subscriber row — by id when linked, and by
        // (store, email) so a re-created row for the same address is covered.
        await w.newsletterSubscriber.updateMany({
          where: {
            storeId: ids.storeId,
            OR: [
              ...(recipient.subscriberId ? [{ id: recipient.subscriberId }] : []),
              { email: recipient.email },
            ],
            isActive: true,
          },
          data: { isActive: false, unsubscribedAt: now },
        });
        // Record it against the campaign that carried the link.
        await w.campaignRecipient.updateMany({
          where: { id: recipient.id, storeId: ids.storeId, status: { not: 'unsubscribed' } },
          data: { status: 'unsubscribed', unsubscribedAt: now },
        });
        return true;
      });
      if (!done) {
        res.status(404).json({ success: false, error: { code: 'INVALID_TOKEN' } });
        return;
      }
      logger.info(
        { storeId: ids.storeId, recipientId: ids.recipientId },
        '[CAMPAIGN] unsubscribed'
      );
      res.json({ success: true, data: { unsubscribed: true } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
