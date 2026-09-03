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
 * Item-level (partial-return) reversal payload — see
 * `OrderService.applyRefundEffects`. When present, only the listed order-item
 * lines are restored (idempotent per `refundKey`, the Return id) and every
 * whole-order reversal (coupon, affiliate, loyalty, claim-reversed stamp) is
 * skipped: the customer kept the rest of the order.
 */
export interface PartialRefund {
  items: Array<{ orderItemId: string; quantity: number }>;
  refundKey: string;
  refundAmount?: number;
}

// orderEvent.toStatus marker for a completed partial-return restore. Owned
// by THIS fanout (inventory side) — the GL's partial-return posting
// deliberately does NOT read it (it derives prior returned quantities from
// completed Return rows instead, see partial-return-posting.ts / issue 1189).
const PARTIAL_RESTORE_MARKER = 'partial_return_restored';

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
  step: FanoutStep,
  // Optional item-level payload — presence flips the fanout into
  // partial-return mode (item-restore only, no whole-order reversals).
  partial?: PartialRefund
): Promise<{ skipped?: string } | void> {
  if (!orderId || !storeId) {
    logger.warn({ orderId, storeId }, 'order/refunded fired without ids — skipping');
    return { skipped: 'missing-ids' };
  }
  const isPartial = !!partial && partial.items.length > 0;
  if (isPartial && !partial?.refundKey) {
    // A partial event without an idempotency key cannot be safely retried —
    // refuse it loudly rather than double-restoring on redelivery.
    logger.error({ orderId, storeId }, 'order/refunded partial event missing refundKey — skipping');
    return { skipped: 'partial-missing-refund-key' };
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

        // Restore one line's stock and write its InventoryHistory audit row.
        // One row per line, matching the sale. A variant refund returns
        // stock to the variant only; `products.inventory` is not a total
        // for a variant product (see lib/effective-inventory.ts). This used
        // to increment BOTH, which is half of what drove the parent column
        // out of step with reality across the catalogue.
        const restoreLine = async (
          item: { productId: string; variantId: string | null },
          qty: number,
          reference: string,
          reason: string
        ): Promise<void> => {
          const [lockedProduct] = await tx.$queryRaw<
            Array<{ id: string; inventory: number; track_inventory: boolean }>
          >`
            SELECT id, inventory, track_inventory FROM public.products
            WHERE id = ${item.productId}
            FOR UPDATE
          `;
          if (!lockedProduct?.track_inventory) return;

          let prevStock: number;
          if (item.variantId) {
            const restored = await tx.productVariant.update({
              where: { id: item.variantId },
              data: { inventory: { increment: qty } },
              select: { inventory: true },
            });
            prevStock = restored.inventory - qty;
          } else {
            prevStock = lockedProduct.inventory;
            await tx.product.update({
              where: { id: item.productId },
              data: { inventory: { increment: qty } },
            });
          }
          await tx.inventoryHistory.create({
            data: {
              productId: item.productId,
              storeId,
              type: 'return_stock',
              quantity: qty,
              previousStock: prevStock,
              newStock: prevStock + qty,
              reason,
              reference,
            },
          });
        };

        // ---- PARTIAL (item-level) restore: only the returned lines. ----
        if (isPartial && partial) {
          // Idempotency marker: one orderEvent per refundKey (the Return id),
          // written in the SAME tx as the restores — a retried or redelivered
          // partial event never double-increments, while a DIFFERENT return
          // on the same order still restores its own lines.
          const partialMarker = await tx.orderEvent.findFirst({
            where: {
              storeId,
              orderId,
              toStatus: PARTIAL_RESTORE_MARKER,
              metadata: { path: ['refundKey'], equals: partial.refundKey },
            },
            select: { id: true },
          });
          if (partialMarker) return { skipped: true };

          const restored: Array<{ orderItemId: string; quantity: number }> = [];
          for (const req of partial.items) {
            const line = order.items.find(i => i.id === req.orderItemId);
            if (!line) continue; // foreign/unknown line — never restore it
            const qty = Math.min(Math.max(0, Math.floor(req.quantity)), line.quantity);
            if (qty === 0) continue;
            await restoreLine(line, qty, partial.refundKey, 'Return completed — partial restore');
            restored.push({ orderItemId: line.id, quantity: qty });
          }

          await tx.orderEvent.create({
            data: {
              storeId,
              orderId,
              fromStatus: null,
              toStatus: PARTIAL_RESTORE_MARKER,
              actorId: null,
              metadata: { refundKey: partial.refundKey, items: restored },
            },
          });
          return { skipped: false };
        }

        // ---- FULL (whole-order) restore. ----
        const stockMarker = await tx.inventoryHistory.findFirst({
          where: { reference: orderId, type: 'return_stock', storeId },
          select: { id: true },
        });
        if (stockMarker) return { skipped: true };

        // Quantities already restored by completed PARTIAL returns must be
        // subtracted, or a cancel/refund after a partial return would invent
        // stock — the same double-restore class as the rollback-marker
        // mismatch (P0-4). The partial markers carry exact per-line
        // quantities, so the remainder is computed per order item.
        const partialMarkers = await tx.orderEvent.findMany({
          where: { storeId, orderId, toStatus: PARTIAL_RESTORE_MARKER },
          select: { metadata: true },
        });
        const alreadyRestored = new Map<string, number>();
        for (const m of partialMarkers) {
          const items = (
            m.metadata as { items?: Array<{ orderItemId?: string; quantity?: number }> } | null
          )?.items;
          if (!Array.isArray(items)) continue;
          for (const it of items) {
            if (typeof it?.orderItemId !== 'string' || typeof it?.quantity !== 'number') continue;
            alreadyRestored.set(
              it.orderItemId,
              (alreadyRestored.get(it.orderItemId) ?? 0) + it.quantity
            );
          }
        }

        for (const item of order.items) {
          const qty = item.quantity - (alreadyRestored.get(item.id) ?? 0);
          if (qty <= 0) continue;
          await restoreLine(item, qty, orderId, 'Order refunded');
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
    // Partial return: the customer kept the rest of the order, so the coupon
    // stays legitimately consumed. Reversing it here erased OTHER customers'
    // live redemptions once floored at 0 (adversarial audit P1-2).
    if (isPartial) return Promise.resolve({ skipped: true });
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
  await step.run('reverse-affiliate-commission', async () => {
    // Partial return: the affiliate's commission on the kept items stays
    // earned — clawing back the whole-order commission on a trivial partial
    // return underpaid affiliates (adversarial audit P1-2).
    if (isPartial) return { skipped: true };
    return runInTenantContext(storeId, () => affiliateService.reverseCommission(storeId, orderId));
  });

  // Reverse loyalty points credited at delivery + re-credit points spent at
  // checkout. No-op for guest checkout (no customerId). Both calls are
  // already idempotent via tagged adjust rows — throw on failure.
  await step.run('reverse-loyalty', async () => {
    // Partial return: the customer keeps the points earned/spent on the kept
    // items — the loyalty reversal helpers are whole-order, so running them
    // here stripped legitimately-earned points (adversarial audit P1-2).
    if (isPartial) return { skipped: true };
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
        // Partial return: only the returned lines' open backorder demand is
        // released — the rest of the order may still be fulfilled.
        where: {
          orderItem: isPartial
            ? { orderId, id: { in: partial!.items.map(i => i.orderItemId) } }
            : { orderId },
          fulfilledAt: null,
          cancelledAt: null,
        },
        data: { cancelledAt: new Date(), cancelledReason: 'Order refunded' },
      })
    )
  );

  // Refund amount: prefer the latest payment's refundedAmount (set by
  // payment.factory.refund), fall back to order total for status-button
  // refunds where the payment row may not exist (COD / manual paid).
  const latestPayment = order.payments[0];
  // A partial return states its own refund amount — falling back to
  // `order.total` on a partial emailed the customer a full-order "Refund
  // issued" figure for a single returned item (adversarial audit P1-2).
  const refundAmount =
    (isPartial ? partial?.refundAmount : undefined) || latestPayment?.refundedAmount || order.total;

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
  await step.run('claim-reversed', async () => {
    // Partial return: refundReversedAt is the WHOLE-order reversal claim.
    // Stamping it here would hide a later cancel/refund of this order from
    // refund-reversal-stuck-sweep (which keys on refundReversedAt IS NULL),
    // permanently losing the remaining reversal if that fanout ever failed.
    if (isPartial) return { skipped: true };
    return runInTenantContext(storeId, () =>
      prisma.order.updateMany({
        where: { id: orderId, storeId, refundReversedAt: null },
        data: { refundReversedAt: new Date() },
      })
    );
  });
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
    const { orderId, storeId, restoreInventory, notify, partial } = event.data;
    return handleOrderRefunded(
      orderId,
      storeId,
      restoreInventory !== false,
      notify !== false,
      step,
      partial as PartialRefund | undefined
    );
  }
);
