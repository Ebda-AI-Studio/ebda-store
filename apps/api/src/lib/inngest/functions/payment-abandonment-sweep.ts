import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { stepRunUnlessEmpty } from '../empty-exit';
import { featureService } from '../../../services/feature.service';
import { OneSignalService } from '../../../services/onesignal.service';
import { storeNameOf, sweepStoresDb } from '../../jobs/store-db';
import { storeMoney } from '../../repo-factory';
import { prisma, runInTenantContext } from '@ebda/database';

import { REGION } from '@ebda/shared';
/**
 * Payment-gateway abandonment sweep — runs every 30 min (Enterprise only).
 *
 * Finds orders that:
 *   - are still status=pending / paymentStatus=unpaid
 *   - have a Payment row with a non-null paymentUrl (customer was redirected
 *     to an online gateway — Paymob / Kashier / Fawry)
 *   - were created more than PAYMENT_ABANDON_MINUTES ago (default 30 min)
 *   - have NOT yet been stamped as an abandoner (paymentGatewayAbandonedAt IS NULL)
 *   - the store has the 'payment_abandonment' Enterprise feature enabled
 *
 * These are "high-intent abandoners": shoppers who got all the way to the
 * gateway checkout page but did not complete payment. Very different from
 * cart abandoners (never reached checkout).
 *
 * The sweep stamps paymentGatewayAbandonedAt AND fires a one-time "Checkout
 * abandoned" recovery push to the store admins + super_admins (deep-linking to
 * the Payment Abandonments retargeting page). It does NOT cancel the order or
 * change paymentStatus — the merchant decides via the retargeting UI. The
 * `paymentGatewayAbandonedAt` stamp dedupes the alert to exactly once per order
 * (the stamp-guard updateMany only alerts when it actually flips the column).
 * The auto-cancel-unpaid cron still handles cancellation after
 * AUTO_CANCEL_UNPAID_DAYS (default 2 days).
 *
 * This is the single unpaid-online-order merchant alert (Enterprise
 * recovery/retargeting angle, 30 min default). It is gated by the
 * `payment_abandonment` feature, so a merchant who disables the feature gets no
 * abandonment pings at all.
 *
 * Capped at 500 orders/run (oldest first); the next tick picks up the rest.
 * Each stamp is wrapped in its own step.run so a single failure doesn't abort
 * the batch.
 */

const PAYMENT_ABANDON_MINUTES = Number(process.env.PAYMENT_ABANDON_MINUTES) || 30;
const SWEEP_CAP = 500;
// Providers that represent cash/COD — no gateway was reached, not an abandoner.
const CASH_PROVIDERS = new Set(['cod', 'cash', 'cash_on_delivery']);

/** Shape of each row returned by the candidate query. */
interface AbandonCandidate {
  id: string;
  storeId: string;
  orderNumber: string;
  total: number;
  currency: string;
  payments: { provider: string | null }[];
}

export const paymentAbandonmentSweep: JobDef = inngest.createFunction(
  {
    id: 'payment-abandonment-sweep',
    name: 'Payment-gateway abandonment capture (hourly cron, Enterprise)',
    retries: 2,
    concurrency: { limit: 1 },
    // HOURLY (Ruling INNGEST-BUDGET-1): the alert is a merchant follow-up nudge on a checkout already 30+ min
    // old, deduped once per order by the stamp; the order is auto-cancelled only after days.
    triggers: [{ cron: '7 * * * *' }], // hourly
  },
  async ({ step, event }) => {
    // PORTED (Ruling CF-JOBS-4): the cron lists the Postgres stores, a DO store's alarm reads its own Durable Object and
    // stamps through the `abandonStamp` op.
    // Cross-tenant sweep — bypass RLS (no HTTP tenant GUC on a cron).
    const candidates = (await stepRunUnlessEmpty(step, 'find-gateway-abandoners', () => {
      // Inside the step: the cutoff is part of the memoised read, not re-derived on replay.
      const threshold = new Date(Date.now() - PAYMENT_ABANDON_MINUTES * 60_000);
      return sweepStoresDb(event, {
        fetch: (storeId, db) =>
          db.order.findMany({
            where: {
              storeId,
              status: 'pending',
              paymentStatus: 'unpaid',
              paymentGatewayAbandonedAt: null,
              deletedAt: null,
              createdAt: { lt: threshold },
              // Must have at least one Payment with a paymentUrl (gateway link
              // was generated — customer was redirected or saw the URL).
              payments: {
                some: {
                  paymentUrl: { not: null },
                  // Exclude cash/COD providers even if they somehow have a URL.
                  provider: { notIn: [...CASH_PROVIDERS] },
                },
              },
            },
            select: {
              createdAt: true,
              id: true,
              storeId: true,
              orderNumber: true,
              total: true,
              currency: true,
              payments: {
                where: { paymentUrl: { not: null } },
                select: { provider: true },
                take: 1,
              },
            },
            orderBy: { createdAt: 'asc' },
            take: SWEEP_CAP,
          }),
        orderKey: r => r.createdAt,
        take: SWEEP_CAP,
      });
    })) as AbandonCandidate[];

    if (candidates.length === 0) {
      logger.debug('[payment-abandonment-sweep] no gateway abandoners found this tick');
      return { stamped: 0, skipped: 0 };
    }

    logger.info(
      { count: candidates.length },
      '[payment-abandonment-sweep] gateway abandoners found'
    );

    // Per-store Enterprise feature check — only stamp for enabled stores.
    const storeIds = [...new Set(candidates.map((c: AbandonCandidate) => c.storeId))];
    // In a step: on a Workflow only step bodies hold a database connection.
    const enabledStoreIds = new Set(
      await step.run('check-features', async () => {
        await featureService.prefetchStoreFeatures(storeIds); // per run only, 3 batched reads
        const flags = await Promise.all(
          storeIds.map(
            async (sid: string) =>
              [sid, await featureService.isFeatureEnabled(sid, 'payment_abandonment')] as const
          )
        );
        return flags.filter(([, on]) => on).map(([sid]) => sid);
      })
    );

    const eligible = candidates.filter((c: AbandonCandidate) => enabledStoreIds.has(c.storeId));
    const skipped = candidates.length - eligible.length;

    if (eligible.length === 0) {
      logger.debug(
        { skipped },
        '[payment-abandonment-sweep] all candidates skipped (feature not enabled)'
      );
      return { stamped: 0, skipped };
    }

    // Stamp each order in its own tenant context so RLS is correct for the
    // UPDATE. step.run gives Inngest per-item retry isolation.
    const results = await Promise.allSettled(
      eligible.map((order: AbandonCandidate) =>
        step.run(`stamp-${order.id}`, async () => {
          const now = new Date();
          // A store on its Durable Object stamps in its own section (the same guard: still unpaid, not yet stamped).
          const money = await storeMoney(order.storeId);
          const res = money
            ? { count: (await money.abandonStamp({ orderId: order.id })).stamped ? 1 : 0 }
            : await runInTenantContext(order.storeId, () =>
                prisma.order.updateMany({
                  where: {
                    id: order.id,
                    storeId: order.storeId,
                    // Double-check conditions still hold (race: webhook may have
                    // completed payment between sweep read and stamp write).
                    paymentStatus: 'unpaid',
                    paymentGatewayAbandonedAt: null,
                  },
                  data: { paymentGatewayAbandonedAt: now },
                })
              );
          // count === 0 → the guard didn't match (already stamped or paid in the
          // race window). Skip both the counter and the alert so we never
          // double-notify. This is what makes the push exactly-once per order.
          if (res.count === 0) return false;

          logger.info(
            { orderId: order.id, storeId: order.storeId, orderNumber: order.orderNumber },
            '[payment-abandonment-sweep] stamped'
          );

          // Fire the recovery push (best-effort — the method swallows its own
          // errors, but wrap anyway so nothing can abort the sweep).
          try {
            await OneSignalService.notifyAdminsOfAbandonedCheckout({
              orderId: order.id,
              orderNumber: order.orderNumber,
              storeId: order.storeId,
              storeName: await storeNameOf(order.storeId),
              customerName: '',
              total: order.total ?? 0,
              currency: order.currency ?? REGION.currency,
            });
          } catch (err) {
            logger.error(
              { err, orderId: order.id },
              '[payment-abandonment-sweep] abandoned-checkout push failed'
            );
          }
          return true;
        })
      )
    );
    // Counted from the step results (memoised), not a closure counter a replay would reset.
    const stamped = results.filter(r => r.status === 'fulfilled' && r.value === true).length;

    logger.info({ stamped, skipped }, '[payment-abandonment-sweep] tick complete');
    return { stamped, skipped };
  }
);
