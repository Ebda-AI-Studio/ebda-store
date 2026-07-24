import type { InngestFunction } from 'inngest';
import { prisma, runInTenantContext, withMoneyTx, type Prisma } from '@force/database';
import { EmailService, type OrderRefundEmailData } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { OneSignalService } from '../../../services/onesignal.service';
import { affiliateService } from '../../../services/affiliate.service';
import { LoyaltyService } from '../../../services/loyalty.service';
import { WarehouseService } from '../../../services/warehouse.service';
import logger from '../../logger';
import { inngest } from '../client';

interface FanoutStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Fans out side effects when an order is refunded — fires from
 * `OrderService.applyRefundEffects` so EVERY refund path (gateway-driven
 * webhook, admin "Refund via MyFatoorah", manual status-button) lands
 * the same reversals + customer-facing notifications without bespoke wiring
 * at each callsite.
 *
 * Money-integrity redesign (2026-07-16): `applyRefundEffects` used to run the
 * reversals INLINE inside the request's RLS transaction, where a heavy order
 * could exceed the 30s `withMoneyTx` timeout (P2028) and half-apply. The
 * reversals now live here as retriable, individually-idempotent `step.run`s
 * that run in `runInTenantContext(storeId)` (Inngest jobs have no HTTP
 * request ALS scope) and THROW on failure so Inngest retries and dead-letters
 * to `alerts-failure-watch` instead of silently losing money state.
 *
 * Mirrors `order-created.ts` shape for the notification half:
 *   - email the customer the refund confirmation
 *   - dispatch the merchant's configured notification channels
 *     (WhatsApp / SMS) with the order_refunded template
 *   - push the admin OneSignal app so the merchant sees the refund
 *     land in real-time
 *
 * Each notification side-effect is wrapped in `step.run` so an SMTP outage
 * doesn't cancel the OneSignal push or the WhatsApp send.
 *
 * Two-tier failure policy (Task 4): the 5 reversal steps above (inventory,
 * coupon, affiliate, loyalty, backorder) ALWAYS run and THROW on failure —
 * Inngest's `retries:3` re-runs them, and on exhaustion the function fails
 * and dead-letters to `alerts-failure-watch` instead of silently losing
 * money state. The notification block below is the OPPOSITE tier: it is
 * gated on `notify` (only paid, genuinely-new refunds) and swallows failures
 * via `Promise.allSettled` (best-effort — an SMTP outage must not block or
 * retry the reversals). The `notify` gate is mandatory: `order/refunded` now
 * fires for EVERY cancel/refund, including unpaid cancels where stock/coupon
 * were reserved but no money moved — without the gate, an unpaid cancel
 * would still email "Refund issued" + WhatsApp/SMS + push the merchant,
 * re-introducing the exact spurious-notification bug `order.service.ts`
 * comments say was previously fixed.
 *
 * `reconcile-warehouse-stock` (added after the reversals, right before
 * `claim-reversed`) is a THIRD, admin-view-only tier: it always runs but
 * never throws — see the fix-wave-1 comment on that step for why a
 * non-money shadow must never gate a money reversal or the completion stamp.
 */
export async function handleOrderRefunded(
  orderId: string,
  storeId: string,
  restoreInventory: boolean,
  // Gates the notification block below (paid + genuinely-new refunds only —
  // see the two-tier failure policy comment above `handleOrderRefunded`).
  notify: boolean,
  step: FanoutStep
): Promise<{ skipped?: string } | void> {
  if (!orderId || !storeId) {
    logger.warn({ orderId, storeId }, 'order/refunded fired without ids — skipping');
    return { skipped: 'missing-ids' };
  }

  // FORCE RLS: Inngest jobs run outside HTTP — no tenant context middleware.
  // Wrap every prisma call in runInTenantContext(storeId) so RLS filters correctly.
  const order = await step.run('load-order', () =>
    runInTenantContext(storeId, async () => {
      const row = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          customer: true,
          items: true,
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!row) throw new Error(`Order ${orderId} not found`);
      return row;
    })
  );

  // Restore physical stock reserved by this order. Guarded by the
  // `return_stock` InventoryHistory marker (per-order) so a retried or
  // re-delivered event never double-increments inventory. Moved verbatim
  // from the old `applyRefundEffects` inner tx — throws on failure so
  // Inngest retries instead of leaving stock un-restored.
  await step.run('restore-inventory', (): Promise<{ skipped: boolean }> => {
    if (!restoreInventory) return Promise.resolve({ skipped: true });

    return runInTenantContext(storeId, () =>
      withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
        // Order-level lock — serializes concurrent `order/refunded` deliveries
        // for the SAME order so two in-flight retries/redeliveries can't both
        // pass the marker check before either commits (double-apply). Mirrors
        // the pre-Task-1 `applyRefundEffects` lock (old order.service.ts ~1131).
        await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${orderId} FOR UPDATE`;

        const stockMarker = await tx.inventoryHistory.findFirst({
          where: { reference: orderId, type: 'return_stock', storeId },
          select: { id: true },
        });
        if (stockMarker) return { skipped: true };

        for (const item of order.items) {
          const [lockedProduct] = await tx.$queryRaw<
            Array<{ id: string; inventory: number; track_inventory: boolean }>
          >`
            SELECT id, inventory, track_inventory FROM public.products
            WHERE id = ${item.productId}
            FOR UPDATE
          `;
          if (!lockedProduct?.track_inventory) continue;
          const prevStock = lockedProduct.inventory;
          await tx.product.update({
            where: { id: item.productId },
            data: { inventory: { increment: item.quantity } },
          });
          if (item.variantId) {
            await tx.productVariant.update({
              where: { id: item.variantId },
              data: { inventory: { increment: item.quantity } },
            });
          }
          await tx.inventoryHistory.create({
            data: {
              productId: item.productId,
              storeId,
              type: 'return_stock',
              quantity: item.quantity,
              previousStock: prevStock,
              newStock: prevStock + item.quantity,
              reason: 'Order refunded',
              reference: orderId,
            },
          });
        }
        return { skipped: false };
      })
    );
  });

  // Reverse the coupon usage count consumed at checkout. Guarded by its OWN
  // `coupon_reversed` orderEvent marker (NOT the inventory `return_stock`
  // marker — restoreInventory:false calls, e.g. backorder-line cancels, or
  // orders with no tracked inventory, must still decrement the coupon exactly
  // once). Marker written IN THE SAME withMoneyTx as the decrement so a
  // retried/redelivered event never double-decrements. Order-level lock
  // matches restore-inventory above — same reasoning.
  await step.run('reverse-coupon', (): Promise<{ skipped: boolean }> => {
    if (!order.couponCode) return Promise.resolve({ skipped: true });

    return runInTenantContext(storeId, () =>
      withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${orderId} FOR UPDATE`;

        const couponMarker = await tx.orderEvent.findFirst({
          where: { storeId, orderId, toStatus: 'coupon_reversed' },
          select: { id: true },
        });
        if (couponMarker) return { skipped: true };

        // Decrement back to zero floor — concurrent refunds shouldn't push
        // usageCount negative.
        await tx.coupon.updateMany({
          where: { storeId, code: order.couponCode as string, usageCount: { gt: 0 } },
          data: { usageCount: { decrement: 1 } },
        });

        await tx.orderEvent.create({
          data: {
            storeId,
            orderId,
            fromStatus: null,
            toStatus: 'coupon_reversed',
            actorId: null,
            metadata: {},
          },
        });

        return { skipped: false };
      })
    );
  });

  // Reverse affiliate commission (no-op if none was paid for this order).
  // `reverseCommission` is already internally idempotent (only acts on a
  // `commission_paid` referral) — throws on failure so Inngest retries
  // instead of silently leaving the affiliate overpaid.
  await step.run('reverse-affiliate-commission', () =>
    runInTenantContext(storeId, () => affiliateService.reverseCommission(storeId, orderId))
  );

  // Reverse loyalty points credited at delivery + re-credit points spent at
  // checkout. No-op for guest checkout (no customerId). Both calls are
  // already idempotent via tagged adjust rows — throw on failure.
  await step.run('reverse-loyalty', async () => {
    if (!order.customerId) return { skipped: true };

    return runInTenantContext(storeId, async () => {
      await LoyaltyService.reverseEarnedPointsFromOrder(storeId, orderId);
      await LoyaltyService.reverseRedeemedPointsFromOrder(storeId, orderId);
      return { skipped: false };
    });
  });

  // Auto-cancel any open BackorderLines for this order. A refunded order will
  // never be fulfilled, so outstanding backorder demand must be released so
  // purchase-order demand planning stays accurate. Idempotent via the
  // fulfilledAt/cancelledAt null guards.
  await step.run('cancel-backorders', () =>
    runInTenantContext(storeId, () =>
      prisma.backorderLine.updateMany({
        where: { orderItem: { orderId }, fulfilledAt: null, cancelledAt: null },
        data: { cancelledAt: new Date(), cancelledReason: 'Order refunded' },
      })
    )
  );

  // Refund amount: prefer the latest payment's refundedAmount (set by
  // payment.factory.refund), fall back to order total for status-button
  // refunds where the payment row may not exist (COD / manual paid).
  const latestPayment = order.payments[0];
  const refundAmount = latestPayment?.refundedAmount || order.total;

  // Customer contact info: prefer User row, fall back to the shipping
  // address snapshot for guest orders.
  const shippingAddress = order.shippingAddress as Record<string, unknown>;
  const guestFirstName =
    typeof shippingAddress?.firstName === 'string' ? shippingAddress.firstName : '';
  const guestLastName =
    typeof shippingAddress?.lastName === 'string' ? shippingAddress.lastName : '';
  const guestEmail = typeof shippingAddress?.email === 'string' ? shippingAddress.email : '';
  const guestPhone = typeof shippingAddress?.phone === 'string' ? shippingAddress.phone : '';

  const customerName =
    `${order.customer?.firstName || guestFirstName} ${order.customer?.lastName || guestLastName}`.trim() ||
    order.customer?.email ||
    guestEmail ||
    'Customer';
  const customerEmail = order.customer?.email || guestEmail;
  const orderLocale = (order.locale ?? undefined) as 'en' | 'ar' | undefined;

  const emailData: OrderRefundEmailData = {
    orderNumber: order.orderNumber,
    customerName,
    customerEmail,
    orderTotal: order.total,
    refundAmount,
    reason:
      typeof (latestPayment?.metadata as Record<string, unknown> | null)?.refundReason === 'string'
        ? ((latestPayment?.metadata as Record<string, unknown>).refundReason as string)
        : undefined,
  };

  // Gated on `notify` — see the two-tier failure policy comment above. An
  // unpaid cancel (notify:false) still runs every reversal above but never
  // reaches this block, so the customer/merchant never see a spurious
  // "Refund issued" email/WhatsApp/push.
  if (notify) {
    const store = await step.run('load-store', () =>
      runInTenantContext(storeId, () =>
        prisma.store
          .findUnique({ where: { id: storeId }, select: { name: true } })
          .catch(() => null)
      )
    );

    await Promise.allSettled([
      step.run('send-customer-refund-email', () =>
        EmailService.sendOrderRefunded(storeId, emailData, orderLocale)
      ),
      step.run('dispatch-notification-channels', () =>
        notificationDispatcher.dispatch(storeId, 'refund_processed', {
          customerName,
          customerPhone: guestPhone || undefined,
          orderNumber: order.orderNumber,
          amount: refundAmount / 1000,
          storeId,
          storeName: store?.name ?? storeId,
        })
      ),
      step.run('onesignal-admin-refund-push', () =>
        OneSignalService.notifyAdminsOfRefund({
          orderId: order.id,
          orderNumber: order.orderNumber,
          storeId,
          storeName: store?.name ?? storeId,
          customerName,
          total: refundAmount,
          currency: order.currency,
          paymentMethod: latestPayment?.provider ?? 'refund',
        })
      ),
    ]).then(results => {
      results.forEach(r => {
        if (r.status === 'rejected') {
          logger.error({ err: r.reason, orderId }, 'order/refunded step failed');
        }
      });
    });
  }

  // Item 5 data-integrity Task 4: re-sync the WarehouseStock shadow for
  // every SKU this order touched, now that restore-inventory (above) has
  // committed the authoritative Product/ProductVariant.inventory restore.
  // This is the near-immediate half of the fix (Order sale reconcile relies
  // on the daily warehouse-reconcile-sweep instead — order-created.ts is a
  // pure notification fanout with no natural inventory-touching step, and
  // the checkout decrement itself is synchronous, not part of any fanout —
  // see task-4-report.md). The refund/cancel path is different: this fanout
  // ALREADY performs the inventory-touching restore above, so adding
  // reconcile here is a direct continuation of its existing job list, not a
  // new concern.
  //
  // Runs unconditionally (not gated on `restoreInventory`) — reconciling a
  // SKU that had nothing to restore is a cheap no-op (see
  // `reconcileWarehouseStockToAggregate`'s warehouse-count fast path) and
  // this also mops up any OTHER drift the SKU may have accumulated from an
  // unrelated writer, which is exactly the completeness goal of this task.
  //
  // Fix wave 1 (money-integrity gate): moved from immediately-after
  // restore-inventory to HERE — after every money reversal (coupon,
  // affiliate, loyalty, backorder-cancel) and the notification block, and
  // immediately BEFORE the claim-reversed completion stamp. `WarehouseStock`
  // is an ADMIN-VIEW-ONLY shadow with zero storefront/money read path, and
  // `backfillReconcileAll`'s daily sweep already backstops it — it must
  // never sit ahead of a money reversal or the completion stamp in the step
  // order. Also made best-effort here (log + swallow, no throw), unlike the
  // original version of this step: a persistent reconcile failure (exhausted
  // internal `retryOnWriteConflict` retries, a `withMoneyTx` P2028 timeout,
  // etc.) must not abort the run before the reversals/claim-reversed land —
  // doing so would leave `refundReversedAt` permanently null and cause
  // `refund-reversal-stuck-sweep` (which keys on `refundReversedAt IS NULL`)
  // to re-fire `order/refunded` every tick forever, i.e. perpetual
  // dead-letter churn driven entirely by a non-money shadow that tomorrow's
  // sweep already covers. Mirrors the swallow-and-log precedent at the
  // synchronous admin-writer call sites (`inventory.service.ts`
  // adjustInventory/setInventory — Task 3). Per-SKU try/catch (mirroring
  // `backfillReconcileAll`'s per-SKU guard in `warehouse.service.ts`) so one
  // bad SKU can't abort reconcile for the rest of the order's items either.
  await step.run('reconcile-warehouse-stock', () =>
    runInTenantContext(storeId, async () => {
      for (const item of order.items) {
        try {
          await WarehouseService.reconcileWarehouseStockToAggregate(
            storeId,
            item.productId,
            item.variantId
          );
        } catch (err) {
          logger.error(
            {
              err,
              orderId,
              storeId,
              productId: item.productId,
              variantId: item.variantId,
            },
            '[order-refunded] reconcile-warehouse-stock: SKU failed, skipping (best-effort)'
          );
        }
      }
    })
  );

  // FINAL step, deliberately last. Stamps the completion claim only after every
  // reversal above has succeeded — those steps throw on failure, so a failed
  // reversal never reaches this line and Inngest retries the event while the
  // order stays visible to refund-reversal-stuck-sweep. Stamping any earlier
  // would mark an order done while one of its reversals was still failing,
  // permanently hiding a half-reversed order from the only thing that catches it.
  //
  // reconcile-warehouse-stock above is deliberately excluded from this
  // guarantee — it is best-effort by design and runs immediately before this
  // stamp specifically so a reconcile failure can never prevent it.
  //
  // Stamped regardless of whether any stock actually MOVED: a backorder-line
  // cancel (restoreInventory:false) and an order whose products are all
  // track_inventory=false both legitimately restore nothing and write no
  // InventoryHistory row. That is exactly why the sweep keys on this claim
  // rather than on marker-absence, which cannot tell those apart from "never ran".
  //
  // updateMany + `refundReversedAt: null` keeps it idempotent: a re-delivered or
  // swept re-fire matches 0 rows and leaves the original timestamp intact.
  await step.run('claim-reversed', () =>
    runInTenantContext(storeId, () =>
      prisma.order.updateMany({
        where: { id: orderId, storeId, refundReversedAt: null },
        data: { refundReversedAt: new Date() },
      })
    )
  );
}

export const orderRefunded: InngestFunction.Any = inngest.createFunction(
  {
    id: 'order-refunded-fanout',
    name: 'Order refunded — inventory/coupon/affiliate/loyalty reversal + email + push + dispatcher fan-out',
    // Same per-store concurrency cap as order-created so a single tenant
    // batch-refund storm can't monopolize Inngest workers.
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, restoreInventory, notify } = event.data;
    return handleOrderRefunded(
      orderId,
      storeId,
      restoreInventory !== false,
      notify !== false,
      step
    );
  }
);
