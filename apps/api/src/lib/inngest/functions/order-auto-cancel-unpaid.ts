import type { JobDef } from '../../jobs/types';
import { prisma, runInTenantContext } from '@ebda/database';
import logger from '../../logger';
import { inngest } from '../client';
import { OrderService } from '../../../services/order.service';
import { PaymentService } from '../../../services/payment-providers/payment.factory';
import { confirmPaymentFromProviderStatus } from '../../../services/payment-confirm.service';
import type { PaymentProvider } from '../../../services/payment-providers/types';
import { sendAlert } from '../../../services/alerts.service';
import { AppError } from '../../../middleware/error-handler';
import { recordPaymentEventForStore } from '../../../services/payment-event.service';
import { sweepStoresDb } from '../../jobs/store-db';
import { storeMoney } from '../../repo-factory';
import { OPEN_HOLD_PAYMENT_STATUSES } from '../../stock-hold-cap';

/**
 * Auto-cancel stale unpaid orders — daily cron (03:00 UTC).
 *
 * Finds orders left status=pending / paymentStatus=unpaid past
 * AUTO_CANCEL_UNPAID_DAYS (default 2 — matches the payment-link
 * 2-day validity, after which the link is dead and the order will never be
 * paid) and cancels them.
 *
 * RECONCILE BEFORE CANCEL
 * -----------------------
 * `paymentStatus='unpaid'` means "we were never TOLD it was paid" — it does not
 * mean "the money was not captured". Three independent paths normally tell us:
 * the provider webhook, the guest verify-on-return call on the success page,
 * and the merchant's manual "Refresh payment" button. All three can miss the
 * same order at once:
 *
 *   customer pays → webhook is lost (dropped, or — for a gateway that never fires
 *   per-invoice because it is configured account-level) AND the customer never
 *   lands back on the success page (closed the tab, dead battery, lost signal)
 *
 * There is then no inbox row for `payment-webhook-stuck-sweep` to find and no
 * return for verify-on-return to ride on, so this cron was the next thing to
 * touch the order — and it cancelled it, released the stock, and emailed the
 * customer an "order cancelled" notice for an order they had genuinely paid
 * for. The money stayed captured at the provider.
 *
 * So before cancelling, any order carrying an online-gateway payment row is
 * reconciled against the provider. A `completed` answer routes into
 * `confirmPaymentFromProviderStatus` — the SAME idempotent single-writer the
 * webhook, verify-on-return and admin-refresh paths use — which marks the order
 * paid/confirmed and runs the post-payment fanout exactly once. It is NOT
 * cancelled.
 *
 * FAIL-CLOSED ON AN UNKNOWN ANSWER
 * --------------------------------
 * If the provider call throws (network blip, expired credentials, provider
 * outage), the order is SKIPPED, not cancelled. Cancelling on a
 * "we couldn't ask" answer is precisely the bug this guard exists to prevent.
 * The order stays pending and the next daily run retries it; a skip that
 * persists is surfaced by the P1 alert below rather than being silently
 * absorbed. Erring toward "leave it pending one more day" is always cheaper
 * than erring toward "cancel an order the customer paid for".
 *
 * Cancellation itself goes through `OrderService.updateStatus(storeId, orderId,
 * 'cancelled')`. After the order-payment-lifecycle FIX, updateStatus only runs
 * applyRefundEffects (refund reversal + "Refund issued" merchant push) when the
 * order had a CAPTURED payment — so cancelling an unpaid order here issues NO
 * refund and sends NO "Refund issued" push. The customer still gets the normal
 * `order_cancelled` notification (email + configured channels). Reusing
 * updateStatus keeps the cancel path identical to a manual admin cancel
 * (inventory release, valid-transition checks, real-time socket ping, etc.).
 *
 * Capped at 500 orders/run (oldest first); the next daily run sweeps the rest.
 * Each order is its own step.run so one failure doesn't abort the batch.
 */

const AUTO_CANCEL_UNPAID_DAYS = Number(process.env.AUTO_CANCEL_UNPAID_DAYS) || 2;
const RUN_CAP = 500;

/**
 * Sleep-after-success throttle between provider status calls (ms).
 *
 * Every order with a gateway payment row costs one outbound provider request,
 * so a 500-order backlog is a 500-request burst at 4 different providers, all
 * of which rate-limit. Pace the loop instead of discovering the limit via 429s
 * (the measured-RPM pattern — throttle on success, don't retry on rejection).
 * COD / payment-link-less orders never reach the call and are not delayed.
 */
const RECONCILE_THROTTLE_MS = Number(process.env.AUTO_CANCEL_RECONCILE_THROTTLE_MS) || 250;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Outcome of the pre-cancel reconciliation for a single order. */
type ReconcileOutcome =
  /** Provider confirmed payment — order is now paid. Do NOT cancel. */
  | { action: 'rescued' }
  /** No gateway payment to check, or provider says not paid. Cancel it. */
  | { action: 'cancel' }
  /** Couldn't get a trustworthy answer. Leave it pending; retry tomorrow. */
  | { action: 'skip'; reason: string }
  /**
   * The provider says PAID but the order already left `pending` (cancelled /
   * refunded by staff) — captured money that is NOT recorded on the order
   * (issue 2134 / issue 2136 / issue 2143). Never folded into `skip`: it is
   * the opposite of "provider unreachable" and needs a human, loudly.
   */
  | { action: 'stale_confirmed'; code: string };

/** What the sweep should do with one stale unpaid order. */
export type AutoCancelDecision = 'reconcile_paid' | 'cancel' | 'skip';

/**
 * The whole rescue-vs-cancel-vs-skip decision, as a pure function.
 *
 * Extracted (matching the `webhook-offload.guard.ts` / `bulk-import` pattern in
 * this directory) so the money-critical branch is unit-testable without
 * standing up Inngest steps, RLS context, or a provider HTTP client.
 *
 * The ordering matters and is the point of the fix:
 *   1. no gateway payment       → cancel  (COD / no link ever issued; nothing to ask)
 *   2. provider unreachable     → SKIP    (unknown ≠ unpaid — never cancel on a guess)
 *   3. provider says 'completed'→ reconcile as paid, do NOT cancel
 *   4. any other definite answer→ cancel  (failed / expired / cancelled / pending)
 *
 * Step 2 preceding step 4 is the entire safety property: an unreachable
 * provider must never fall through to the cancel branch.
 */
export function decideAutoCancelAction(input: {
  /** Order has a non-COD payment row carrying a transactionId. */
  hasGatewayPayment: boolean;
  /** False when the provider status call threw (network/credentials/outage). */
  providerReachable: boolean;
  /** Normalised provider status, when we got one. */
  providerStatus?: string;
}): AutoCancelDecision {
  if (!input.hasGatewayPayment) return 'cancel';
  if (!input.providerReachable) return 'skip';
  if (input.providerStatus === 'completed') return 'reconcile_paid';
  return 'cancel';
}

export const orderAutoCancelUnpaid: JobDef = inngest.createFunction(
  {
    id: 'order-auto-cancel-unpaid',
    name: 'Auto-cancel stale unpaid orders (daily cron)',
    retries: 2,
    concurrency: { limit: 1 },
    triggers: [{ cron: '0 3 * * *' }], // daily 03:00 UTC
  },
  async ({ step, event }) => {
    // PORTED (Ruling CF-JOBS-4): the cron lists the Postgres stores, a DO store's alarm reads its own Durable Object, rescues a
    // captured payment through the DO webhook section and cancels through the DO `cancel` (unpaid-only, one section).
    // Cross-tenant — withRlsBypass so FORCE RLS doesn't hide other tenants'
    // rows (no HTTP tenant GUC on a cron).
    const stale = await step.run('find-stale-unpaid', () => {
      // Read inside the step: the cutoff is part of the memoised read, not re-derived on replay.
      const threshold = new Date(Date.now() - AUTO_CANCEL_UNPAID_DAYS * 24 * 60 * 60 * 1000);
      return sweepStoresDb(event, {
        fetch: (storeId, db) =>
          db.order.findMany({
            where: {
              storeId,
              status: 'pending',
              // `failed` too: a declined payment keeps its units held and stays payable, nothing else closes it (INV-AUDIT-2)
              paymentStatus: { in: [...OPEN_HOLD_PAYMENT_STATUSES] },
              deletedAt: null,
              createdAt: { lt: threshold },
              // Cash on delivery is never "abandoned at the gateway": the
              // shopper pays the courier, days later. Cancelling an untouched
              // COD order at 2 days (Eid, a weekend) told a shopper who did
              // nothing wrong their order was cancelled (sense audit O6,
              // ruling MONEYB-7). COD orders leave only by the merchant's
              // cancel, a return to origin, or delivery (which settles them).
              payments: { none: { provider: 'cod' } },
            },
            select: {
              createdAt: true,
              id: true,
              storeId: true,
              orderNumber: true,
              paymentStatus: true,
              locale: true,
              // Newest gateway payment for this order. COD rows carry no
              // transactionId and no online provider, so they fall out here and
              // the order skips the provider call entirely.
              payments: {
                where: { transactionId: { not: null }, provider: { not: 'cod' } },
                select: {
                  id: true,
                  status: true,
                  provider: true,
                  metadata: true,
                  amount: true,
                  currency: true,
                  transactionId: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
            orderBy: { createdAt: 'asc' },
            take: RUN_CAP,
          }),
        orderKey: r => r.createdAt,
        take: RUN_CAP,
      });
    });

    if (stale.length === 0) {
      logger.info('order-auto-cancel-unpaid: nothing to cancel');
      return { scanned: 0, cancelled: 0, failed: 0, rescued: 0, skipped: 0, staleConfirmed: 0 };
    }

    let cancelled = 0;
    let failed = 0;
    let rescued = 0;
    let skipped = 0;
    let staleConfirmed = 0;
    const capturedOnTerminal: Array<{
      orderId: string;
      orderNumber: string;
      storeId: string;
      paymentId: string | undefined;
      provider: string | undefined;
      transactionId: string | null | undefined;
    }> = [];

    for (const order of stale) {
      const outcome: ReconcileOutcome = await step.run(`reconcile-${order.id}`, async () => {
        const payment = order.payments[0];
        const hasGatewayPayment = Boolean(payment?.transactionId);

        let providerStatus;
        let providerReachable = true;
        let unreachableReason = 'provider_status_unavailable';

        if (hasGatewayPayment) {
          try {
            providerStatus = await PaymentService.getPaymentStatus(
              payment.transactionId as string,
              payment.provider as PaymentProvider,
              order.storeId
            );
          } catch (err) {
            // FAIL-CLOSED. We asked and got no trustworthy answer, so we do not
            // know whether the customer's money was captured. Leave the order
            // pending — tomorrow's run asks again.
            providerReachable = false;
            unreachableReason = err instanceof Error ? err.message : unreachableReason;
            logger.warn(
              { err, orderId: order.id, storeId: order.storeId, provider: payment.provider },
              'order-auto-cancel-unpaid: provider status check failed — skipping cancel'
            );
          }
          // Throttle only after an actual provider call (see
          // RECONCILE_THROTTLE_MS). It MUST sit inside this step: Inngest
          // re-executes the handler body from the top at every step boundary
          // and replays memoized steps instantly, so a sleep in plain loop code
          // re-fires for every already-processed order on every pass
          // (O(n²) across a 500-order backlog) without pacing any real call.
          if (RECONCILE_THROTTLE_MS > 0) await sleep(RECONCILE_THROTTLE_MS);
        }

        const decision = decideAutoCancelAction({
          hasGatewayPayment,
          providerReachable,
          providerStatus: providerStatus?.status,
        });

        if (decision === 'skip') {
          return { action: 'skip', reason: unreachableReason } as ReconcileOutcome;
        }

        if (decision === 'reconcile_paid' && providerStatus) {
          // The money WAS captured and every push path missed it. Route through
          // the shared single-writer so this transitions identically to a
          // webhook / verify-on-return confirmation and fans out exactly once.
          const doMoney = await storeMoney(order.storeId);
          const staleConfirm = await (
            doMoney
              ? PaymentService.applyCapturedStatusOnDo(
                  order.storeId,
                  {
                    provider: payment.provider,
                    transactionId: payment.transactionId as string,
                    amount: payment.amount,
                    currency: payment.currency,
                  },
                  providerStatus
                )
              : runInTenantContext(order.storeId, () =>
                  confirmPaymentFromProviderStatus({
                    payment: {
                      id: payment.id,
                      status: payment.status,
                      provider: payment.provider,
                      metadata: payment.metadata,
                      amount: payment.amount,
                      currency: payment.currency,
                    },
                    order: {
                      id: order.id,
                      storeId: order.storeId,
                      paymentStatus: order.paymentStatus,
                      locale: order.locale,
                    },
                    providerStatus,
                    source: 'auto_cancel_sweep',
                    triggeredByUserId: null,
                  })
                )
          ).then(
            () => null,
            (err: unknown) => {
              if (err instanceof AppError && err.code === 'INVALID_STATUS_TRANSITION') {
                return { code: err.code };
              }
              throw err;
            }
          );
          if (staleConfirm) {
            logger.error(
              {
                orderId: order.id,
                orderNumber: order.orderNumber,
                storeId: order.storeId,
                paymentId: payment.id,
                provider: payment.provider,
                code: staleConfirm.code,
              },
              'order-auto-cancel-unpaid: provider reports PAID but the order is no longer pending — captured money is unrecorded'
            );
            // Durable, UI-visible trace on the order page's payment timeline
            // (issue 2143) — the money exists at the provider even though the
            // order and payment rows say it does not.
            await recordPaymentEventForStore({
              paymentId: payment.id,
              storeId: order.storeId,
              orderId: order.id,
              eventType: 'reconciliation',
              provider: payment.provider,
              details: {
                reason: 'provider_paid_on_terminal_order',
                source: 'auto_cancel_sweep',
                providerStatus: providerStatus.status,
                transactionId: payment.transactionId,
                amount: payment.amount,
                note: 'Provider reports this payment captured, but the order had already left pending. Check the provider and refund the customer if the order stays cancelled.',
              },
            });
            return { action: 'stale_confirmed', code: staleConfirm.code } as ReconcileOutcome;
          }

          logger.warn(
            {
              orderId: order.id,
              orderNumber: order.orderNumber,
              storeId: order.storeId,
              provider: payment.provider,
            },
            'order-auto-cancel-unpaid: RESCUED — provider reports paid, order was about to be cancelled'
          );
          return { action: 'rescued' } as ReconcileOutcome;
        }

        // Provider gave a definite not-paid answer (failed/expired/cancelled/
        // pending). The link is dead past the threshold — cancel is correct.
        return { action: 'cancel' } as ReconcileOutcome;
      });

      if (outcome.action === 'rescued') {
        rescued += 1;
      } else if (outcome.action === 'stale_confirmed') {
        staleConfirmed += 1;
        const p = order.payments[0];
        capturedOnTerminal.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId: order.storeId,
          paymentId: p?.id,
          provider: p?.provider,
          transactionId: p?.transactionId,
        });
      } else if (outcome.action === 'skip') {
        skipped += 1;
      } else {
        const ok = await step.run(`cancel-${order.id}`, async () => {
          try {
            // updateStatus reads + writes the order via Prisma — run it inside the
            // order's tenant context so FORCE RLS policies (read + write) are
            // satisfied on this non-HTTP cron path.
            // The row lock + re-check make the cancel atomic with a payment landing: a webhook that paid the order
            // after this run's provider answer ('expired') either commits first (the order is paid: not cancelled)
            // or waits and finds it cancelled (its claim is then blocked and raised loudly). confirmed -> cancelled is
            // an allowed transition, so without this a freshly PAID order was cancelled.
            const doMoney = await storeMoney(order.storeId);
            const cancelled = doMoney
              ? // The Durable Object checks "still unpaid" and cancels in ONE section (Postgres: SELECT ... FOR UPDATE);
                // the normal cancel tail (refund fanout, status fanout, push) runs inside `updateStatus`.
                await OrderService.updateStatus(order.storeId, order.id, 'cancelled', {
                  unpaidOnly: true,
                }).then(
                  () => true,
                  (err: { code?: string }) => {
                    if (err?.code === 'ORDER_ALREADY_PAID') return false;
                    throw err;
                  }
                )
              : await runInTenantContext(order.storeId, async () => {
                  const rows = await prisma.$queryRaw<
                    Array<{ status: string; payment_status: string }>
                  >`
                SELECT status::text AS status, payment_status::text AS payment_status
                  FROM orders WHERE id = ${order.id} AND store_id = ${order.storeId} FOR UPDATE`;
                  const cur = rows[0];
                  if (!cur || cur.payment_status === 'paid' || cur.payment_status === 'refunded')
                    return false;
                  await OrderService.updateStatus(order.storeId, order.id, 'cancelled');
                  return true;
                });
            if (!cancelled) {
              logger.warn(
                { orderId: order.id, storeId: order.storeId },
                'order-auto-cancel-unpaid: order was paid while the sweep ran; not cancelled'
              );
            }
            return cancelled;
          } catch (err) {
            logger.error(
              { err, orderId: order.id, storeId: order.storeId },
              'order-auto-cancel-unpaid: failed to cancel order'
            );
            return false;
          }
        });
        if (ok) cancelled += 1;
        else failed += 1;
      }
    }

    // Captured money on an order that is no longer pending (issue 2134 /
    // issue 2136 / issue 2143): its OWN P1, naming every order, because no
    // merchant surface can act on it (a cancelled + unpaid order shows no
    // refund or status action) and the pre-#763 behaviour (a failed run) was
    // the only thing that used to make a human look.
    if (staleConfirmed > 0) {
      void sendAlert({
        level: 'p1',
        scope: 'platform',
        source: 'order.auto_cancel.captured_on_terminal_order',
        title: 'Provider reports PAID on an order that is no longer pending',
        body:
          `${staleConfirmed} order(s): the payment provider reports the payment CAPTURED, but the ` +
          `order had already left pending (cancelled or refunded), so the capture is recorded ` +
          `nowhere on the order. Check each in the provider dashboard and refund the customer ` +
          `if the order stays cancelled. A 'reconciliation' event is on each order's payment timeline.`,
        context: { orders: capturedOnTerminal.slice(0, 20) },
      }).catch(() => undefined);
    }

    // A rescue means real money was captured with every push path missed — the
    // merchant needs to know their fulfilment queue just gained an order, and
    // repeated rescues point at a broken webhook config rather than bad luck.
    // A skip means we could not reach a provider at all; one is noise, a
    // persistent count is an outage holding real orders in limbo. (Stale
    // confirms are NOT skips — see the alert above.)
    if (rescued > 0 || skipped > 0) {
      void sendAlert({
        level: rescued > 0 ? 'p1' : 'info',
        scope: 'platform',
        source: 'order.auto_cancel.reconciliation',
        title: 'order.auto_cancel.reconciliation',
        body:
          `Auto-cancel sweep: ${rescued} order(s) were confirmed PAID by the provider and ` +
          `rescued from cancellation; ${skipped} order(s) were skipped because the provider ` +
          `could not be reached. Repeated rescues indicate a webhook that is not firing.`,
        context: { scanned: stale.length, cancelled, failed, rescued, skipped },
      }).catch(() => undefined);
    }

    logger.info(
      {
        scanned: stale.length,
        cancelled,
        failed,
        rescued,
        skipped,
        staleConfirmed,
        thresholdDays: AUTO_CANCEL_UNPAID_DAYS,
      },
      'order-auto-cancel-unpaid completed'
    );
    return { scanned: stale.length, cancelled, failed, rescued, skipped, staleConfirmed };
  }
);
