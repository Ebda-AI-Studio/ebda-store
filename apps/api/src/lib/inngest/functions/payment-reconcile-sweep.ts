import type { JobDef } from '../../jobs/types';
import { storeNameOf, sweepStoresDb, withStoreDb } from '../../jobs/store-db';
import logger from '../../logger';
import { inngest } from '../client';
import { stepRunUnlessEmpty } from '../empty-exit';
import { sendAlert } from '../../../services/alerts.service';
import { recordPaymentEventForStore } from '../../../services/payment-event.service';

/**
 * Payment/order state reconciliation sweep (adversarial audit P2, Task 9).
 *
 * Targets the one durable mismatch no other guard can prevent: a CAPTURED
 * payment on a CANCELLED order. The webhook handler now asserts the order
 * transition BEFORE writing `Payment.status`, so a raced `completed` webhook
 * no longer creates this state on our side — but the capture can still
 * happen AT THE PROVIDER (customer pays at the gateway in the race window
 * around a cancel; rollback-cancel and admin-cancel don't ask the provider
 * first the way the daily auto-cancel does), and older rows may already
 * carry the shape. Money was taken for an order that will never ship;
 * without this sweep nobody notices until the customer disputes.
 *
 * Per mismatch: one P0 alert + one durable `reconciliation` PaymentEvent
 * (reason `completed_payment_on_cancelled_order`) that doubles as the
 * alert-once dedupe marker, so a persisting mismatch never re-alerts every
 * tick — resolving it (refund the capture, or reinstate the order) is a
 * human action the alert hands to finance.
 *
 * RECENCY FLOOR (load-bearing — see refund-reversal-stuck-sweep's P0
 * comment): only rows whose payment OR order changed within the window are
 * scanned, so the first tick after deploy cannot trawl the entire
 * historical order book.
 */

const SWEEP_TAKE = 200;
const RECENCY_HOURS = Number(process.env.PAYMENT_RECONCILE_RECENCY_HOURS) || 48;

const MISMATCH_REASON = 'completed_payment_on_cancelled_order';

interface SweepStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/** Extracted handler — testable in isolation (mirrors the other sweeps). */
export async function handlePaymentReconcileSweep(
  step: SweepStep,
  event?: { data?: unknown }
): Promise<{ scanned: number; alerted: number }> {
  const floor = new Date(Date.now() - RECENCY_HOURS * 3_600_000);

  // Cross-tenant read — Inngest crons run outside tenant-context middleware.
  // PORTED (Ruling CF-JOBS-4): the cron lists the Postgres stores, a DO store's alarm reads its own Durable Object.
  const mismatches = await stepRunUnlessEmpty(step, 'find-captured-on-cancelled', () =>
    // `payments` is scoped through its order, so the scan runs store by store and is cut to the same global ceiling.
    sweepStoresDb(event, {
      fetch: (storeId, db) =>
        db.payment.findMany({
          where: {
            status: 'completed',
            order: { storeId, status: 'cancelled' },
            OR: [{ updatedAt: { gt: floor } }, { order: { updatedAt: { gt: floor } } }],
          },
          select: {
            id: true,
            orderId: true,
            provider: true,
            amount: true,
            currency: true,
            order: { select: { storeId: true } },
          },
          take: SWEEP_TAKE,
        }),
      orderKey: () => 0,
      take: SWEEP_TAKE,
    })
  );

  if (mismatches.length === 0) return { scanned: 0, alerted: 0 };

  let alerted = 0;
  await step.run('alert-mismatches', async () => {
    for (const p of mismatches) {
      try {
        // Durable alert-once dedupe: the reconciliation PaymentEvent written
        // below marks this payment as already reported.
        // The reason is matched here, not with a JSON-path filter: the Durable Object's read client does not take one.
        const reported = await withStoreDb(p.order.storeId, db =>
          db.paymentEvent.findMany({
            where: { storeId: p.order.storeId, paymentId: p.id, eventType: 'reconciliation' },
            select: { details: true },
          })
        );
        const alreadyReported = reported.some(
          e => (e.details as { reason?: unknown } | null)?.reason === MISMATCH_REASON
        );
        if (alreadyReported) continue;

        logger.error(
          { paymentId: p.id, orderId: p.orderId, provider: p.provider, amount: p.amount },
          '[payment-reconcile-sweep] captured payment on a cancelled order'
        );
        await sendAlert({
          level: 'p0',
          scope: 'store',
          store: {
            id: p.order?.storeId ?? '',
            name: await storeNameOf(p.order?.storeId ?? ''),
          },
          source: 'payment.completed_on_cancelled_order',
          title: 'payment.completed_on_cancelled_order',
          body: `Order ${p.orderId} is cancelled but payment ${p.id} (${p.provider}) is captured for ${p.amount} ${p.currency}. Money was taken for an order that will not ship — refund the capture or reinstate the order.`,
          context: {
            orderId: p.orderId,
            paymentId: p.id,
            provider: p.provider,
            amountFils: p.amount,
          },
        });
        await recordPaymentEventForStore({
          paymentId: p.id,
          storeId: p.order?.storeId ?? '',
          orderId: p.orderId,
          eventType: 'reconciliation',
          fromStatus: 'completed',
          toStatus: null,
          provider: p.provider,
          details: { reason: MISMATCH_REASON },
        });
        alerted += 1;
      } catch (err) {
        logger.error(
          { err, paymentId: p.id },
          '[payment-reconcile-sweep] failed to report mismatch'
        );
      }
    }
  });

  return { scanned: mismatches.length, alerted };
}

export const paymentReconcileSweep: JobDef = inngest.createFunction(
  {
    id: 'payment-reconcile-sweep',
    name: 'Payment reconcile — captured payment on cancelled order watch',
    retries: 2,
    // Hourly, off the minute-0 herd. Deliberately NOT tighter: this is a
    // human-actioned finance alert, and refund-reversal-stuck-sweep's
    // CADENCE NOTE (Neon autosuspend cost) applies to every DB-polling cron.
    triggers: [{ cron: '17 * * * *' }],
  },
  async ({ step, event }) => handlePaymentReconcileSweep(step, event)
);
