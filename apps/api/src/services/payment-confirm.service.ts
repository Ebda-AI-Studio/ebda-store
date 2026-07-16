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
 *      primary confirmation path, because MyFatoorah's webhook is
 *      configured account-level in their portal and never fires per-invoice.
 *
 * Callers (2) and (3) both call `confirmPaymentFromProviderStatus`, so the
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

import { prisma, runInTenantContext } from '@force/database';
import type { PaymentStatus } from '@force/database';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { OneSignalService } from './onesignal.service';
import { recordPaymentEvent } from './payment-event.service';
import type { PaymentStatusResponse } from './payment-providers/types';
import { invalidateCustomersCache } from '../lib/public-cache';
import { assertValidTransition } from './order-status-machine';

export type ConfirmSource = 'admin_refresh' | 'guest_verify';

/** Money-integrity F3 (2026-07-02 audit): reconciliation tolerance for a
 *  provider-reported paid amount vs the expected `Payment.amount`. Both
 *  sides are in fils (see `PaymentService.createPayment`, which stores
 *  `amount: request.amount === order.total`, and every provider's
 *  `parseWebhook`/`getPaymentStatus`, which convert to fils via
 *  `Math.round(x * 1000)`). 5 fils absorbs float/rounding noise without
 *  masking a real underpayment. */
const AMOUNT_TOLERANCE_FILS = 5;

export interface ConfirmPaymentInput {
  /** The Payment row to reconcile (must carry a transactionId). */
  payment: {
    id: string;
    status: string;
    provider: string;
    metadata: unknown;
    /** Expected amount in fils (mirrors order.total at payment creation) —
     *  required for the paid-amount reconciliation gate below. */
    amount: number;
    /** Payment.currency (default 'KWD'). Used only to gate the amount
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

  // Determine whether this is a genuine transition vs a redundant call.
  // We compare against the ORDER's current paymentStatus (the durable
  // signal a customer/merchant sees) so a duplicate verify or a webhook
  // that arrives after a verify is a no-op the second time. This is the
  // idempotency guard for the pull-side paths.
  const statusChanged =
    status === 'completed'
      ? order.paymentStatus !== 'paid'
      : status === 'failed' || status === 'expired' || status === 'cancelled'
        ? order.paymentStatus !== 'failed'
        : false;

  if (status === 'completed') {
    if (!statusChanged) {
      // Already paid — nothing to do. Never re-fire the fanout.
      return { paymentStatus: 'paid', providerStatus: status, statusChanged: false };
    }

    // Paid-amount reconciliation (money-integrity audit F3, 2026-07-02).
    // The provider says the invoice is "Paid", but that alone doesn't prove
    // the AMOUNT paid matches what we expect. `providerStatus.paidAmount`
    // (fils) is only populated by providers that distinguish invoiced vs
    // settled amount (currently MyFatoorah's GetPaymentStatus —
    // `PaidCurrencyValue`); Tap/Hesabe/UPayments never set it. Only gate
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

      const alertStore = await prisma.store
        .findUnique({ where: { id: order.storeId }, select: { name: true } })
        .catch(() => null);
      void sendAlert({
        level: 'p0',
        scope: 'store',
        store: { id: order.storeId, name: alertStore?.name ?? order.storeId },
        source: 'payment.confirm.amount_mismatch',
        title: 'payment.confirm.amount_mismatch',
        body: `Order ${order.id}: ${payment.provider} reports paid ${paidAmount} fils but the order total is ${payment.amount} fils. Order was NOT marked as paid — investigate before fulfilling.`,
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
      where: { id: order.id },
      select: { status: true },
    });
    if (!currentOrder) throw new Error(`Order ${order.id} not found during confirmation`);
    assertValidTransition(currentOrder.status, 'confirmed');

    await prisma.$transaction([
      prisma.payment.update({
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
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { status: 'confirmed', paymentStatus: 'paid' },
      }),
    ]);

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
    void runInTenantContext(order.storeId, async () => {
      const detail = await prisma.order.findUnique({
        where: { id: order.id },
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
    );

    return { paymentStatus: 'paid', providerStatus: status, statusChanged: true };
  }

  if (status === 'failed' || status === 'expired' || status === 'cancelled') {
    if (!statusChanged) {
      return { paymentStatus: 'failed', providerStatus: status, statusChanged: false };
    }

    await prisma.$transaction([
      prisma.payment.update({
        where: { id: payment.id },
        data: { status },
      }),
      prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'failed' },
      }),
    ]);

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
