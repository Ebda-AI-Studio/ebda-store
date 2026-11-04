import type { JobDef } from '../../jobs/types';
import { customerRow, isLiveCustomer } from '../../customer-directory';

/** The customer to mail: a DO-served store's customer comes from its DO and only when still active (N-9); else Postgres. */
async function customerOf(storeId: string, id: string) {
  const doRow = await customerRow(storeId, id);
  if (doRow !== undefined) return doRow && isLiveCustomer(doRow) ? doRow : null;
  return withStore(storeId, tx => tx.user.findFirst({ where: { id } }));
}
import { prisma, runInTenantContext, withStore, type OrderStatus } from '@ebda/database';
import { runInStoreCtx, withStoreDb } from '../../jobs/store-db';
import { storeDb, storeMoney } from '../../repo-factory';
import { groupOrderLinesForDisplay } from '@ebda/shared';
import { EmailService } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { LoyaltyService } from '../../../services/loyalty.service';
import { affiliateService } from '../../../services/affiliate.service';
import logger from '../../logger';
import { inngest } from '../client';
import { resolveOrderInvoiceRecipient } from '../../order-notification-address';

/**
 * Fans out the post-purchase side effects of an order STATUS transition
 * (confirmed / shipped / delivered / cancelled / refunded). Builder Reality
 * Audit Lens E, finding E2-4.
 *
 * Before this, `OrderService.updateStatus()` fired ~13 side effects
 * (payment-success / shipped / admin-refund emails, WhatsApp/SMS/push dispatch,
 * affiliate commission, loyalty award, shipping-carrier auto-create) as
 * in-process fire-and-forget `.catch(log)` calls — if Resend/OneSignal/etc. was
 * down, or the process redeployed mid-flight, the side effect was lost with only
 * a Pino line: no retry, no alert, no record. This mirrors what
 * `order-created-fanout` already does for the create path: each side effect is a
 * retriable `step.run`, and the whole run re-throws on any exhausted failure so
 * `alerts-failure-watch` dead-letters it.
 *
 * Money reversal (`applyRefundEffects`) and the real-time socket ping stay
 * inline in `updateStatus` — the former is awaited money state, the latter is a
 * fast in-process emit. The existing `order/delivered` event
 * (consumed by the 7-day review-request job) is unchanged;
 * this new `order/status-changed` event carries only the migrated side effects.
 */
interface FanoutStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleOrderStatusChanged(
  orderId: string,
  storeId: string,
  status: string,
  hadCapturedPayment: boolean,
  step: FanoutStep
): Promise<{ skipped?: string; ran: string[] }> {
  if (!orderId || !storeId) {
    logger.warn({ orderId, storeId }, 'order/status-changed fired without ids — skipping');
    return { skipped: 'missing-ids', ran: [] };
  }

  // Claim THIS transition before any side effect (#558). updateStatus re-nulls
  // `statusFanoutClaimedAt` with every transition, so exactly one fanout run
  // per transition gets count=1: a duplicate event for the same transition
  // (two racing updateStatus calls, the inline fallback after a delayed send,
  // a stuck-sweep re-send that crossed the original) no-ops instead of sending
  // every email and dispatch twice. `status` must still be the order's status:
  // an event whose transition was superseded or rolled back claims nothing.
  // Memoized as a step, so Inngest retries of the claimant still re-run its
  // failed side effects. The UPDATE also waits on the order row lock, so it
  // cannot claim before the request that changed the status has committed.
  // PORTED (Ruling CF-JOBS-4): a store on its Durable Object claims and completes the transition in one section there, and
  // reads its order from the DO (its customer is an identity row, read from the platform).
  const money = await storeMoney(storeId);
  const claim = await step.run('claim-status-fanout', async () =>
    money
      ? { count: (await money.statusFanoutClaim({ orderId, status })).claimed ? 1 : 0 }
      : runInTenantContext(storeId, () =>
          prisma.order.updateMany({
            where: {
              id: orderId,
              storeId,
              status: status as OrderStatus,
              statusFanoutClaimedAt: null,
            },
            data: { statusFanoutClaimedAt: new Date() },
          })
        )
  );
  if (claim.count === 0) {
    logger.info(
      { orderId, storeId, status },
      'order/status-changed: transition already claimed or superseded — skipping'
    );
    return { skipped: 'already-claimed', ran: [] };
  }

  const order = await step.run('load-order', async () => {
    if (money) {
      const row = await (
        await storeDb(storeId)
      ).order.findUnique({ where: { id: orderId, storeId }, include: { items: true } });
      if (!row) return null;
      const customer = row.customerId ? await customerOf(storeId, row.customerId!) : null;
      return { ...row, customer };
    }
    return runInTenantContext(storeId, () =>
      prisma.order.findUnique({
        where: { id: orderId, storeId },
        include: { customer: true, items: true },
      })
    );
  });
  if (!order) {
    logger.warn({ orderId, storeId }, 'order/status-changed: order not found — skipping');
    return { skipped: 'order-not-found', ran: [] };
  }

  const orderLocale = (order.locale ?? undefined) as 'en' | 'ar' | undefined;
  const customerEmail = order.customer?.email || '';
  const customerName =
    `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
    customerEmail ||
    'Customer';
  const shippingAddrFull = order.shippingAddress as {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
  } | null;
  const customerPhone = shippingAddrFull?.phone ?? undefined;

  const store = await step.run('load-store', () =>
    // Postgres: exactly as before; a DO store has no tenant transaction to open for a platform row
    (money
      ? withStoreDb(storeId, db =>
          db.store.findUnique({ where: { id: storeId }, select: { name: true, settings: true } })
        )
      : runInTenantContext(storeId, () =>
          prisma.store.findUnique({
            where: { id: storeId },
            select: { name: true, settings: true },
          })
        )
    ).catch(() => null)
  );
  const storeName = store?.name ?? storeId;

  // Each side effect is its own retriable step; collect results and re-throw on
  // any exhausted failure so the run dead-letters (alerts-failure-watch).
  const jobs: Array<Promise<unknown>> = [];
  const ran: string[] = [];
  const add = (id: string, fn: () => Promise<unknown>) => {
    ran.push(id);
    jobs.push(step.run(id, fn));
  };

  if (status === 'delivered') {
    // affiliate_referrals/affiliates + loyalty_points/loyalty_transactions carry
    // FORCE RLS — in Inngest there's no HTTP request ALS scope, so each writer
    // MUST set the tenant GUC itself via runInTenantContext or the reads return
    // 0 rows and the WITH CHECK insert is rejected (commissions silently lost,
    // loyalty inserts dead-letter every delivered order).
    add('affiliate-commission', () =>
      runInStoreCtx(storeId, () => affiliateService.processCommission(storeId, orderId))
    );
    if (order.customerId) {
      add('loyalty-earn', () =>
        runInStoreCtx(storeId, () =>
          LoyaltyService.earnPointsFromPurchase(storeId, order.customerId!, orderId, order.total)
        )
      );
    }
    add('dispatch-delivered', () =>
      notificationDispatcher.dispatch(storeId, 'order_delivered', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName,
        locale: orderLocale,
      })
    );
  } else if (status === 'confirmed') {
    // Booking with the carrier is its own retried Inngest job (shipment-create): a carrier
    // outage must never fail or hold up this fan-out. The job checks the feature flag.
    add('auto-ship', () =>
      inngest.send({ name: 'shipment/create.requested', data: { storeId, orderId } })
    );
    if (shippingAddrFull) {
      add('email-payment-success', () =>
        EmailService.sendPaymentSuccess(
          storeId,
          {
            orderNumber: order.orderNumber,
            customerName,
            customerEmail,
            // Bundle boxes collapse to ONE row each (see
            // groupOrderLinesForDisplay) — the payment-success email must
            // show "Ramadan Box · 12.000 EGP", never the per-component
            // allocated shares that fund that one price.
            items: groupOrderLinesForDisplay(order.items).map(row =>
              row.kind === 'bundle'
                ? { name: row.name, nameAr: row.nameAr, quantity: row.quantity, price: row.total }
                : { name: row.item.productName, quantity: row.item.quantity, price: row.item.price }
            ),
            subtotal: order.subtotal,
            tax: order.tax,
            taxIncludedInPrice: order.taxIncludedInPrice,
            // Tax-invoice identity frozen at sale (ruling TAX-2); null = no VAT wording.
            sellerTaxRegistrationNumber: order.sellerTaxRegistrationNumber,
            sellerTaxLegalName: order.sellerTaxLegalName,
            taxRateBps: order.taxRateBps,
            shipping: order.shipping,
            codFee: order.codFee,
            taxableAmount: order.taxableAmount,
            total: order.total,
            currency: order.currency,
            shippingAddress: shippingAddrFull,
          },
          orderLocale
        )
      );
    }
  } else if (status === 'shipped') {
    add('email-shipped', () =>
      EmailService.sendOrderShipped(
        storeId,
        { customerEmail, customerName, orderNumber: order.orderNumber },
        orderLocale
      )
    );
    add('dispatch-shipped', () =>
      notificationDispatcher.dispatch(storeId, 'order_shipped', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName,
        locale: orderLocale,
      })
    );
  } else if (status === 'cancelled') {
    add('dispatch-cancelled', () =>
      notificationDispatcher.dispatch(storeId, 'order_cancelled', {
        customerName,
        customerPhone,
        orderNumber: order.orderNumber,
        total: order.total,
        storeId,
        storeName,
        locale: orderLocale,
      })
    );
  } else if (status === 'refunded' && hadCapturedPayment) {
    // Only notify a refund when money was actually captured (same gate as the
    // inline path — a `refunded` status on a never-paid order must not claim a
    // refund happened).
    //
    // CUSTOMER-FACING refund notifications are deliberately NOT sent here.
    // `order-refunded.ts` is the single producer of the "Refund issued" set
    // (customer email + `refund_processed` dispatch + admin push), gated by
    // the per-order `refund_notified` claim it writes under the order lock.
    // This branch used to `dispatch(storeId, 'refund_processed', …)` as well —
    // the same event key, with no claim — so a paid order cancelled first and
    // refunded afterwards told the customer TWICE: once from the fanout at the
    // cancel (which wrote the claim) and again from here at the refund, which
    // the claim cannot suppress because it doesn't gate this file.
    //
    // Removing the producer rather than making it read the claim is deliberate:
    // both events are in flight at once on a plain refund, so a claim-gated
    // branch here is a coin flip over WHICH one notifies — and this one cannot
    // send the refund EMAIL or the true refunded amount (it has no Payment
    // rows, only `order.total`). No notification is lost: `updateStatus` fires
    // `order/refunded` for EVERY cancel/refund transition before it sends this
    // event, and `shouldApplyRefundEffects` sets its `notify` flag true for
    // exactly the orders this branch is gated on (captured payment, not already
    // refunded). Gateway refunds bypass `updateStatus` entirely and are covered
    // by the same fanout.
    //
    // The admin bookkeeping email stays: it is admin-facing (not part of the
    // claimed customer set), has no counterpart in the fanout, and fires at most
    // once per order because `refunded` is terminal in the status machine
    // (`order-status-machine.ts`), so no order can re-enter this branch.
    //
    // Ruling FU46-1a: it goes to the store's order-notification address
    // (`settings.orderInvoiceEmail`) and nowhere else; never Ebda's own address.
    // No address set = no email.
    const refundTo = resolveOrderInvoiceRecipient(store?.settings);
    if (refundTo) {
      add('email-admin-refund', () =>
        EmailService.sendAdminRefund({
          to: refundTo,
          orderNumber: order.orderNumber,
          amount: order.total,
          reason: 'Order refunded',
          currency: order.currency,
        })
      );
    }
  }

  const results = await Promise.allSettled(jobs);
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected.length > 0) {
    // Index by the ORIGINAL position in results/jobs/ran — iterating the
    // filtered `rejected` subset would mislabel which step failed (e.g. report
    // the first step's name for a later step's failure).
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.error({ err: r.reason, step: ran[i] }, 'order/status-changed step failed');
      }
    });
    throw new AggregateError(
      rejected.map(r => r.reason),
      `order-status-changed-fanout (${status}): ${rejected.length}/${results.length} step(s) failed`
    );
  }

  // Completion marker (issue 2071). The claim above is a DEDUP lock taken
  // before the side effects; this stamp says they all SUCCEEDED. A claimed
  // transition that never gets it — every retry of some step failed — is what
  // order-status-fanout-stuck-sweep now reports, instead of it being invisible
  // behind its own claim. Scoped to the transition this run claimed: keyed on
  // `statusFanoutRequestedStatus`, NOT the live `status` (issue 2295). Four
  // writers move `orders.status` without re-arming (gateway refunds, refresh-
  // refund-status, payment confirm); keyed on the live status, one of them
  // landing mid-run made this match 0 rows and the sweep then paged a
  // "failed after claim" P1 for a fanout whose every step succeeded. A newer
  // `updateStatus` re-arm nulls `statusFanoutClaimedAt`, so that case still
  // matches 0 rows, correctly.
  await step.run('complete-status-fanout', async () =>
    money
      ? money.statusFanoutComplete({ orderId, status })
      : runInTenantContext(storeId, () =>
          prisma.order.updateMany({
            where: {
              id: orderId,
              storeId,
              statusFanoutRequestedStatus: status,
              statusFanoutClaimedAt: { not: null },
              statusFanoutCompletedAt: null,
            },
            data: { statusFanoutCompletedAt: new Date() },
          })
        )
  );

  return { ran };
}

export const orderStatusChanged: JobDef = inngest.createFunction(
  {
    id: 'order-status-changed-fanout',
    name: 'Order status changed — email + push + dispatcher fan-out',
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/status-changed' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, status, hadCapturedPayment } = event.data;
    return handleOrderStatusChanged(orderId, storeId, status, hadCapturedPayment === true, step);
  }
);
