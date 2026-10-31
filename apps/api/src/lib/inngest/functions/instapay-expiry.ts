import type { JobDef } from '../../jobs/types';
import { AWAITING_PAYMENT_CONFIRMATION } from '@ebda/shared';
import logger from '../../logger';
import { inngest } from '../client';
import { sweepStoresDb } from '../../jobs/store-db';
import { stepRunUnlessEmpty } from '../empty-exit';
import { InstapayService } from '../../../services/payment-providers/instapay.service';

/**
 * InstaPay hold expiry (SP6a, Review Focus 3) — hourly (Ruling INNGEST-BUDGET-1).
 *
 * An InstaPay order waits in `awaiting_payment_confirmation` for the merchant to
 * confirm the transfer. Past `payment_confirmation_expires_at` (default 24h, per
 * store) the money is not coming: the order is cancelled, its stock released
 * through the normal cancel path, and the merchant (push) and customer
 * (cancellation notice) are told. A confirm that wins the row lock first keeps
 * the order; one that arrives after expiry is refused.
 *
 * Cross-store without a bypass: the due orders are found with one tenant
 * transaction per store (`sweepAcrossStores`, strict RLS), and each order is then
 * expired in its OWN short store transaction (`InstapayService.expireOne`), so one
 * bad order or tenant never blocks the rest and no transaction spans the sweep.
 */
const RUN_CAP = 500;

export const instapayExpiry: JobDef = inngest.createFunction(
  {
    id: 'instapay-expiry',
    name: 'Expire unconfirmed InstaPay orders (hourly)',
    retries: 2,
    concurrency: { limit: 1 },
    // HOURLY (Ruling INNGEST-BUDGET-1): the hold is 24-48h, so a cancel up to 1h late moves nothing a
    // shopper or merchant can see; stock is released 1h later at worst.
    triggers: [{ cron: '7 * * * *' }],
  },
  async ({ step, event }) => {
    const due = await stepRunUnlessEmpty(step, 'find-due', () => {
      // Read inside the step: the cutoff is part of the memoised read, not re-derived on replay.
      const now = new Date();
      // PORTED (Ruling CF-JOBS-4): the cron lists the Postgres stores, a DO store's alarm reads its own Durable Object;
      // `expireOne` then takes the DO path (`expireHold`) for it.
      return sweepStoresDb(event, {
        fetch: (storeId, db) =>
          db.order.findMany({
            where: {
              storeId,
              status: AWAITING_PAYMENT_CONFIRMATION,
              deletedAt: null,
              paymentConfirmationExpiresAt: { lte: now },
            },
            select: { id: true, storeId: true, paymentConfirmationExpiresAt: true },
            orderBy: { paymentConfirmationExpiresAt: 'asc' },
            take: RUN_CAP,
          }),
        orderKey: r => r.paymentConfirmationExpiresAt ?? 0,
        take: RUN_CAP,
      });
    });

    let expired = 0;
    let skipped = 0;
    let failed = 0;
    for (const o of due) {
      const outcome = await step.run(`expire-${o.id}`, async () => {
        try {
          return await InstapayService.expireOne(o.storeId, o.id, new Date());
        } catch (err) {
          logger.error({ err, orderId: o.id, storeId: o.storeId }, 'instapay-expiry: failed');
          return 'failed' as const;
        }
      });
      if (outcome === 'expired') expired += 1;
      else if (outcome === 'failed') failed += 1;
      else skipped += 1;
    }
    logger.info({ scanned: due.length, expired, skipped, failed }, 'instapay-expiry completed');
    return { scanned: due.length, expired, skipped, failed };
  }
);
