import type { JobDef } from '../../jobs/types';
import { withStore, withUser } from '@ebda/database';
import { REGION } from '@ebda/shared';
import logger from '../../logger';
import { inngest } from '../client';
import {
  capturePostHogServer,
  readAcquisition,
  sendEbdaCapiEvent,
  type EbdaAdsEventInput,
  type EbdaAdsEventName,
} from '../../../services/ebda-ads.service';

/**
 * Ebda's own acquisition conversions -> Meta Conversions API (+ PostHog for the paid step).
 *
 * Emitted AFTER the business transaction committed (email verified, store created, payment
 * confirmed), so a Meta outage can never slow or fail the user's flow. Retries 4x with
 * Inngest's backoff; on the FINAL attempt a failure is logged as a marked failure and the
 * function returns normally (an ad-attribution gap must not page as a platform incident).
 *
 * Purchase fires only for the store's FIRST paid subscription payment: the emit sites cannot
 * tell (a Kashier renewal, a manual InstaPay approval and a checkout all land here), so the
 * check is made here against the ledger.
 */
const MAX_ATTEMPTS = 5; // retries: 4 -> 5 attempts

type Data = {
  name?: EbdaAdsEventName;
  eventId?: string;
  userId?: string;
  storeId?: string;
  billingEventId?: string;
};

export type ConversionOutcome = { status: 'sent' } | { status: 'skipped'; reason: string };

/** Everything the function does except the retry policy, so it can be tested directly. */
export async function processEbdaConversion(data: Data): Promise<ConversionOutcome> {
  const { name, eventId, userId } = data;
  if (!name || !eventId || !userId) return { status: 'skipped', reason: 'missing_fields' };

  const user = await withUser(userId, tx =>
    tx.user.findUnique({
      where: { id: userId },
      select: { email: true, phone: true, acquisition: true, deletedAt: true },
    })
  );
  // Erased / unknown accounts never reach an ad platform.
  if (!user || user.deletedAt) return { status: 'skipped', reason: 'user_gone' };
  const acquisition = readAcquisition(user.acquisition);
  if (!acquisition) return { status: 'skipped', reason: 'no_acquisition' };

  const input: EbdaAdsEventInput = {
    name,
    eventId,
    userId,
    email: user.email,
    phone: user.phone,
    acquisition,
  };

  if (name === 'Purchase') {
    if (!data.storeId || !data.billingEventId)
      return { status: 'skipped', reason: 'missing_fields' };
    const { storeId, billingEventId } = data;
    const ledger = await withStore(storeId, async tx => {
      const row = await tx.billingEvent.findUnique({
        where: { id: billingEventId, storeId },
        select: {
          amountMinor: true,
          currency: true,
          planCode: true,
          status: true,
          createdAt: true,
        },
      });
      if (!row) return null;
      const earlier = await tx.billingEvent.count({
        where: {
          storeId,
          id: { not: billingEventId },
          status: 'succeeded',
          amountMinor: { gt: 0 },
          type: { in: ['checkout', 'upgrade', 'renewal', 'manual_payment'] },
          // an add-on / AI pack payment is not a subscription payment (SELF-SERVICE A8/A9)
          OR: [{ planCode: null }, { NOT: { planCode: { startsWith: 'addon:' } } }],
          createdAt: { lt: row.createdAt },
        },
      });
      return { row, earlier };
    });
    if (!ledger || ledger.row.status !== 'succeeded')
      return { status: 'skipped', reason: 'not_paid' };
    if (ledger.earlier > 0) return { status: 'skipped', reason: 'not_first_payment' };
    input.value = ledger.row.amountMinor / 100;
    input.currency = ledger.row.currency || REGION.currency;
    input.planCode = ledger.row.planCode ?? undefined;
  }

  const result = await sendEbdaCapiEvent(input);

  if (name === 'Purchase' && acquisition.consent.analytics && acquisition.phId) {
    // The one funnel step the browser never sees. Best effort: PostHog down must not retry Meta.
    await capturePostHogServer({
      distinctId: acquisition.phId,
      event: 'subscription_paid',
      properties: {
        event_id: eventId,
        value: input.value,
        currency: input.currency,
        plan: input.planCode,
        utm_source: acquisition.attribution?.utm_source,
        utm_campaign: acquisition.attribution?.utm_campaign,
      },
    }).catch(err => logger.warn({ err, eventId }, '[ebda-ads] posthog subscription_paid failed'));
  }

  return result.sent ? { status: 'sent' } : { status: 'skipped', reason: result.reason };
}

/**
 * One attempt with the failure policy: retry (throw) until the last attempt, then mark the
 * failure in the log and return normally. Exported so the policy is testable without Inngest.
 */
export async function attemptConversion(
  data: Data,
  attempt: number
): Promise<ConversionOutcome | { status: 'failed' }> {
  try {
    return await processEbdaConversion(data);
  } catch (err) {
    if (attempt + 1 < MAX_ATTEMPTS) throw err; // let Inngest retry
    logger.error(
      { err, event: data.name, eventId: data.eventId, userId: data.userId },
      '[ebda-ads] conversion FAILED after all retries — marked failed, not retried again'
    );
    return { status: 'failed' };
  }
}

export const ebdaAdsConversion: JobDef = inngest.createFunction(
  {
    id: 'ebda-ads-conversion',
    name: 'Ebda own ads — Meta Conversions API (registration, store, first paid subscription)',
    retries: 4, // = MAX_ATTEMPTS - 1 (Inngest types retries as a literal union)
    concurrency: { limit: 5 }, // Inngest Hobby plan cap; a higher value makes the whole app sync fail (INNGEST-PLAN-1)
    triggers: [{ event: 'ebda-ads/conversion.requested' }],
  },
  async ({ event, step, attempt }) => {
    const data = (event.data ?? {}) as Data;
    return step.run('send', () => attemptConversion(data, attempt ?? 0));
  }
);
