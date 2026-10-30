/**
 * payment-confirm.service.ts
 *
 * Single source of truth for "the provider told us this invoice is PAID
 * (or failed) — reconcile our Order + Payment rows and run the
 * post-payment fanout exactly once".
 *
 * Three callers reach the same provider-status → DB-state transition:
 *   1. The webhook handler (`PaymentService.handleWebhook`) — the canonical
 *      push path. It keeps its own inline logic because it also handles
 *      refunds, HMAC verification, and route-level idempotency.
 *   2. The admin "Refresh payment" button
 *      (`POST /stores/:storeId/orders/:orderId/refresh-payment-status`).
 *   3. The GUEST verify-on-return endpoint
 *      (`POST /public/orders/:orderId/verify-payment`) — the reliable
 *      primary confirmation path, because a gateway's webhook can be
 *      configured account-level in their portal and never fires per-invoice.
 *   4. The auto-cancel sweep (`order-auto-cancel-unpaid`) — the last-resort
 *      net. Before cancelling a stale unpaid order it asks the provider, and
 *      a `completed` answer rescues the order instead of cancelling it. This
 *      is the only path that catches an order where the webhook was lost AND
 *      the customer never returned to the success page.
 *
 * Callers (2), (3) and (4) all call `confirmPaymentFromProviderStatus`, so the
 * pull-side reconciliation logic lives in ONE place.
 *
 * IDEMPOTENCY (money code — mandatory): the function is safe to call
 * repeatedly for the same payment. It compares the provider-reported
 * status against the order's CURRENT `paymentStatus` and only writes +
 * fans out on a real transition. A later webhook landing AFTER a verify
 * call (or two concurrent verify calls) is a no-op the second time — the
 * `order/created` Inngest event (which itself has concurrency-keyed
 * idempotency) is only enqueued on the first transition into `paid`.
 */

import { prisma, runInTenantContext, withStore } from '@ebda/database';
import type { PaymentStatus } from '@ebda/database';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { CardTestingGuard } from './card-testing-guard.service';
import { OneSignalService } from './onesignal.service';
import { recordPaymentEvent } from './payment-event.service';
import type { PaymentStatusResponse } from './payment-providers/types';
import { recordPaymentSettled } from './provider-verification.service';
import { invalidateCustomersCache } from '../lib/public-cache';
import { cfWaitUntil } from '../cf/bindings';
import { assertValidTransition } from './order-status-machine';
import { sendEventAfterCommit } from '../lib/inngest/send-after-commit';
import { CI_PAYMENT_FAILED_EVENT } from '../lib/ci/events';
import { claimOrderFailed, claimOrderPaid, lockPaymentRow } from './payment-state-claims';

/**
 * Which pull-side path asked the provider for this status.
 *
 * Both `eventType` branches below classify anything that isn't `admin_refresh`
 * as a `reconciliation` (we asked the provider; the provider did not push to
 * us), so adding a non-human source needs no change at either branch site —
 * `auto_cancel_sweep` is a reconciliation by exactly that definition.
 */
export type ConfirmSource = 'admin_refresh' | 'guest_verify' | 'auto_cancel_sweep';

/** Money-integrity F3 (2026-07-02 audit): reconciliation tolerance for a
 *  provider-reported paid amount vs the expected `Payment.amount`. Both
 *  sides are in piastres (see `PaymentService.createPayment`, which stores
 *  `amount: request.amount === order.total`, and every provider's
 *  `parseWebhook`/`getPaymentStatus`, which convert to piastres via
 *  `Math.round(x * 100)` for a 2-decimal currency). 5 piastres (0.05 EGP)
 *  absorbs float/rounding noise without masking a real underpayment — the same
 *  5-minor-unit noise bound Ebda used, deliberately NOT re-tuned in the EGP
 *  conversion (it is a rounding allowance, not a money value). */
const AMOUNT_TOLERANCE_FILS = 5;

export interface ConfirmPaymentInput {
  /** The Payment row to reconcile (must carry a transactionId). */
  payment: {
    id: string;
    status: string;
    provider: string;
    metadata: unknown;
    /** Expected amount in piastres (mirrors order.total at payment creation) —
     *  required for the paid-amount reconciliation gate below. */
    amount: number;
    /** Payment.currency (default 'EGP'). Used only to gate the amount
     *  reconciliation to same-currency comparisons — see below. */
    currency?: string;
  };
  /** The Order the payment belongs to. */
  order: {
    id: string;
    storeId: string;
    paymentStatus: string;
    locale?: string | null;
  };
  /** The status the provider just reported (from getPaymentStatus). */
  providerStatus: PaymentStatusResponse;
  /** Who/what triggered this reconciliation — drives the audit metadata. */
  source: ConfirmSource;
  /** Admin user id when source === 'admin_refresh'; null for guest. */
  triggeredByUserId?: string | null;
}

export interface ConfirmPaymentResult {
  /** Normalised order paymentStatus after reconciliation. */
  paymentStatus: 'paid' | 'failed' | 'unpaid';
  /** Raw provider status ('completed' | 'failed' | 'expired' | 'pending' | ...). */
  providerStatus: string;
  /** True when this call performed a real state transition + fanout. */
  statusChanged: boolean;
}

/**
 * Reconcile an order against a freshly-fetched provider payment status.
 *
 * Mirrors the webhook handler's state machine:
 *   completed              → order.status=confirmed, paymentStatus=paid + order/created fanout
 *   failed | expired       → order.paymentStatus=failed (no fanout)
 *   cancelled              → treated as failed
 *   pending | processing   → no change
 */
export async function confirmPaymentFromProviderStatus(
  input: ConfirmPaymentInput
): Promise<ConfirmPaymentResult> {
  const { payment, order, providerStatus, source, triggeredByUserId = null } = input;
  const status = providerStatus.status;

  // InstaPay has no provider to ask: the ONLY thing that confirms it is the
  // merchant's confirm (InstapayService.confirm). A pull-side reconciliation must
  // never mark such an order paid, whatever a caller passes in.
  if (payment.provider === 'instapay') {
    return {
      paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'unpaid',
      providerStatus: status,
      statusChanged: false,
    };
  }

  // Determine whether this is a genuine transition vs a redundant call.
  // We compare against the ORDER's current paymentStatus (the durable
  // signal a customer/merchant sees) so a duplicate verify or a webhook
  // that arrives after a verify is a no-op the second time. This is the
  // idempotency guard for the pull-side paths.
  const statusChanged =
    status === 'completed'
      ? order.paymentStatus !== 'paid'
      : status === 'failed' || status === 'expired' || status === 'cancelled'
        ? order.paymentStatus === 'unpaid' // a paid / refunded / disputed order never becomes failed (M-064)
        : false;

  if (status === 'completed') {
    if (!statusChanged) {
      // Already paid — nothing to do. Never re-fire the fanout.
      return { paymentStatus: 'paid', providerStatus: status, statusChanged: false };
    }

    // Paid-amount reconciliation (money-integrity audit F3, 2026-07-02).
    // The provider says the invoice is "Paid", but that alone doesn't prove
    // the AMOUNT paid matches what we expect. `providerStatus.paidAmount`
    // (piastres) is only populated by providers that distinguish invoiced vs
    // settled amount (`paidAmount` on the status answer); a gateway that does not send it leaves it unset. Only gate
    // when it's actually present + parseable and the currencies line up —
    // never block on missing/ambiguous data, since a false block here
    // would hold a legitimately-paid customer's order hostage.
    const paidAmount = providerStatus.paidAmount;
    const sameCurrency =
      !providerStatus.paidCurrency || !providerStatus.currency
        ? true
        : providerStatus.paidCurrency === providerStatus.currency;
    if (
      typeof paidAmount === 'number' &&
      Number.isFinite(paidAmount) &&
      typeof payment.amount === 'number' &&
      sameCurrency &&
      Math.abs(payment.amount - paidAmount) > AMOUNT_TOLERANCE_FILS &&
      paidAmount < payment.amount
    ) {
      logger.error(
        {
          paymentId: payment.id,
          orderId: order.id,
          expectedFils: payment.amount,
          paidAmountFils: paidAmount,
          source,
        },
        '[PAYMENT CONFIRM] provider-reported paid amount is less than expected — holding order unpaid'
      );

      await recordPaymentEvent({
        paymentId: payment.id,
        storeId: order.storeId,
        orderId: order.id,
        eventType: 'reconciliation',
        fromStatus: payment.status as PaymentStatus,
        toStatus: null,
        provider: payment.provider,
        triggeredByUserId,
        details: {
          source,
          reason: 'paid_amount_mismatch',
          expectedFils: payment.amount,
          paidAmountFils: paidAmount,
          providerStatus: status,
        },
      });

      const alertStore = await withStore(order.storeId, tx =>
        tx.store.findUnique({ where: { id: order.storeId }, select: { name: true } })
      ).catch(() => null);
      void sendAlert({
        level: 'p0',
        scope: 'store',
        store: { id: order.storeId, name: alertStore?.name ?? order.storeId },
        source: 'payment.confirm.amount_mismatch',
        title: 'payment.confirm.amount_mismatch',
        body: `Order ${order.id}: ${payment.provider} reports paid ${paidAmount} piastres but the order total is ${payment.amount} piastres. Order was NOT marked as paid — investigate before fulfilling.`,
        context: {
          orderId: order.id,
          paymentId: payment.id,
          provider: payment.provider,
          expectedFils: payment.amount,
          paidAmountFils: paidAmount,
          source,
        },
      }).catch(() => undefined);

      // Leave the order/payment exactly as they are — do NOT transition to
      // paid/confirmed, do NOT run the post-payment fanout.
      return {
        paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'unpaid',
        providerStatus: status,
        statusChanged: false,
      };
    }

    // Guard the order-status flip: a STALE provider confirmation on an order
    // that has since moved to a terminal state (refunded/cancelled) must not
    // regress it to 'confirmed'. Re-read the CURRENT status (the passed-in
    // `order` snapshot may be stale by the time we settle). pending→confirmed
    // (normal) and confirmed→confirmed (no-op) pass; refunded/cancelled throw.
    const currentOrder = await prisma.order.findUnique({
      where: { id: order.id, storeId: order.storeId },
      select: { status: true },
    });
    if (!currentOrder) throw new Error(`Order ${order.id} not found during confirmation`);
    // An order already past confirmation (processing / shipped / delivered) is marked PAID without moving its
    // fulfilment status; only a terminal order (cancelled / refunded) is refused here.
    if (!['processing', 'shipped', 'delivered'].includes(currentOrder.status)) {
      assertValidTransition(currentOrder.status, 'confirmed');
    }

    // ONE conditional update decides who confirms (M-049): the snapshot above can be stale, a webhook may
    // have paid the order in between. Only the caller that wins the claim writes the payment row and fans out.
    await lockPaymentRow(payment.id);
    const claim = await claimOrderPaid(order.id, order.storeId);
    if (claim === 'blocked_status') {
      // The order went terminal (cancelled / refunded) between the status read and the claim. Raise what the
      // earlier check would have: the auto-cancel sweep turns INVALID_STATUS_TRANSITION into its durable
      // "captured money on a terminal order" trace and P1. A quiet return here would lose that.
      const now = await prisma.order.findUnique({
        where: { id: order.id, storeId: order.storeId },
        select: { status: true },
      });
      logger.error(
        { paymentId: payment.id, orderId: order.id, source, status: now?.status },
        '[PAYMENT CONFIRM] provider says paid but the order is no longer confirmable — not flipped'
      );
      assertValidTransition(now?.status ?? 'cancelled', 'confirmed');
      return { paymentStatus: 'unpaid', providerStatus: status, statusChanged: false };
    }
    if (claim !== 'claimed') {
      return { paymentStatus: 'paid', providerStatus: status, statusChanged: false };
    }
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'completed',
        paidAt: providerStatus.paidAt ?? new Date(),
        metadata: {
          ...((payment.metadata as object) || {}),
          confirmedVia: source,
          ...(triggeredByUserId ? { confirmedBy: triggeredByUserId } : {}),
          confirmedAt: new Date().toISOString(),
        },
      },
    });

    // Bust the admin aggregated-customers snapshot — this paymentStatus
    // transition changes the paid/total-spent counts it aggregates.
    await invalidateCustomersCache(order.storeId);

    await recordPaymentEvent({
      paymentId: payment.id,
      storeId: order.storeId,
      orderId: order.id,
      // Admin refresh is an explicit human action; guest verify-on-return is
      // a pull-side settlement reconciliation (we asked the provider, not the
      // provider pushing to us) — categorise accordingly. The `source` detail
      // disambiguates within each bucket.
      eventType: source === 'admin_refresh' ? 'admin_action' : 'reconciliation',
      fromStatus: payment.status as PaymentStatus,
      toStatus: 'completed',
      provider: payment.provider,
      triggeredByUserId,
      details: { source, reason: 'provider_status_confirmed_paid', providerStatus: status },
    });

    // Fire the SAME post-payment fanout the webhook handler does so
    // notifications (email + admin push + WhatsApp) + accounting + loyalty
    // catch up on the missed webhook. The Inngest function is
    // concurrency-keyed per store with its own idempotency, so even if a
    // delayed webhook ALSO enqueues order/created, it won't double-send.
    inngest
      .send({
        name: 'order/created',
        data: {
          orderId: order.id,
          storeId: order.storeId,
          paymentMethod: payment.provider,
          locale: order.locale ?? undefined,
        },
      })
      .catch((err: unknown) =>
        logger.error(
          { err, orderId: order.id, source },
          '[PAYMENT CONFIRM] Failed to enqueue post-payment order/created'
        )
      );

    // Distinct "Payment received" merchant push, fired ONLY on this real
    // pending→paid transition (we're inside the statusChanged branch — the
    // !statusChanged early-return above guards re-firing). This is the answer
    // to "did the resent / stuck payment link get paid?": the merchant gets a
    // clear "Payment received" ping the moment the money lands, separate from
    // the "New order" push that fired at order creation.
    //
    // COD never reaches here (no provider confirm step), so this never
    // double-fires for cash orders. Fire-and-forget inside runInTenantContext
    // so the order lookup survives FORCE RLS (no HTTP middleware on the admin
    // refresh / guest verify paths' provider callbacks) and a push glitch
    // never affects the reconciliation result we return to the caller.
    // `cfWaitUntil`: a bare floating promise is cancelled with the response on a Worker.
    cfWaitUntil(
      runInTenantContext(order.storeId, async () => {
        const detail = await prisma.order.findUnique({
          where: { id: order.id, storeId: order.storeId },
          select: {
            orderNumber: true,
            total: true,
            currency: true,
            customer: { select: { firstName: true, lastName: true, email: true } },
            shippingAddress: true,
          },
        });
        if (!detail) return;
        const shippingAddress = detail.shippingAddress as Record<string, unknown> | null;
        const guestFirstName =
          typeof shippingAddress?.firstName === 'string' ? shippingAddress.firstName : '';
        const guestLastName =
          typeof shippingAddress?.lastName === 'string' ? shippingAddress.lastName : '';
        const customerName =
          `${detail.customer?.firstName || guestFirstName} ${detail.customer?.lastName || guestLastName}`.trim() ||
          detail.customer?.email ||
          'Customer';
        const store = await prisma.store
          .findUnique({ where: { id: order.storeId }, select: { name: true } })
          .catch(() => null);
        await OneSignalService.notifyAdminsOfPaymentSuccess({
          orderId: order.id,
          orderNumber: detail.orderNumber,
          storeId: order.storeId,
          storeName: store?.name ?? order.storeId,
          customerName,
          total: detail.total,
          currency: detail.currency,
          paymentMethod: payment.provider,
        });
      }).catch((err: unknown) =>
        logger.error(
          { err, orderId: order.id, source },
          '[PAYMENT CONFIRM] payment-received push failed'
        )
      )
    );

    // PROVIDERS-3: a real payment settled through this provider (evidence for auto-verify).
    void recordPaymentSettled({
      storeId: order.storeId,
      provider: payment.provider,
      paymentId: payment.id,
    });
    return { paymentStatus: 'paid', providerStatus: status, statusChanged: true };
  }

  if (status === 'failed' || status === 'expired' || status === 'cancelled') {
    if (!statusChanged) {
      // Report the order's REAL state: a paid (or since-refunded / disputed) order must not read as failed.
      return {
        paymentStatus: order.paymentStatus === 'failed' ? 'failed' : 'paid',
        providerStatus: status,
        statusChanged: false,
      };
    }

    // Conditional (M-064): re-decided against the CURRENT order row, so a webhook that paid it after our
    // snapshot (or an admin Refresh on a paid order) can never turn it into `failed`.
    await lockPaymentRow(payment.id);
    const failedClaim = await claimOrderFailed(order.id, order.storeId);
    if (failedClaim !== 'claimed') {
      return {
        paymentStatus: failedClaim === 'already_failed' ? 'failed' : 'paid',
        providerStatus: status,
        statusChanged: false,
      };
    }
    await prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: { notIn: ['completed', 'refunded', 'partially_refunded', 'disputed'] },
      },
      data: { status },
    });

    // CI-13: only the call that won the `unpaid -> failed` claim reports the outcome (never blocks the confirm).
    await sendEventAfterCommit(
      'ci-payment-failed',
      {
        name: CI_PAYMENT_FAILED_EVENT,
        data: {
          storeId: order.storeId,
          orderId: order.id,
          paymentId: payment.id,
          kind: status,
          at: new Date().toISOString(),
        },
      },
      { ifUnhookable: 'send' }
    );

    // Bust the admin aggregated-customers snapshot — this paymentStatus
    // transition changes the paid/failed counts it aggregates.
    await invalidateCustomersCache(order.storeId);

    await recordPaymentEvent({
      paymentId: payment.id,
      storeId: order.storeId,
      orderId: order.id,
      eventType: source === 'admin_refresh' ? 'admin_action' : 'reconciliation',
      fromStatus: payment.status as PaymentStatus,
      toStatus: status,
      provider: payment.provider,
      triggeredByUserId,
      details: { source, reason: 'provider_status_confirmed_failed', providerStatus: status },
    });

    // Card-testing bookkeeping (SP5 task 4): a confirmed DECLINE (not cancelled /
    // expired). Idempotent per payment, so a webhook that already counted it is
    // not counted twice.
    if (status === 'failed') {
      void CardTestingGuard.recordDecline({
        storeId: order.storeId,
        orderId: order.id,
        paymentId: payment.id,
      });
    }

    return { paymentStatus: 'failed', providerStatus: status, statusChanged: true };
  }

  // pending / processing / unknown — no change. The customer can refresh
  // again; the merchant's Refresh button remains the manual backstop.
  return {
    paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'unpaid',
    providerStatus: status,
    statusChanged: false,
  };
}
