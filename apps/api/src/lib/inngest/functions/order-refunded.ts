import { NonRetriableError } from '../../jobs/errors';
import type { JobDef } from '../../jobs/types';
import { prisma, runInTenantContext, withMoneyTx, withStore, type Prisma } from '@ebda/database';
import { runInStoreCtx } from '../../jobs/store-db';
import { storeDb, storeMoney } from '../../repo-factory';
import { EmailService, type OrderRefundEmailData } from '../../../services/email.service';
import { notificationDispatcher } from '../../../services/notification-dispatcher.service';
import { OneSignalService } from '../../../services/onesignal.service';
import { affiliateService } from '../../../services/affiliate.service';
import { LoyaltyService } from '../../../services/loyalty.service';
import { WalletService } from '../../../services/wallet.service';
import { WarehouseService } from '../../../services/warehouse.service';
import { hasCapturedPayment } from '../../../services/order-refund-gating';
import { FiscalDocumentService } from '../../../services/fiscal-document.service';
import { invalidateStoreProductCaches } from '../../public-cache';
import { BACKORDER_CANCEL_MARKER } from '../../../services/accounting/posting/prior-reversed-qty';
import { healBackorderStockDebt } from '../../../services/accounting/backorder-stock-heal';
import logger from '../../logger';
import { inngest } from '../client';
import { auditLogExists } from '../../definer';

import { fromMinor } from '@ebda/shared';
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
  /**
   * Present on a backorder single-line cancel: that one line is already
   * cancelled by `cancelBackorder`, and the item's other open backorder lines
   * stay open (they are still owed to the customer).
   */
  backorderLineId?: string;
  /**
   * A partial refund made OUTSIDE a return (provider dashboard, the order
   * page's refund-via-provider with an amount): `items` is empty, `refundKey`
   * is `refund:<providerRefundId>` and `refundAmount` is what was refunded.
   * Nothing but the GL acts on it — no stock moves (the caller also sends
   * `restoreInventory: false`) and, being partial, no whole-order reversal
   * runs (owner decision 2026-10-01, #1209 / #1455).
   */
  amountOnly?: boolean;
}

// orderEvent.toStatus marker for a completed partial-return restore. Owned
// by THIS fanout (inventory side) — the GL's partial-return posting
// deliberately does NOT read it (it derives prior returned quantities from
// completed Return rows instead, see partial-return-posting.ts / issue 1189).
const PARTIAL_RESTORE_MARKER = 'partial_return_restored';

/**
 * orderEvent.toStatus written by `cancel-backorders` when a PARTIAL return
 * releases a returned item's open backorder line and heals that line's
 * negative stock debt (issue 2302, ruling AP-5c). metadata = `{ refundKey,
 * backorderLineId, items: [{ orderItemId, quantity }], stockRestored }` — the
 * same shape as BACKORDER_CANCEL_MARKER, so the whole-order restore subtracts
 * `stockRestored` the same way. Deliberately NOT BACKORDER_CANCEL_MARKER: that
 * one feeds the GL's prior-reversed quantities (prior-reversed-qty.ts), and a
 * fanout release is already the Return row's quantity there.
 */
const BACKORDER_RELEASE_HEAL_MARKER = 'backorder_release_healed';

/** orderEvent.toStatus claiming the once-per-order cancellation notice (issue 1948). */
const CANCEL_NOTIFIED_MARKER = 'cancel_notified';

/**
 * When admin/manual orders started RESERVING their coupon redemption
 * (`usageCount` +1 in `createAdminOrder`, ruling M-OVR-1, PR 2300 merged
 * 2026-09-30T11:47:49Z). An admin order created before this never counted, so
 * its cancel must not decrement (issue 2303). Checkout orders always reserved.
 */
export const ADMIN_COUPON_RESERVE_CUTOVER = new Date('2026-09-30T11:47:49Z');

/**
 * The shape `OrderService.rollbackForPaymentFailure` wrote from 2026-04-25
 * (6f439217) until 2026-09-25 (0268e4e5): its stock restore was typed
 * `adjustment`, not the canonical `return_stock`, and it wrote no
 * `coupon_reversed` event, although it released the coupon in the same
 * transaction. It now writes both canonical markers, but every order rolled
 * back before that still carries only this row. Refunding such an order
 * (auto-cancelled, then paid on the still-live invoice, then refunded —
 * `cancelled → refunded` is legal since PR #770) must not restore its stock
 * or release its coupon a second time (#1946). The reason string is
 * server-written, never shopper input, so it is safe to match on.
 */
const LEGACY_ROLLBACK_STOCK_ROW = {
  type: 'adjustment' as const,
  reason: 'Order rollback — payment step failed',
};

/** The customer-facing refund notice set gated by the per-order claim. */
const REFUND_NOTIFY_CHANNELS = ['email', 'dispatch', 'push'] as const;
type RefundNotifyChannel = (typeof REFUND_NOTIFY_CHANNELS)[number];

/** Channels a `refund_notified` claim handed back for a replay (issue 2138). */
function releasedChannels(meta: Record<string, unknown>): RefundNotifyChannel[] {
  const raw = Array.isArray(meta.released) ? meta.released : [];
  return REFUND_NOTIFY_CHANNELS.filter(c => raw.includes(c));
}

/**
 * Fans out side effects when an order is refunded — fires from
 * `OrderService.applyRefundEffects` so EVERY refund path (gateway-driven
 * webhook, admin "Refund via provider", manual status-button) lands
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
 * retry the reversals). One exception: a failed CUSTOMER refund email is
 * swallowed only until the reversals and the completion stamp are done; then
 * the claim is released and the run fails loudly (#1935, see the end of this
 * function). The `notify` gate is mandatory: `order/refunded` now
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
  partial?: PartialRefund,
  // Whether a whole-order event may put the order's customer-wallet spend back
  // (D1). Absent/true for every cancel/refund. The backorder single-line cancel
  // sends false too, but it is a partial event, which never reverses the wallet.
  reverseWallet: boolean = true
): Promise<{ skipped?: string } | void> {
  if (!orderId || !storeId) {
    logger.warn({ orderId, storeId }, 'order/refunded fired without ids — skipping');
    return { skipped: 'missing-ids' };
  }
  // An amount-only refund has no lines but is still PARTIAL: treating an empty
  // item list as whole-order would reverse the entire order for a partial
  // refund made in the provider's dashboard.
  const isPartial = !!partial && (partial.items.length > 0 || partial.amountOnly === true);
  if (isPartial && !partial?.refundKey) {
    // A partial event without an idempotency key cannot be safely retried —
    // refuse it loudly rather than double-restoring on redelivery.
    logger.error({ orderId, storeId }, 'order/refunded partial event missing refundKey — skipping');
    return { skipped: 'partial-missing-refund-key' };
  }

  // FORCE RLS: Inngest jobs run outside HTTP — no tenant context middleware.
  // Wrap every prisma call in runInTenantContext(storeId) so RLS filters correctly.
  // PORTED (Ruling CF-JOBS-4). A store on its Durable Object has already reversed stock, coupon, loyalty, wallet and
  // backorders in the SAME section as the cancel / refund / return (`do/refund.ts`, `do/returns.ts`), so those steps are
  // skipped for it; what is left here is the work the DO does not own: the fiscal document, the affiliate commission, the
  // notifications (their claims are DO ops), the warehouse shadow, the caches and the completion stamp.
  const money = await storeMoney(storeId);

  const order = await step.run('load-order', async () => {
    if (money) {
      const row = await (
        await storeDb(storeId)
      ).order.findUnique({
        where: { id: orderId, storeId },
        include: { items: true, payments: { orderBy: { createdAt: 'desc' } } },
      });
      if (!row) throw new Error(`Order ${orderId} not found`);
      // the customer is an identity row (not in the DO): read from the platform
      const customer = row.customerId
        ? await withStore(storeId, tx => tx.user.findFirst({ where: { id: row.customerId! } }))
        : null;
      return { ...row, customer };
    }
    return runInTenantContext(storeId, async () => {
      const row = await prisma.order.findUnique({
        where: { id: orderId, storeId },
        include: {
          customer: true,
          items: true,
          payments: { orderBy: { createdAt: 'desc' } },
        },
      });
      if (!row) throw new Error(`Order ${orderId} not found`);
      return row;
    });
  });

  await step.run('fiscal-document', async () => {
    if (money) {
      const reason =
        typeof (order.payments[0]?.metadata as Record<string, unknown> | null)?.refundReason ===
        'string'
          ? ((order.payments[0]!.metadata as Record<string, unknown>).refundReason as string)
          : null;
      if (isPartial) {
        const amount = partial?.refundAmount;
        if (typeof amount !== 'number' || amount <= 0) return { skipped: 'no-amount' };
        const r = await money.fiscalRefund({
          orderId,
          refundRef: partial!.refundKey,
          amount,
          reason,
        });
        return { issued: r.document?.number ?? null };
      }
      const moneyTaken =
        hasCapturedPayment(order) ||
        order.paymentStatus === 'refunded' ||
        order.payments.some(
          p =>
            (p.refundedAmount ?? 0) > 0 ||
            p.status === 'refunded' ||
            p.status === 'partially_refunded'
        );
      if (!moneyTaken) {
        const r = await money.fiscalCancelSale({ orderId });
        return { cancelled: r.document?.number ?? null };
      }
      const r = await money.fiscalRefund({
        orderId,
        refundRef: `order:${orderId}:full`,
        amount: 'remaining',
        reason,
      });
      return { issued: r.document?.number ?? null };
    }
    return runInTenantContext(storeId, () =>
      withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
        const reason =
          typeof (order.payments[0]?.metadata as Record<string, unknown> | null)?.refundReason ===
          'string'
            ? ((order.payments[0]!.metadata as Record<string, unknown>).refundReason as string)
            : null;
        if (isPartial) {
          const amount = partial?.refundAmount;
          if (typeof amount !== 'number' || amount <= 0) return { skipped: 'no-amount' };
          const doc = await FiscalDocumentService.issueRefundDocument(tx, storeId, orderId, {
            refundRef: partial!.refundKey,
            amount,
            reason,
          });
          return { issued: doc?.number ?? null };
        }
        const moneyTaken =
          hasCapturedPayment(order) ||
          order.paymentStatus === 'refunded' ||
          order.payments.some(
            p =>
              (p.refundedAmount ?? 0) > 0 ||
              p.status === 'refunded' ||
              p.status === 'partially_refunded'
          );
        if (!moneyTaken) {
          const doc = await FiscalDocumentService.cancelSaleDocument(tx, storeId, orderId);
          return { cancelled: doc?.number ?? null };
        }
        const doc = await FiscalDocumentService.issueRefundDocument(tx, storeId, orderId, {
          refundRef: `order:${orderId}:full`,
          amount: 'remaining',
          reason,
        });
        return { issued: doc?.number ?? null };
      })
    );
  });

  // Restore physical stock reserved by this order. Guarded by the
  // `return_stock` InventoryHistory marker (per-order) so a retried or
  // re-delivered event never double-increments inventory. Moved verbatim
  // from the old `applyRefundEffects` inner tx — throws on failure so
  // Inngest retries instead of leaving stock un-restored.
  if (money && !isPartial && order.status === 'cancelled') {
    // Safety net: a cancel whose reversal never completed (the DO section failed after the status flip, or the stuck sweep
    // re-sent this event) is finished by the idempotent DO cancel - a completed one replays and moves nothing.
    await step.run('do-finish-reversal', () => money.cancel({ orderId, restoreInventory }));
  }

  await step.run('restore-inventory', (): Promise<{ skipped: boolean }> => {
    if (money) return Promise.resolve({ skipped: true }); // done in the DO's cancel / refund / return section
    // An amount-only refund returned no goods, whatever the flag says.
    if (!restoreInventory || partial?.amountOnly) return Promise.resolve({ skipped: true });

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
              where: { id: item.productId, storeId },
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

          // Units checkout never took (a backordered VARIANT line is floored at 0:
          // 2 on hand, 5 ordered → took 2) were never on the shelf, so a partial
          // return cannot put them there. Same bound as the whole-order restore
          // below: ordered − never taken − already restored by earlier partials.
          const partialBackorders = await tx.backorderLine.findMany({
            where: { storeId, orderItem: { orderId } },
            select: { orderItemId: true, qty: true, stockTaken: true, qtyFulfilled: true },
          });
          const partialNeverTaken = new Map<string, number>();
          for (const bl of partialBackorders) {
            const untaken = Math.max(
              0,
              bl.qty - (bl.stockTaken ?? bl.qty) - (bl.qtyFulfilled ?? 0)
            );
            if (untaken > 0) {
              partialNeverTaken.set(
                bl.orderItemId,
                (partialNeverTaken.get(bl.orderItemId) ?? 0) + untaken
              );
            }
          }
          const priorPartials = await tx.orderEvent.findMany({
            where: { storeId, orderId, toStatus: PARTIAL_RESTORE_MARKER },
            select: { metadata: true },
          });
          const restoredBefore = new Map<string, number>();
          for (const m of priorPartials) {
            const prior = (
              m.metadata as { items?: Array<{ orderItemId?: string; quantity?: number }> } | null
            )?.items;
            if (!Array.isArray(prior)) continue;
            for (const it of prior) {
              if (typeof it?.orderItemId !== 'string' || typeof it?.quantity !== 'number') continue;
              restoredBefore.set(
                it.orderItemId,
                (restoredBefore.get(it.orderItemId) ?? 0) + it.quantity
              );
            }
          }

          const restored: Array<{ orderItemId: string; quantity: number }> = [];
          for (const req of partial.items) {
            const line = order.items.find(i => i.id === req.orderItemId);
            if (!line) continue; // foreign/unknown line — never restore it
            const room =
              line.quantity -
              (partialNeverTaken.get(line.id) ?? 0) -
              (restoredBefore.get(line.id) ?? 0);
            const qty = Math.min(
              Math.max(0, Math.floor(req.quantity)),
              line.quantity,
              Math.max(0, room)
            );
            if (qty > 0) restoredBefore.set(line.id, (restoredBefore.get(line.id) ?? 0) + qty);
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
          where: {
            reference: orderId,
            storeId,
            OR: [{ type: 'return_stock' }, LEGACY_ROLLBACK_STOCK_ROW],
          },
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
        // A single-line backorder cancel heals the line's negative stock debt
        // up to 0 (#2277, ruling AP-5c) and records the units it put back as
        // `stockRestored` on its marker. Those units are already on the row;
        // restoring the item's full quantity again would invent stock.
        // A partial return's backorder release heals the same way (issue 2302).
        const backorderMarkers = await tx.orderEvent.findMany({
          where: {
            storeId,
            orderId,
            toStatus: { in: [BACKORDER_CANCEL_MARKER, BACKORDER_RELEASE_HEAL_MARKER] },
          },
          select: { metadata: true },
        });
        for (const m of backorderMarkers) {
          const meta = m.metadata as {
            stockRestored?: unknown;
            items?: Array<{ orderItemId?: unknown }>;
          } | null;
          const orderItemId = meta?.items?.[0]?.orderItemId;
          const healed = meta?.stockRestored;
          if (typeof orderItemId !== 'string' || typeof healed !== 'number' || healed <= 0) {
            continue;
          }
          alreadyRestored.set(orderItemId, (alreadyRestored.get(orderItemId) ?? 0) + healed);
        }
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

        // Units checkout never took (#2299, ruling AP-5d). A backordered
        // VARIANT line is floored at 0 at checkout (2 on hand, 5 ordered → it
        // took 2), so giving the full line quantity back invented the
        // shortfall (→ 5). `stockTaken` records what was really taken; a
        // non-variant line took all of it (its shortfall is negative debt),
        // and a pre-2299 row (NULL) is treated as fully taken, as before.
        //
        // Units a PO receipt later supplied are NOT "never taken" (issue
        // 2316): `receivePurchaseOrder` sends fulfilled units straight to the
        // customer without touching the stock row, so on a cancel they come
        // back from the customer and are real. Subtract `qtyFulfilled` from
        // the shortfall: 5 ordered / 2 taken / 5 fulfilled restores all 5.
        const backorderLines = await tx.backorderLine.findMany({
          where: { storeId, orderItem: { orderId } },
          select: { orderItemId: true, qty: true, stockTaken: true, qtyFulfilled: true },
        });
        const neverTaken = new Map<string, number>();
        for (const bl of backorderLines) {
          const untaken = Math.max(0, bl.qty - (bl.stockTaken ?? bl.qty) - (bl.qtyFulfilled ?? 0));
          if (untaken > 0) {
            neverTaken.set(bl.orderItemId, (neverTaken.get(bl.orderItemId) ?? 0) + untaken);
          }
        }

        for (const item of order.items) {
          const qty =
            item.quantity - (alreadyRestored.get(item.id) ?? 0) - (neverTaken.get(item.id) ?? 0);
          if (qty <= 0) continue;
          await restoreLine(item, qty, orderId, 'Order refunded');
        }
        return { skipped: false };
      })
    );
  });

  // An admin order created before admin orders reserved their coupon never
  // incremented `usageCount`; decrementing on its cancel handed a live
  // redemption back to the merchant's limit (issue 2303, ruling M-OVR-1a).
  // The `order.admin_created` audit row is the durable record of an
  // admin-created order (an actor row with no store, so it is read through a
  // definer). Looked up in its OWN step, BEFORE the coupon transaction opens
  // (issue 2359): it is a second pool connection, and taking one while
  // `withMoneyTx` holds another is the double-nest pool hazard
  // (assert-store-owns.ts). The row is immutable history, so reading it
  // outside the transaction loses nothing.
  const adminOrderNeverReserved =
    !money &&
    !isPartial &&
    !!order.couponCode &&
    new Date(order.createdAt) < ADMIN_COUPON_RESERVE_CUTOVER
      ? await step.run('admin-created-lookup', async () => {
          // The row carries NO store (an actor row), so a store-scoped read cannot
          // see it: a definer answers the existence question.
          const row = await auditLogExists('order.admin_created', 'order', orderId);
          return !!row;
        })
      : false;

  // Reverse the coupon usage count consumed at checkout. Guarded by its OWN
  // `coupon_reversed` orderEvent marker (NOT the inventory `return_stock`
  // marker — restoreInventory:false calls, or orders with no tracked
  // inventory, must still decrement the coupon exactly
  // once). Marker written IN THE SAME withMoneyTx as the decrement so a
  // retried/redelivered event never double-decrements. Order-level lock
  // matches restore-inventory above — same reasoning.
  await step.run('reverse-coupon', (): Promise<{ skipped: boolean }> => {
    if (money) return Promise.resolve({ skipped: true });
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

        // A pre-2026-09-25 payment-failure rollback released the coupon in
        // the same transaction as this stock row but wrote no event (#1946).
        const legacyRollback = await tx.inventoryHistory.findFirst({
          where: { reference: orderId, storeId, ...LEGACY_ROLLBACK_STOCK_ROW },
          select: { id: true },
        });
        if (legacyRollback) return { skipped: true };

        // Pre-cutover admin order (looked up above, outside this transaction).
        // Marked like a reversal so a redelivery skips it cheaply.
        if (adminOrderNeverReserved) {
          await tx.orderEvent.create({
            data: {
              storeId,
              orderId,
              fromStatus: null,
              toStatus: 'coupon_reversed',
              actorId: null,
              metadata: { skipped: 'admin_order_never_reserved' },
            },
          });
          return { skipped: true };
        }

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
    return runInStoreCtx(storeId, () => affiliateService.reverseCommission(storeId, orderId));
  });

  // Reverse loyalty points credited at delivery + re-credit points spent at
  // checkout. No-op for guest checkout (no customerId). Both calls are
  // already idempotent via tagged adjust rows — throw on failure.
  await step.run('reverse-loyalty', async () => {
    if (money) return { skipped: true };
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

  // Put back the part of the order that was paid from the customer wallet at
  // checkout (D1). Money reversal tier: throws on failure so Inngest retries.
  // Idempotent on the `order-payment-reversal:<orderId>` ledger key — a
  // redelivered event, the stuck-sweep re-send and a concurrent second event
  // all queue on the wallet row lock and the loser replays. No-op for an order
  // that never spent from a wallet (walletAmount 0 — every order before D1).
  await step.run('reverse-wallet-payment', async () => {
    if (money) return { skipped: true };
    // Partial return: the customer kept the rest of the order; the wallet
    // spend on it stays spent (store credit for the returned lines is issued
    // by ReturnService, not here).
    if (isPartial) return { skipped: true };
    if (!reverseWallet) return { skipped: true };
    if (!order.walletAmount || order.walletAmount <= 0) return { skipped: true };

    return runInTenantContext(storeId, async () => {
      const result = await WalletService.reverseOrderPayment({ storeId, orderId });
      return { skipped: result === null, replayed: result?.replayed ?? false };
    });
  });

  // Auto-cancel any open BackorderLines for this order. A refunded order will
  // never be fulfilled, so outstanding backorder demand must be released so
  // purchase-order demand planning stays accurate. Idempotent via the
  // fulfilledAt/cancelledAt null guards.
  await step.run('cancel-backorders', async () => {
    if (money) return { count: 0 };
    // Backorder single-line cancel: its line is already cancelled; releasing
    // the item's OTHER open lines would cancel demand still owed.
    if (partial?.backorderLineId) return { count: 0 };

    // Whole order: every open line is released. No heal — the whole-order
    // restore above already gave back each item's full taken quantity, which
    // covers a non-variant line's negative debt.
    if (!isPartial) {
      return runInTenantContext(storeId, () =>
        prisma.backorderLine.updateMany({
          where: { storeId, orderItem: { orderId }, fulfilledAt: null, cancelledAt: null },
          data: { cancelledAt: new Date(), cancelledReason: 'Order refunded' },
        })
      );
    }

    // Partial return: only the returned lines' open backorder demand is
    // released — the rest of the order may still be fulfilled. Each released
    // line heals the negative stock debt it left, up to 0, exactly as the
    // merchant-driven `cancelBackorder` does (issue 2302, ruling AP-5c): the
    // partial restore above gave back only the RETURNED units, so without
    // this a non-variant product kept the released units' debt forever and
    // read out of stock. Claim + heal + marker share one transaction, so a
    // retry finds no open line and heals nothing twice.
    const released = await runInTenantContext(storeId, () =>
      withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
        const open = await tx.backorderLine.findMany({
          where: {
            storeId,
            orderItem: { orderId, id: { in: partial!.items.map(i => i.orderItemId) } },
            fulfilledAt: null,
            cancelledAt: null,
          },
          select: {
            id: true,
            orderItemId: true,
            productId: true,
            variantId: true,
            qty: true,
            qtyFulfilled: true,
          },
          orderBy: { id: 'asc' },
        });
        let count = 0;
        let healed = 0;
        for (const line of open) {
          const claim = await tx.backorderLine.updateMany({
            where: { id: line.id, storeId, fulfilledAt: null, cancelledAt: null },
            data: { cancelledAt: new Date(), cancelledReason: 'Order refunded' },
          });
          if (claim.count === 0) continue;
          count += 1;
          const quantity = Math.max(0, line.qty - line.qtyFulfilled);
          const stockRestored = await healBackorderStockDebt(tx, {
            storeId,
            productId: line.productId,
            variantId: line.variantId,
            quantity,
            reference: `backorder:${line.id}`,
            reason: 'Backorder line released by a return — stock debt healed to 0',
          });
          if (stockRestored <= 0) continue;
          healed += stockRestored;
          await tx.orderEvent.create({
            data: {
              storeId,
              orderId,
              fromStatus: null,
              toStatus: BACKORDER_RELEASE_HEAL_MARKER,
              actorId: null,
              metadata: {
                refundKey: partial!.refundKey,
                backorderLineId: line.id,
                items: [{ orderItemId: line.orderItemId, quantity }],
                stockRestored,
              },
            },
          });
        }
        return { count, healed };
      })
    );
    // Inventory is never-stale; the restore step's cache bust only runs when
    // goods came back, so bust here for a heal. Best-effort, as there.
    if (released.healed > 0 && !restoreInventory) {
      await invalidateStoreProductCaches(storeId).catch(err =>
        logger.error(
          { err, orderId, storeId },
          '[order-refunded] product cache invalidation failed'
        )
      );
    }
    return released;
  });

  // Refund amount: prefer the latest payment's refundedAmount (set by
  // payment.factory.refund), fall back to order total for status-button
  // refunds where the payment row may not exist (COD / manual paid).
  const latestPayment = order.payments[0];
  // A partial return states its own refund amount — falling back to
  // `order.total` on a partial emailed the customer a full-order "Refund
  // issued" figure for a single returned item (adversarial audit P1-2).
  //
  // Issue 2274: for a partial the fallback chain is CUT, not `||`-chained. A
  // partial whose amount is 0 (lines already reversed, a fully discounted
  // order) or absent used to fall through to the payment's cumulative refund
  // or the ORDER TOTAL and announce that. A partial now announces only its
  // own positive amount; otherwise nothing is announced (see partialAmountKnown).
  const partialAmount = isPartial ? partial?.refundAmount : undefined;
  const partialAmountKnown = typeof partialAmount === 'number' && partialAmount > 0;
  const refundAmount = isPartial
    ? partialAmountKnown
      ? partialAmount
      : 0
    : latestPayment?.refundedAmount || order.total;

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
    currency: order.currency,
    reason:
      typeof (latestPayment?.metadata as Record<string, unknown> | null)?.refundReason === 'string'
        ? ((latestPayment?.metadata as Record<string, unknown>).refundReason as string)
        : undefined,
  };

  // Gated on `notify` — see the two-tier failure policy comment above. An
  // unpaid cancel (notify:false) still runs every reversal above but never
  // reaches this block, so the customer/merchant never see a spurious
  // "Refund issued" email/WhatsApp/push.
  // A full refund's "Refund issued" goes out ONCE per order. Cancelling a paid
  // order already sends it, and a later provider refund of that order must not
  // send a second one. Status can't tell those apart (an order cancelled while
  // UNPAID and paid afterwards was never told), so claim a durable per-order
  // marker instead. Partial returns notify per return, with their own amount.
  //
  // The claim is only an honest gate while THIS block is the only producer of
  // the customer-facing set. It is: `order-status-changed.ts` used to dispatch
  // the same `refund_processed` key from its `refunded && hadCapturedPayment`
  // branch, unclaimed, which double-notified the cancel→refund flow; that
  // dispatch was removed and its branch now carries a comment pointing back
  // here. Any new customer refund notification belongs inside this block —
  // adding one elsewhere silently breaks the once-per-order invariant.
  //
  // Per CHANNEL (issue 2138 / issue 2135): the claim row's
  // `metadata.released` lists channels whose send failed and were handed back
  // for a replay. Releasing the WHOLE claim on an email-only failure used to
  // re-open it for the dispatcher (a billed WhatsApp/SMS template) and the
  // admin push too, which had already delivered — and for any LATER
  // independent `order/refunded` for the order as well. A claim row with no
  // `released` list (including every row written before this change) means
  // every channel was sent.
  // Issue 1948 (owner decision 2026-10-01): a whole-order event that moved NO
  // money — a paid order CANCELLED before any refund was executed — is not a
  // refund and must not spend the once-per-order "Refund issued" claim. It
  // used to: the cancel emailed "Refund issued" for the order total before a
  // piastres moved, took the claim, and the real settlement later found the claim
  // and told the customer nothing. The cancel now sends its own notice
  // ("Your order was cancelled. You were not charged.", en/ar, claimed once
  // via `cancel_notified`), and "Refund issued" waits for the event that moved
  // money: the order refunded, or its payment carrying a refunded amount.
  // The cancel notice's wording follows whether the payment was captured.
  const wholeOrderMoneyMoved =
    order.status === 'refunded' || (latestPayment?.refundedAmount ?? 0) > 0;
  const cancelNoticeOnly = notify && !isPartial && !wholeOrderMoneyMoved;
  // Which cancel notice is TRUE (issue 1948, ruling R2-5a): the wording
  // follows whether money was actually taken — `hasCapturedPayment`, the one
  // shared signal (order `paid`, or a `completed` payment row) — never the
  // provider. Captured → "Your refund is being processed."; nothing taken
  // (auth-only, voided, unpaid, or COD not yet collected: `cod_pending`) →
  // "You were not charged." Cash on delivery IS captured once collected:
  // `POST …/orders/:orderId/mark-paid` sets the COD payment `completed` and
  // the order `paid`, and that customer is owed a refund. (A `delivered`
  // order cannot be cancelled — the status machine allows only `refunded`
  // from it — so delivery is not a separate signal here.)
  const cancelWasCharged = hasCapturedPayment(order);
  let cancelNoticeFailed = false;
  if (cancelNoticeOnly) {
    const claimedCancel = await step.run('claim-cancel-notification', () =>
      money
        ? money.markerClaim({ orderId, marker: CANCEL_NOTIFIED_MARKER }).then(r => r.claimed)
        : runInTenantContext(storeId, () =>
            withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
              await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${orderId} FOR UPDATE`;
              const sent = await tx.orderEvent.findFirst({
                where: { storeId, orderId, toStatus: CANCEL_NOTIFIED_MARKER },
                select: { id: true },
              });
              if (sent) return false;
              await tx.orderEvent.create({
                data: {
                  storeId,
                  orderId,
                  fromStatus: null,
                  toStatus: CANCEL_NOTIFIED_MARKER,
                  actorId: null,
                  metadata: {},
                },
              });
              return true;
            })
          )
    );
    if (claimedCancel) {
      await step
        .run('send-customer-cancel-email', () =>
          EmailService.sendOrderCancelledNotCharged(
            storeId,
            {
              orderNumber: order.orderNumber,
              customerName,
              customerEmail,
              charged: cancelWasCharged,
            },
            orderLocale
          )
        )
        .catch(err => {
          logger.error({ err, orderId }, 'order/refunded: customer cancel notice failed');
          cancelNoticeFailed = true;
        });
    }
  }

  if (notify && isPartial && !partialAmountKnown) {
    logger.warn(
      { orderId, storeId, refundKey: partial?.refundKey },
      'order/refunded: partial event with no positive refundAmount — no refund notification sent'
    );
  }
  // Cancel notice only (issue 1948): no refund channel is claimed — the
  // customer's notice is the cancel email above, WhatsApp/SMS carry the
  // status fanout's own `order_cancelled`, and the merchant admin push for a
  // "refund" is deliberately NOT sent: nothing was refunded, and every cancel
  // path today is the merchant's own admin action. Revisit if a customer- or
  // gateway-initiated cancel is added.
  const claimed: RefundNotifyChannel[] | boolean =
    !notify || cancelNoticeOnly
      ? []
      : isPartial
        ? partialAmountKnown
          ? [...REFUND_NOTIFY_CHANNELS]
          : []
        : await step.run('claim-refund-notification', () =>
            money
              ? money.refundNotifyClaim({ orderId }).then(r => r.channels as RefundNotifyChannel[])
              : runInTenantContext(storeId, () =>
                  withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
                    await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${orderId} FOR UPDATE`;
                    const sent = await tx.orderEvent.findFirst({
                      where: { storeId, orderId, toStatus: 'refund_notified' },
                      select: { id: true, metadata: true },
                    });
                    if (!sent) {
                      await tx.orderEvent.create({
                        data: {
                          storeId,
                          orderId,
                          fromStatus: null,
                          toStatus: 'refund_notified',
                          actorId: null,
                          metadata: {},
                        },
                      });
                      return [...REFUND_NOTIFY_CHANNELS];
                    }
                    const meta = (sent.metadata ?? {}) as Record<string, unknown>;
                    const released = releasedChannels(meta);
                    if (released.length === 0) return [];
                    // Re-claim exactly the released channels.
                    await tx.orderEvent.update({
                      where: { id: sent.id, storeId },
                      data: { metadata: { ...meta, released: [] } as Prisma.InputJsonValue },
                    });
                    return released;
                  })
                )
          );
  // A run that started before this change replays the memoized claim step's
  // old boolean answer: true meant "send the whole set".
  const notifyChannels: RefundNotifyChannel[] = Array.isArray(claimed)
    ? claimed
    : claimed
      ? [...REFUND_NOTIFY_CHANNELS]
      : [];
  const shouldNotify = notifyChannels.length > 0;

  // Set when the customer's "Refund issued" email step fails for good. The
  // claim above is already committed, so without a second look that customer
  // is never told (#1935): the stuck-sweep re-sends with notify:false and a
  // redelivery finds the claim. See the end of this function.
  let customerEmailFailed = false;

  if (shouldNotify) {
    const store = await step.run('load-store', () =>
      withStore(storeId, tx =>
        tx.store.findUnique({ where: { id: storeId }, select: { name: true } }).catch(() => null)
      )
    );

    const sends: Array<[RefundNotifyChannel, () => Promise<unknown>]> = [
      [
        'email',
        () =>
          step.run('send-customer-refund-email', () =>
            EmailService.sendOrderRefunded(storeId, emailData, orderLocale)
          ),
      ],
      [
        'dispatch',
        () =>
          step.run('dispatch-notification-channels', () =>
            notificationDispatcher.dispatch(storeId, 'refund_processed', {
              customerName,
              customerPhone: guestPhone || undefined,
              orderNumber: order.orderNumber,
              amount: fromMinor(refundAmount),
              storeId,
              storeName: store?.name ?? storeId,
              locale: orderLocale,
            })
          ),
      ],
      [
        'push',
        () =>
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
      ],
    ];
    const chosen = sends.filter(([channel]) => notifyChannels.includes(channel));
    await Promise.allSettled(chosen.map(([, send]) => send())).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          logger.error({ err: r.reason, orderId }, 'order/refunded step failed');
          // The dispatcher never throws (it logs internally) and the admin
          // push is admin-facing; only the customer's email is escalated.
          if (chosen[i][0] === 'email') customerEmailFailed = true;
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
    runInStoreCtx(storeId, async () => {
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

  // Stock just went back on the shelf, and inventory is NEVER-stale: the
  // storefront, product pages and the AI feed must stop showing the old
  // availability now, not after the cache TTL (up to 600s). Best-effort for the
  // same reason as the reconcile above: the reversals are already committed,
  // and a cache blip must not dead-letter the event.
  if (restoreInventory) {
    await step.run('invalidate-product-caches', async () => {
      try {
        await invalidateStoreProductCaches(storeId);
      } catch (err) {
        logger.error(
          { err, orderId, storeId },
          '[order-refunded] product cache invalidation failed'
        );
      }
    });
  }

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
  // Stamped regardless of whether any stock actually MOVED: a whole-order
  // event with restoreInventory:false and an order whose products are all
  // track_inventory=false both legitimately restore nothing and write no
  // InventoryHistory row. That is exactly why the sweep keys on this claim
  // rather than on marker-absence, which cannot tell those apart from "never ran".
  //
  // updateMany + `refundReversedAt: null` keeps it idempotent: a re-delivered or
  // swept re-fire matches 0 rows and leaves the original timestamp intact.
  await step.run('claim-reversed', async () => {
    if (money) {
      const r = await money.reversalClaim({
        orderId,
        restoreInventory,
        ...(isPartial ? { returnId: partial!.refundKey } : {}),
      });
      return isPartial ? { skipped: true } : { count: r.claimed ? 1 : 0 };
    }
    // Partial return: refundReversedAt is the WHOLE-order reversal claim.
    // Stamping it here would hide a later cancel/refund of this order from
    // refund-reversal-stuck-sweep (which keys on refundReversedAt IS NULL),
    // permanently losing the remaining reversal if that fanout ever failed.
    if (isPartial) {
      // A partial never claims the ORDER; it marks its own Return applied, so
      // refund-reversal-stuck-sweep stops re-sending it (issues 2246 / 2267).
      // Idempotent: a re-delivery matches 0 rows and keeps the first stamp.
      await runInTenantContext(storeId, () =>
        prisma.return.updateMany({
          where: { id: partial!.refundKey, storeId, reversalAppliedAt: null },
          data: { reversalAppliedAt: new Date() },
        })
      );
      return { skipped: true };
    }
    return runInTenantContext(storeId, () =>
      prisma.order.updateMany({
        where: {
          id: orderId,
          storeId,
          refundReversedAt: null,
          // A restoreInventory:false event (backorder-line cancel) is never
          // armed, so it must never close an ARMED claim (issue 2132 / #858):
          // if a stock-restoring event was armed and dropped, this stamp would
          // hide it from refund-reversal-stuck-sweep forever. It may still
          // close a legacy unarmed row.
          ...(restoreInventory ? {} : { refundReversalRequestedAt: null }),
        },
        data: { refundReversedAt: new Date() },
      })
    );
  });

  // The customer's refund email failed after every retry (the email itself is
  // on the durable Redis queue, so this is a failure to render or enqueue it,
  // not a Resend outage). Every reversal above has committed, so failing the
  // run now costs nothing and dead-letters it to alerts-failure-watch instead
  // of ending green with the customer never told (#1935). The claim's EMAIL
  // channel is released first, so replaying this event from Inngest sends the
  // email and nothing else; the reversals and the refundReversedAt stamp are
  // idempotent. A partial return is never claimed, so its replay re-sends as
  // it is.
  // Same contract for the cancel notice: hand the claim back, then fail the
  // run so a replay sends it (the reversals above are idempotent).
  if (cancelNoticeFailed) {
    await step.run('release-cancel-notification-claim', () =>
      money
        ? money.markerRelease({ orderId, marker: CANCEL_NOTIFIED_MARKER }).then(() => undefined)
        : runInTenantContext(storeId, () =>
            withMoneyTx(prisma, (tx: Prisma.TransactionClient) =>
              tx.orderEvent.deleteMany({
                where: { storeId, orderId, toStatus: CANCEL_NOTIFIED_MARKER },
              })
            )
          )
    );
    throw new NonRetriableError(
      `order/refunded: the customer cancellation email for order ${orderId} was not sent. ` +
        'Replay this event to notify the customer.'
    );
  }

  if (customerEmailFailed) {
    if (!isPartial) {
      // Release ONLY the email channel (issue 2138 / issue 2135): the
      // dispatcher and the admin push already delivered, and a replay must
      // not send them twice.
      await step.run('release-refund-notification-claim', () =>
        money
          ? money.refundNotifyRelease({ orderId, channel: 'email' })
          : runInTenantContext(storeId, () =>
              withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
                await tx.$queryRaw`SELECT id FROM public.orders WHERE id = ${orderId} FOR UPDATE`;
                const claim = await tx.orderEvent.findFirst({
                  where: { storeId, orderId, toStatus: 'refund_notified' },
                  select: { id: true, metadata: true },
                });
                if (!claim) return { released: [] };
                const meta = (claim.metadata ?? {}) as Record<string, unknown>;
                const released = [...new Set([...releasedChannels(meta), 'email' as const])];
                await tx.orderEvent.update({
                  where: { id: claim.id, storeId },
                  data: { metadata: { ...meta, released } as Prisma.InputJsonValue },
                });
                return { released };
              })
            )
      );
    }
    throw new NonRetriableError(
      `order/refunded: the customer refund email for order ${orderId} was not sent. ` +
        'Replay this event to notify the customer.'
    );
  }
}

export const orderRefunded: JobDef = inngest.createFunction(
  {
    id: 'order-refunded-fanout',
    name: 'Order refunded — inventory/coupon/affiliate/loyalty/wallet reversal + email + push + dispatcher fan-out',
    // Same per-store concurrency cap as order-created so a single tenant
    // batch-refund storm can't monopolize Inngest workers.
    concurrency: { key: 'event.data.storeId', limit: 5 },
    retries: 3,
    triggers: [{ event: 'order/refunded' }],
  },
  async ({ event, step }) => {
    const { orderId, storeId, restoreInventory, notify, partial, reverseWallet } = event.data;
    return handleOrderRefunded(
      orderId,
      storeId,
      restoreInventory !== false,
      notify !== false,
      step,
      partial as PartialRefund | undefined,
      // Events enqueued before D1 carry no flag: treat absent as true. Such
      // an order has walletAmount 0, so the step is a no-op for it anyway.
      reverseWallet !== false
    );
  }
);
