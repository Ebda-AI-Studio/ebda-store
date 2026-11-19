import { storeOperational } from '../../store-operational';
import type { JobDef } from '../../jobs/types';
import { storeActiveForJob, withStoreDb } from '../../jobs/store-db';

import { config } from '../../../config';
import logger from '../../logger';
import { inngest } from '../client';
import { chunk } from '../batch-utils';
import type { StoreReads } from '../../repo-factory';
import { signUnsubscribeToken } from '../../campaign-unsubscribe-token';
import { awaitCampaignSendSlot } from '../../campaign-send-pacer';
import { StoreMailer } from '../../../services/store-mailer.service';
import { EmailSendError } from '../../../services/mail-transport';
import { storeHidesPoweredBy } from '../../../services/email.service';
import { sendAlert } from '../../../services/alerts.service';
import {
  CAMPAIGN_STORE_SELECT,
  buildCampaignAudience,
  inCampaignStore,
  storeCampaignDailyCap,
  campaignThrottleMs,
  listUnsubscribeHeaders,
  pickCampaignContent,
  renderCampaignEmail,
  resolveRecipientLocale,
  normalizeEmail,
  sentInLast24h,
  storeDefaultLanguage,
  storefrontBaseUrl,
  type CampaignStoreContext,
} from '../../../services/campaign.service';

/**
 * Email campaign sender (D2). Plan: docs/plans/done/2026-09-25-email-campaigns.md.
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
 *    send (per store), and by waiting for a platform-wide send slot before
 *    every send (lib/campaign-send-pacer.ts, #1955) so concurrent stores'
 *    campaigns together stay under the shared Resend budget. A 429 is not the
 *    throttle — it throws, and the step retries.
 *  - Capped: a campaign whose audience exceeds the store's remaining rolling
 *    24h allowance fails as DAILY_CAP_EXCEEDED before any recipient exists.
 *  - No orphaned `queued` row: a failed send marks the recipient `failed`, a
 *    cancel marks the rest `failed`, and `onFailure` marks the rest `failed`
 *    if the whole job dies. `onFailure` also recomputes and persists
 *    recipientCount/sentCount/failedCount (#1952) — without it, a
 *    permanently failed job left those three columns at their pre-run value
 *    (often 0) while the recipients tab's own live groupBy already showed
 *    what actually happened, so the two admin surfaces disagreed.
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
  const [campaign, store] = await Promise.all([
    inCampaignStore(storeId, db =>
      db.campaign.findFirst({
        where: { id: campaignId, storeId },
        select: {
          status: true,
          subject: true,
          subjectAr: true,
          bodyHtml: true,
          bodyHtmlAr: true,
          localeStrategy: true,
        },
      })
    ),
    // `Store` is platform data on both backends (Ruling CF-WRITES-2)
    withStoreDb(storeId, db =>
      db.store.findUnique({ where: { id: storeId }, select: CAMPAIGN_STORE_SELECT })
    ),
  ]);
  return { campaign, store: store as CampaignStoreContext | null };
}

/** Every still-`queued` recipient of the campaign → failed(reason). */
async function failQueuedRecipients(storeId: string, campaignId: string, reason: string) {
  return inCampaignStore(storeId, (_db, w) =>
    w.campaignRecipient.updateMany({
      where: { campaignId, storeId, status: 'queued' },
      data: { status: 'failed', error: reason },
    })
  );
}

/**
 * Recompute recipientCount/sentCount/failedCount from the recipient rows.
 * Read-only — the caller persists the result inside whichever tenant context
 * it is already scoped to, so `finalize` can fold it into its existing atomic
 * status write and `onFailure` (#1952) can persist it on its own.
 */
async function computeRecipientCounts(
  db: StoreReads,
  storeId: string,
  campaignId: string
): Promise<{ recipientCount: number; sentCount: number; failedCount: number }> {
  const [recipientCount, sentCount, failedCount] = await Promise.all([
    db.campaignRecipient.count({ where: { campaignId, storeId } }),
    db.campaignRecipient.count({ where: { campaignId, storeId, sentAt: { not: null } } }),
    db.campaignRecipient.count({ where: { campaignId, storeId, status: 'failed' } }),
  ]);
  return { recipientCount, sentCount, failedCount };
}

interface BatchResult {
  sent: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  /** The store stopped being operational: the campaign is paused (recipients stay `queued`), not failed. */
  paused?: boolean;
  /**
   * The step stopped early to stay inside its wall-clock budget (issue 2115);
   * its unsent recipients are still `queued` and are picked up by the
   * leftover passes after the main loop.
   */
  deferred?: boolean;
}

/**
 * Wall-clock budget for ONE batch step (issue 2115). Each `step.run` is an
 * HTTP request from Inngest Cloud through Cloudflare, whose edge answers 524
 * at 100s. With K stores sending at once the shared 1/s pacer gives each
 * store ~1 send per K seconds, so a 20-recipient batch could run ~20·K s and
 * be killed mid-step; after the retries ran out `onFailure` marked every
 * still-queued recipient failed although they were never mailed. A step now
 * stops at this budget and the rest resume in later steps.
 */
function campaignBatchWallBudgetMs(): number {
  const n = parseInt(process.env.CAMPAIGN_BATCH_WALL_BUDGET_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** Upper bound on leftover passes after the main batches (each is ≥1 step). */
const CAMPAIGN_LEFTOVER_MAX_PASSES = 200;
/**
 * Upper bound on STEPS spent in leftover passes (issue 2297). The pass cap
 * alone allowed ~200 × (1 + ⌈N/20⌉) steps — >10,000 for a 1,000-recipient
 * campaign, far past what one Inngest run can hold — so a long deferral
 * episode would fail the run mid-campaign. Whatever is still queued when
 * either cap is hit is failed loudly in `finalize`, never left queued.
 */
const CAMPAIGN_LEFTOVER_MAX_STEPS = 400;

const campaignSendFn = inngest.createFunction(
  {
    id: 'campaign-send',
    name: 'Email campaign: send to consented newsletter subscribers',
    // One campaign at a time PER STORE (#1955) — a store's second campaign
    // queues behind its first, but never behind another store's. The shared
    // Resend key (2 req/s, also carrying all transactional mail) is protected
    // by the platform-wide send pacer (lib/campaign-send-pacer.ts), which
    // every send below waits on, not by serializing every store.
    concurrency: { limit: 1, key: 'event.data.storeId' },
    retries: 4,
    triggers: [{ event: 'campaign/send-requested' }],
    onFailure: async ({ event }) => {
      const data = (event?.data?.event?.data ?? {}) as SendEventData;
      const { campaignId, storeId, scheduledAt } = data;
      if (!campaignId || !storeId || !scheduledAt) return;
      const updated = await inCampaignStore(storeId, (_db, w) =>
        w.campaign.updateMany({
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
        // #1952: without this, a permanently failed send job left
        // recipientCount/sentCount/failedCount stuck at their pre-run value
        // (often 0) while the admin's recipients tab already showed the true
        // counts via its own live groupBy — the two admin surfaces disagreed.
        await inCampaignStore(storeId, async (db, w) => {
          const counts = await computeRecipientCounts(db, storeId, campaignId);
          await w.campaign.updateMany({ where: { id: campaignId, storeId }, data: counts });
        });
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
      const c = await inCampaignStore(storeId, db =>
        db.campaign.findFirst({
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
    // Unconditional: a past time resumes at once, and a clock check here would make a replay skip the
    // sleep the first run took (the job's concurrency lease is released/re-taken around it).
    await step.sleepUntil('wait-for-schedule', nonce);

    // A store suspended or closed while the campaign waited sends nothing; a skip, not a failed run.
    if (
      !(await step.run('check-store-active', () => storeActiveForJob(storeId, 'campaign-send')))
    ) {
      return { skipped: 'store-not-active' };
    }

    // 3. Claim scheduled → sending, atomically and only for this request.
    //    A cancel during the wait leaves it `cancelled` and nothing is sent.
    const claimed = await step.run('claim', () =>
      inCampaignStore(storeId, async (_db, w) => {
        const r = await w.campaign.updateMany({
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

      const audience = await inCampaignStore(storeId, () => buildCampaignAudience(storeId));
      const alreadySent = await inCampaignStore(storeId, () => sentInLast24h(storeId));
      const dailyCap = await storeCampaignDailyCap(storeId);
      const remaining = Math.max(0, dailyCap - alreadySent);
      const abort = async (reason: string) => {
        await inCampaignStore(storeId, (_db, w) =>
          w.campaign.updateMany({
            where: { id: campaignId, storeId, status: 'sending' },
            data: { status: 'failed', lastError: reason, recipientCount: audience.length },
          })
        );
        return reason;
      };
      if (audience.length === 0) return { aborted: await abort('EMPTY_AUDIENCE') };
      // Arithmetic (cap 10): `remaining` = cap - EVERY send in the last 24h, this campaign's own included. need = the
      // CURRENT audience members (same normalised email the audience and the send loop use) with no `sent` row for this
      // campaign yet; compare need to `remaining`, never audience to it, and never count a recipient twice.
      //   own 5 sent today, others 0, audience 8 (incl. those 5): remaining 5, need 3 -> go.   others 4: remaining 1 -> refuse.
      // Sends that are not in the rebuilt audience (unsubscribed since) or fell outside the 24h window (a resume next day)
      // must NOT shrink need: own 5 sent yesterday, audience 8, remaining 2 -> need 3 -> refuse (a bare count would say 3 - 5 < 2).
      const sentRows = await inCampaignStore(storeId, db =>
        db.campaignRecipient.findMany({
          where: { campaignId, storeId, status: 'sent' },
          select: { email: true },
        })
      );
      const sentEmails = new Set(sentRows.map(r => normalizeEmail(r.email ?? '')));
      const need = audience.filter(a => !sentEmails.has(a.email)).length;
      if (need > remaining) {
        return { aborted: await abort('DAILY_CAP_EXCEEDED') };
      }

      // Link a CRM customer by email, for display only (never widens consent).
      const customers = await inCampaignStore(storeId, db =>
        db.customer.findMany({
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
      await inCampaignStore(storeId, async (_db, w) => {
        await w.campaignRecipient.createMany({
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
        await w.campaign.update({
          where: { id: campaignId, storeId },
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
      inCampaignStore(storeId, async db =>
        (
          await db.campaignRecipient.findMany({
            where: { campaignId, storeId, status: 'queued' },
            select: { id: true },
            orderBy: { createdAt: 'asc' },
          })
        ).map(r => r.id)
      )
    );

    const batches = chunk(ids, CAMPAIGN_SEND_BATCH_SIZE);
    const throttleMs = campaignThrottleMs();
    const wallBudgetMs = campaignBatchWallBudgetMs();

    /** Send to `recipientIds` (a batch), inside ONE step's wall-clock budget. */
    const sendBatch = async (recipientIds: string[]): Promise<BatchResult> => {
      const { campaign, store } = await loadSendContext(storeId, campaignId);
      if (!campaign || !store || campaign.status !== 'sending') {
        await failQueuedRecipients(storeId, campaignId, 'CANCELLED');
        return { sent: 0, failed: 0, skipped: 0, cancelled: true };
      }
      // Ruling SUSPEND-OUT-1: ONE status read per batch (not per recipient). A store suspended mid-send PAUSES the campaign:
      // nothing is marked failed, the recipients stay `queued`, and a new Send after reactivation resumes them.
      if (!(await storeOperational(storeId))) {
        return { sent: 0, failed: 0, skipped: 0, cancelled: false, paused: true };
      }
      const base = storefrontBaseUrl(store);
      let sent = 0;
      let failed = 0;
      let skipped = 0;

      const startedAt = Date.now();
      let deferred = false;
      // Plan decision, resolved once per batch (Growth + Business hide the line).
      const hidePoweredBy = await storeHidesPoweredBy(storeId);
      for (const recipientId of recipientIds) {
        // Stop inside the wall-clock budget (issue 2115); the rest stay
        // `queued` and resume in a later step.
        if (wallBudgetMs - (Date.now() - startedAt) <= 0) {
          deferred = true;
          break;
        }
        // The subscriber is read by id, not through a relation: a DO store has no relation join (Ruling CF-R6A-2).
        const r = await inCampaignStore(storeId, async db => {
          const row = await db.campaignRecipient.findFirst({
            where: { id: recipientId, campaignId, storeId },
            select: {
              id: true,
              email: true,
              locale: true,
              status: true,
              subscriberId: true,
            },
          });
          if (!row) return null;
          const subscriber = row.subscriberId
            ? await db.newsletterSubscriber.findFirst({
                where: { id: row.subscriberId, storeId },
                select: { isActive: true, unsubscribedAt: true },
              })
            : null;
          return { ...row, subscriber };
        });
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
          await inCampaignStore(storeId, (_db, w) =>
            w.campaignRecipient.updateMany({
              where: { id: r.id, storeId, status: 'queued' },
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
          hidePoweredBy,
          locale: content.locale,
          subject: content.subject,
          bodyHtml: content.bodyHtml,
          unsubscribeUrl: `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
        });

        // Platform-wide rate bound across every store's running campaign —
        // but never a wait past this step's remaining budget (issue 2115).
        if (!(await awaitCampaignSendSlot(wallBudgetMs - (Date.now() - startedAt)))) {
          deferred = true;
          break;
        }
        let messageId: string;
        try {
          ({ id: messageId } = await StoreMailer.sendMarketingEmail(store, {
            to: r.email,
            subject,
            html,
            headers: listUnsubscribeHeaders(config.apiUrl, token),
            idempotencyKey: `campaign-recipient/${r.id}`,
            operationalChecked: true,
          }));
        } catch (err) {
          // A throttle is transient: rethrow so the step retries with
          // backoff. Everything already sent in this batch is `sent` and is
          // skipped on the retry.
          if (err instanceof EmailSendError && err.isRateLimit) throw err;
          const message = (err instanceof Error ? err.message : 'send failed').slice(0, ERROR_MAX);
          await inCampaignStore(storeId, (_db, w) =>
            w.campaignRecipient.updateMany({
              where: { id: r.id, storeId, status: 'queued' },
              data: { status: 'failed', error: message },
            })
          );
          failed++;
          logger.warn(
            {
              campaignId,
              storeId,
              recipientId: r.id,
              code: err instanceof EmailSendError ? err.code : 'unknown',
            },
            '[CAMPAIGN] recipient send failed'
          );
          continue;
        }

        // Not inside the try: if this write fails the step retries, the row
        // is still `queued`, and the idempotency key makes the resend a no-op.
        await inCampaignStore(storeId, (_db, w) =>
          w.campaignRecipient.updateMany({
            where: { id: r.id, storeId, status: 'queued' },
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
      return { sent, failed, skipped, cancelled: false, deferred };
    };

    let cancelled = false;
    let paused = false;
    let anyDeferred = false;
    for (let i = 0; i < batches.length; i++) {
      const result: BatchResult = await step.run(`batch-${i}`, () => sendBatch(batches[i]));
      logger.info({ campaignId, storeId, batch: i, ...result }, '[CAMPAIGN] batch done');
      if (result.deferred) anyDeferred = true;
      if (result.paused) {
        paused = true;
        break;
      }
      if (result.cancelled) {
        cancelled = true;
        break;
      }
    }

    // Leftovers (issue 2115): recipients a budget-limited step did not reach
    // are still `queued`. Re-list and send them in further steps until none
    // remain. Only runs when a step actually deferred, so a normal campaign
    // takes no extra steps.
    let leftoverSteps = 0;
    for (
      let pass = 0;
      anyDeferred &&
      !cancelled &&
      !paused &&
      pass < CAMPAIGN_LEFTOVER_MAX_PASSES &&
      leftoverSteps < CAMPAIGN_LEFTOVER_MAX_STEPS;
      pass++
    ) {
      leftoverSteps += 1;
      const left: string[] = await step.run(`leftover-list-${pass}`, () =>
        inCampaignStore(storeId, async db =>
          (
            await db.campaignRecipient.findMany({
              where: { campaignId, storeId, status: 'queued' },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            })
          ).map(r => r.id)
        )
      );
      if (left.length === 0) break;
      anyDeferred = false;
      const leftBatches = chunk(left, CAMPAIGN_SEND_BATCH_SIZE);
      for (let j = 0; j < leftBatches.length; j++) {
        if (leftoverSteps >= CAMPAIGN_LEFTOVER_MAX_STEPS) break;
        leftoverSteps += 1;
        const result: BatchResult = await step.run(`leftover-${pass}-batch-${j}`, () =>
          sendBatch(leftBatches[j])
        );
        logger.info(
          { campaignId, storeId, pass, batch: j, ...result },
          '[CAMPAIGN] leftover batch done'
        );
        if (result.deferred) anyDeferred = true;
        if (result.paused) {
          paused = true;
          break;
        }
        if (result.cancelled) {
          cancelled = true;
          break;
        }
      }
    }

    // Paused (Ruling SUSPEND-OUT-1): back to `draft` with the counts so far; queued recipients are kept, so Send after
    // reactivation re-materializes idempotently (skipDuplicates) and mails only those still `queued`.
    if (paused) {
      await step.run('pause-store-not-operational', () =>
        inCampaignStore(storeId, async (db, w) => {
          const counts = await computeRecipientCounts(db, storeId, campaignId);
          await w.campaign.updateMany({
            where: { id: campaignId, storeId, status: 'sending' },
            data: {
              ...counts,
              status: 'draft',
              scheduledAt: null,
              lastError: 'STORE_NOT_OPERATIONAL',
            },
          });
        })
      );
      logger.warn({ campaignId, storeId }, '[CAMPAIGN] store not operational; campaign paused');
      return { paused: 'store-not-operational' };
    }

    // 6. Finalize counts + status.
    //
    // Stranded recipients (issue 2297): if the leftover passes hit a cap with
    // recipients still `queued`, they were never mailed. `computeRecipientCounts`
    // does not count `queued`, so they used to vanish behind a `sent` campaign
    // with no alert and no retry. They are failed here with an explicit reason
    // (the same shape `onFailure` uses) and a P1 names the campaign — only
    // while the campaign is still `sending`, so a cancel keeps its own reason.
    const finalized = await step.run('finalize', () =>
      inCampaignStore(storeId, async (db, w) => {
        const live = await db.campaign.findFirst({
          where: { id: campaignId, storeId, status: 'sending' },
          select: { id: true },
        });
        const stranded = live
          ? await w.campaignRecipient.updateMany({
              where: { campaignId, storeId, status: 'queued' },
              data: { status: 'failed', error: 'SEND_WINDOW_EXHAUSTED' },
            })
          : { count: 0 };
        const counts = await computeRecipientCounts(db, storeId, campaignId);
        const done = await w.campaign.updateMany({
          where: { id: campaignId, storeId, status: 'sending' },
          data: {
            ...counts,
            status: counts.sentCount > 0 ? 'sent' : 'failed',
            sentAt: new Date(),
            lastError: counts.sentCount > 0 ? null : 'ALL_RECIPIENTS_FAILED',
          },
        });
        if (done.count === 0) {
          // Cancelled mid-send: keep `cancelled`, record what did go out.
          await w.campaign.updateMany({ where: { id: campaignId, storeId }, data: counts });
        }
        return { ...counts, stranded: stranded.count };
      })
    );
    if (finalized.stranded > 0) {
      await step.run('alert-stranded-recipients', async () => {
        logger.error(
          { campaignId, storeId, stranded: finalized.stranded },
          '[CAMPAIGN] recipients still queued after the send window — marked failed'
        );
        await sendAlert({
          level: 'p1',
          scope: 'store',
          store: { id: storeId, name: storeId },
          source: 'campaign.send.window_exhausted',
          title: 'Email campaign ended with recipients never mailed',
          body:
            `${finalized.stranded} recipient(s) of campaign ${campaignId} were still queued when ` +
            `the send job ran out of leftover passes (the platform send pacer kept deferring). ` +
            `They are marked failed (SEND_WINDOW_EXHAUSTED) and were NOT emailed.`,
          context: { campaignId, stranded: finalized.stranded },
        }).catch(() => undefined);
      });
    }
    return {
      recipientCount: finalized.recipientCount,
      sentCount: finalized.sentCount,
      failedCount: finalized.failedCount,
    };
  }
);

export const campaignSend: JobDef = campaignSendFn;
