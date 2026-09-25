import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import { config } from '../../../config';
import logger from '../../logger';
import { inngest } from '../client';
import { chunk } from '../batch-utils';
import { signUnsubscribeToken } from '../../campaign-unsubscribe-token';
import { ResendService, ResendSendError } from '../../../services/resend.service';
import {
  CAMPAIGN_STORE_SELECT,
  buildCampaignAudience,
  campaignDailyCap,
  campaignThrottleMs,
  listUnsubscribeHeaders,
  pickCampaignContent,
  renderCampaignEmail,
  resolveRecipientLocale,
  sentInLast24h,
  storeDefaultLanguage,
  storefrontBaseUrl,
  type CampaignStoreContext,
} from '../../../services/campaign.service';

/**
 * Email campaign sender (D2). Plan: docs/plans/2026-09-25-email-campaigns.md.
 *
 * Triggered ONLY by `campaign/send-requested`, which only
 * `POST /stores/:storeId/campaigns/:id/send` emits — a merchant pressing send
 * on a store where `email_campaigns` is on. No cron, no migration and no other
 * event reaches this function.
 *
 * Invariants:
 *  - One email per recipient, one address per email.
 *  - Idempotent under retry: materialize is `createMany … skipDuplicates` on
 *    UNIQUE(campaign_id, email); a batch skips any recipient that is no longer
 *    `queued`; the Resend call carries `idempotencyKey = campaign-recipient/<id>`
 *    for the crash-between-send-and-mark window.
 *  - Throttled by sleeping CAMPAIGN_SEND_THROTTLE_MS after each SUCCESSFUL
 *    send. A 429 is not the throttle — it throws, and the step retries.
 *  - Capped: a campaign whose audience exceeds the store's remaining rolling
 *    24h allowance fails as DAILY_CAP_EXCEEDED before any recipient exists.
 *  - No orphaned `queued` row: a failed send marks the recipient `failed`, a
 *    cancel marks the rest `failed`, and `onFailure` marks the rest `failed`
 *    if the whole job dies.
 *
 * `scheduledAt` in the event is the per-request nonce: the claim and the
 * failure handler only act on a campaign whose `scheduled_at` still equals
 * it, so an event from a send request that rolled back (or was superseded)
 * can neither send nor fail a newer request.
 */

export const CAMPAIGN_SEND_BATCH_SIZE = 20;
/** Longest error text stored on a recipient row (shown to the merchant). */
const ERROR_MAX = 300;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type SendEventData = { campaignId?: string; storeId?: string; scheduledAt?: string };

interface CampaignForSend {
  status: string;
  subject: string;
  subjectAr: string | null;
  bodyHtml: string;
  bodyHtmlAr: string | null;
  localeStrategy: string;
}

async function loadSendContext(
  storeId: string,
  campaignId: string
): Promise<{ campaign: CampaignForSend | null; store: CampaignStoreContext | null }> {
  return runInTenantContext(storeId, async () => {
    const [campaign, store] = await Promise.all([
      prisma.campaign.findFirst({
        where: { id: campaignId, storeId },
        select: {
          status: true,
          subject: true,
          subjectAr: true,
          bodyHtml: true,
          bodyHtmlAr: true,
          localeStrategy: true,
        },
      }),
      prisma.store.findUnique({ where: { id: storeId }, select: CAMPAIGN_STORE_SELECT }),
    ]);
    return { campaign, store: store as CampaignStoreContext | null };
  });
}

/** Every still-`queued` recipient of the campaign → failed(reason). */
async function failQueuedRecipients(storeId: string, campaignId: string, reason: string) {
  return runInTenantContext(storeId, () =>
    prisma.campaignRecipient.updateMany({
      where: { campaignId, storeId, status: 'queued' },
      data: { status: 'failed', error: reason },
    })
  );
}

interface BatchResult {
  sent: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
}

const campaignSendFn = inngest.createFunction(
  {
    id: 'campaign-send',
    name: 'Email campaign: send to consented newsletter subscribers',
    // One campaign sends at a time, platform-wide: every store shares one
    // Resend API key (2 req/s default, also carrying all transactional mail)
    // and, on the fallback sender, one sending domain's reputation.
    concurrency: { limit: 1 },
    retries: 4,
    triggers: [{ event: 'campaign/send-requested' }],
    onFailure: async ({ event }) => {
      const data = (event?.data?.event?.data ?? {}) as SendEventData;
      const { campaignId, storeId, scheduledAt } = data;
      if (!campaignId || !storeId || !scheduledAt) return;
      const updated = await runInTenantContext(storeId, () =>
        prisma.campaign.updateMany({
          where: {
            id: campaignId,
            storeId,
            status: { in: ['scheduled', 'sending'] },
            scheduledAt: new Date(scheduledAt),
          },
          data: { status: 'failed', lastError: 'SEND_JOB_FAILED' },
        })
      );
      if (updated.count > 0) {
        await failQueuedRecipients(storeId, campaignId, 'SEND_JOB_FAILED');
      }
      logger.error({ campaignId, storeId, marked: updated.count }, '[CAMPAIGN] send job failed');
    },
  },
  async ({ event, step }) => {
    const { campaignId, storeId, scheduledAt } = (event.data ?? {}) as SendEventData;
    if (!campaignId || !storeId || !scheduledAt) {
      logger.warn('[CAMPAIGN] campaign/send-requested fired without ids — skipping');
      return { skipped: 'missing-ids' };
    }
    const nonce = new Date(scheduledAt);

    // 1. Load. `draft` means the send request's transaction has not committed
    //    yet (the event is sent inside it) — throw so THIS step retries; a
    //    memoized draft result would otherwise be replayed on every retry.
    const initial = await step.run('load', async () => {
      const c = await runInTenantContext(storeId, () =>
        prisma.campaign.findFirst({
          where: { id: campaignId, storeId },
          select: { status: true, scheduledAt: true },
        })
      );
      if (c?.status === 'draft') {
        throw new Error('campaign is still draft: the send request has not committed yet');
      }
      return c ? { status: c.status as string, scheduledAt: c.scheduledAt?.toISOString() } : null;
    });
    if (!initial) return { skipped: 'campaign-missing' };
    if (initial.status !== 'scheduled' || initial.scheduledAt !== nonce.toISOString()) {
      return { skipped: `not-this-request:${initial.status}` };
    }

    // 2. Wait for a future schedule (durable — survives deploys).
    if (nonce.getTime() > Date.now()) {
      await step.sleepUntil('wait-for-schedule', nonce);
    }

    // 3. Claim scheduled → sending, atomically and only for this request.
    //    A cancel during the wait leaves it `cancelled` and nothing is sent.
    const claimed = await step.run('claim', () =>
      runInTenantContext(storeId, async () => {
        const r = await prisma.campaign.updateMany({
          where: { id: campaignId, storeId, status: 'scheduled', scheduledAt: nonce },
          data: { status: 'sending' },
        });
        return r.count === 1;
      })
    );
    if (!claimed) return { skipped: 'not-claimed' };

    // 4. Materialize recipients (consent-filtered audience, cap check).
    const materialized = await step.run('materialize', async () => {
      const { campaign, store } = await loadSendContext(storeId, campaignId);
      if (!campaign || !store) return { aborted: 'CAMPAIGN_OR_STORE_MISSING' as const };

      const audience = await runInTenantContext(storeId, () => buildCampaignAudience(storeId));
      const alreadySent = await runInTenantContext(storeId, () => sentInLast24h(storeId));
      const remaining = Math.max(0, campaignDailyCap() - alreadySent);
      const abort = async (reason: string) => {
        await runInTenantContext(storeId, () =>
          prisma.campaign.updateMany({
            where: { id: campaignId, storeId, status: 'sending' },
            data: { status: 'failed', lastError: reason, recipientCount: audience.length },
          })
        );
        return reason;
      };
      if (audience.length === 0) return { aborted: await abort('EMPTY_AUDIENCE') };
      if (audience.length > remaining) return { aborted: await abort('DAILY_CAP_EXCEEDED') };

      // Link a CRM customer by email, for display only (never widens consent).
      const customers = await runInTenantContext(storeId, () =>
        prisma.customer.findMany({
          where: {
            storeId,
            email: { in: audience.map(a => a.email), mode: 'insensitive' },
          },
          select: { id: true, email: true },
        })
      );
      const customerByEmail = new Map<string, string>();
      for (const c of customers) {
        if (c.email) customerByEmail.set(c.email.trim().toLowerCase(), c.id);
      }

      const storeLang = storeDefaultLanguage(store);
      await runInTenantContext(storeId, async () => {
        await prisma.campaignRecipient.createMany({
          data: audience.map(a => ({
            campaignId,
            storeId,
            email: a.email,
            subscriberId: a.subscriberId,
            customerId: customerByEmail.get(a.email) ?? null,
            locale: resolveRecipientLocale(campaign.localeStrategy, a.language, storeLang),
          })),
          skipDuplicates: true,
        });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { recipientCount: audience.length },
        });
      });
      return { total: audience.length };
    });
    if ('aborted' in materialized) {
      logger.warn({ campaignId, storeId, reason: materialized.aborted }, '[CAMPAIGN] aborted');
      return { aborted: materialized.aborted };
    }

    // 5. Stable id list (memoized), then crash-resumable batches.
    const ids: string[] = await step.run('list-queued', () =>
      runInTenantContext(storeId, async () =>
        (
          await prisma.campaignRecipient.findMany({
            where: { campaignId, storeId, status: 'queued' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
          })
        ).map(r => r.id)
      )
    );

    const batches = chunk(ids, CAMPAIGN_SEND_BATCH_SIZE);
    const throttleMs = campaignThrottleMs();
    for (let i = 0; i < batches.length; i++) {
      const result: BatchResult = await step.run(`batch-${i}`, async () => {
        const { campaign, store } = await loadSendContext(storeId, campaignId);
        if (!campaign || !store || campaign.status !== 'sending') {
          await failQueuedRecipients(storeId, campaignId, 'CANCELLED');
          return { sent: 0, failed: 0, skipped: 0, cancelled: true };
        }
        const base = storefrontBaseUrl(store);
        let sent = 0;
        let failed = 0;
        let skipped = 0;

        for (const recipientId of batches[i]) {
          const r = await runInTenantContext(storeId, () =>
            prisma.campaignRecipient.findFirst({
              where: { id: recipientId, campaignId, storeId },
              select: {
                id: true,
                email: true,
                locale: true,
                status: true,
                subscriber: { select: { isActive: true, unsubscribedAt: true } },
              },
            })
          );
          // Idempotency guard: anything already sent, failed or unsubscribed
          // (or erased since) is never mailed again.
          if (!r || r.status !== 'queued') {
            skipped++;
            continue;
          }
          // Consent is re-checked at send time, not only at materialize: a
          // subscriber who unsubscribed (via another campaign's link) or was
          // erased while this campaign was queued is skipped, never mailed.
          if (!r.subscriber || !r.subscriber.isActive || r.subscriber.unsubscribedAt) {
            await runInTenantContext(storeId, () =>
              prisma.campaignRecipient.updateMany({
                where: { id: r.id, status: 'queued' },
                data: { status: 'unsubscribed', error: 'CONSENT_WITHDRAWN_BEFORE_SEND' },
              })
            );
            skipped++;
            continue;
          }

          const content = pickCampaignContent(campaign, r.locale === 'ar' ? 'ar' : 'en');
          const token = signUnsubscribeToken(storeId, r.id);
          const { subject, html } = renderCampaignEmail({
            store,
            locale: content.locale,
            subject: content.subject,
            bodyHtml: content.bodyHtml,
            unsubscribeUrl: `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
          });

          let messageId: string;
          try {
            ({ id: messageId } = await ResendService.sendMarketingEmail(store, {
              to: r.email,
              subject,
              html,
              headers: listUnsubscribeHeaders(config.apiUrl, token),
              idempotencyKey: `campaign-recipient/${r.id}`,
            }));
          } catch (err) {
            // A throttle is transient: rethrow so the step retries with
            // backoff. Everything already sent in this batch is `sent` and is
            // skipped on the retry.
            if (err instanceof ResendSendError && err.code === 'rate_limit_exceeded') throw err;
            const message = (err instanceof Error ? err.message : 'send failed').slice(
              0,
              ERROR_MAX
            );
            await runInTenantContext(storeId, () =>
              prisma.campaignRecipient.updateMany({
                where: { id: r.id, status: 'queued' },
                data: { status: 'failed', error: message },
              })
            );
            failed++;
            logger.warn(
              {
                campaignId,
                storeId,
                recipientId: r.id,
                code: err instanceof ResendSendError ? err.code : 'unknown',
              },
              '[CAMPAIGN] recipient send failed'
            );
            continue;
          }

          // Not inside the try: if this write fails the step retries, the row
          // is still `queued`, and the idempotency key makes the resend a no-op.
          await runInTenantContext(storeId, () =>
            prisma.campaignRecipient.updateMany({
              where: { id: r.id, status: 'queued' },
              data: {
                status: 'sent',
                providerMessageId: messageId,
                sentAt: new Date(),
                error: null,
              },
            })
          );
          sent++;
          if (throttleMs > 0) await sleep(throttleMs);
        }
        return { sent, failed, skipped, cancelled: false };
      });
      logger.info({ campaignId, storeId, batch: i, ...result }, '[CAMPAIGN] batch done');
      if (result.cancelled) break;
    }

    // 6. Finalize counts + status.
    return step.run('finalize', () =>
      runInTenantContext(storeId, async () => {
        const [total, sentCount, failedCount] = await Promise.all([
          prisma.campaignRecipient.count({ where: { campaignId, storeId } }),
          prisma.campaignRecipient.count({ where: { campaignId, storeId, sentAt: { not: null } } }),
          prisma.campaignRecipient.count({ where: { campaignId, storeId, status: 'failed' } }),
        ]);
        const counts = { recipientCount: total, sentCount, failedCount };
        const done = await prisma.campaign.updateMany({
          where: { id: campaignId, storeId, status: 'sending' },
          data: {
            ...counts,
            status: sentCount > 0 ? 'sent' : 'failed',
            sentAt: new Date(),
            lastError: sentCount > 0 ? null : 'ALL_RECIPIENTS_FAILED',
          },
        });
        if (done.count === 0) {
          // Cancelled mid-send: keep `cancelled`, record what did go out.
          await prisma.campaign.updateMany({ where: { id: campaignId, storeId }, data: counts });
        }
        return counts;
      })
    );
  }
);

export const campaignSend: InngestFunction.Any = campaignSendFn;
