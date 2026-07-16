import { prisma, Prisma, OrderStatus, withMoneyTx } from '@force/database';
import { generateOrderNumber } from '../utils/order-number';
import { AppError } from '../middleware/error-handler';
import { CartService } from './cart.service';
import { CouponService } from './coupon.service';
import { socketService } from './socket.service';
import { featureService } from './feature.service';
import {
  decrementProductInventory,
  forceDecrementProductInventory,
  decrementVariantInventory,
  forceDecrementVariantInventory,
} from './inventory-decrement';
import { inngest } from '../lib/inngest/client';
import { handleOrderStatusChanged } from '../lib/inngest/functions/order-status-changed';
import { ShippingService } from './shipping.service';
import { LoyaltyService, computeRedemption } from './loyalty.service';
import { affiliateService } from './affiliate.service';
import { auditLog } from '../middleware/security';
import { hasCapturedPayment, shouldApplyRefundEffects } from './order-refund-gating';
import logger from '../lib/logger';
import { invalidateStoreProductCaches, invalidateCustomersCache } from '../lib/public-cache';

/**
 * Bust the storefront product caches (list / detail / suggest — all carry
 * price & inventory) after an order changes stock. Best-effort and always
 * called AFTER the surrounding transaction commits, never inside it (the
 * order paths deliberately avoid network I/O within the Prisma tx). Without
 * this, a checkout that sells the last unit still shows "in stock" on the
 * PLP/PDP for up to the cache TTL. A cache error must never fail the order.
 */
async function bustProductCaches(storeId: string): Promise<void> {
  try {
    await invalidateStoreProductCaches(storeId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown', storeId },
      '[OrderService] product cache invalidation after inventory change failed'
    );
  }
}

// The order status-machine guard lives in its own dependency-free module
// so any Order.status writer can import it without pulling in this heavy
// service graph. Re-exported here for the existing import sites.
import { assertValidTransition, VALID_ORDER_TRANSITIONS } from './order-status-machine';
export { assertValidTransition, VALID_ORDER_TRANSITIONS };

interface CreateOrderData {
  shippingAddress: {
    firstName: string;
    lastName: string;
    company?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
    [key: string]: string | undefined;
  };
  billingAddress?: {
    firstName: string;
    lastName: string;
    company?: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
    [key: string]: string | undefined;
  };
  paymentMethod: string;
  notes?: string;
  couponCode?: string;
  /** Loyalty points the customer requested to redeem at checkout. The server
   *  re-resolves this against the customer's real balance + the store's
   *  redemption settings (min/max/percentage cap) — it is a REQUEST, never a
   *  trusted discount. Ignored for guest checkout (no customerId). */
  pointsToRedeem?: number;
  /** Buyer's UI locale at checkout time. Stored on the order so
   *  transactional emails are sent in the buyer's language. */
  locale?: 'en' | 'ar';
  /**
   * Customer SMS marketing opt-in captured at checkout. When true the customer
   * has explicitly consented to PROMOTIONAL SMS. Transactional SMS (shipped,
   * delivered, cancelled, refunded) are always allowed regardless of this flag.
   */
  smsOptIn?: boolean;
}

export class OrderService {
  static async list(
    storeId: string,
    options: {
      page?: number;
      limit?: number;
      status?: string;
      customerId?: string;
      from?: Date;
      to?: Date;
      /**
       * When true, exclude orders that are status=pending AND paymentStatus=unpaid
       * (i.e. an online-payment order that has not been paid yet and is not COD).
       * COD orders are always included regardless of status because the fulfillment
       * operator needs to see them — they are "confirmed" from day one (no payment
       * gateway involved). This flag powers the Orders PWA's confirmed-only view.
       *
       * The filter is: NOT (status=pending AND paymentStatus=unpaid AND has an
       * online-payment Payment row). In practice: keeps COD pending + keeps all
       * confirmed/processing/shipped/delivered/cancelled/refunded.
       */
      confirmedOnly?: boolean;
      /**
       * Opaque order id from a previous response's `meta.nextCursor`. When
       * present, uses keyset pagination instead of `skip`/`OFFSET` — O(1) at
       * the DB level regardless of page depth, matching the pattern
       * `ProductService.listPublic` already uses (`product.service.ts:1338`).
       * Additive: existing offset-based callers (admin order list, Orders
       * PWA) are unaffected — this only activates when `cursor` is passed.
       */
      cursor?: string;
    } = {}
  ) {
    const { status, customerId, from, to, confirmedOnly, cursor } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    // Defensive deletedAt filter. The schema marks Order as soft-deletable
    // but no code path currently sets `deletedAt`, so this is a no-op
    // today — kept here so a future "archive order" feature doesn't
    // accidentally surface archived rows in the admin list (which would
    // also pollute analytics aggregates that count off this query).
    const where: Prisma.OrderWhereInput = { storeId, deletedAt: null };
    if (status) where.status = status as OrderStatus;

    // Orders-PWA confirmed-only filter: exclude unconfirmed online-payment
    // orders (pending + unpaid with an online Payment row). COD orders that
    // are pending are real orders — always included.
    if (confirmedOnly && !status) {
      where.NOT = {
        AND: [
          { status: 'pending' },
          { paymentStatus: 'unpaid' },
          // Has at least one online-payment Payment (not COD/cash).
          { payments: { some: { provider: { notIn: ['cod', 'cash', 'cash_on_delivery'] } } } },
        ],
      };
    }
    if (customerId) where.customerId = customerId;
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as any).gte = from;
      if (to) (where.createdAt as any).lte = to;
    }

    const baseFindManyArgs = {
      where,
      include: {
        // `phone` is included so the admin customers page can surface
        // it without doing a second query. Stays nullable on the User
        // record itself.
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true, phone: true },
        },
        items: true,
        payments: { select: { provider: true, status: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' as const },
    };

    // Cursor path fetches one extra row (`limit + 1`) so we know whether a
    // next page exists without a second COUNT query.
    const findManyArgs = cursor
      ? { ...baseFindManyArgs, cursor: { id: cursor }, skip: 1, take: limit + 1 }
      : { ...baseFindManyArgs, skip, take: limit };

    const [ordersRaw, total] = await Promise.all([
      prisma.order.findMany(findManyArgs),
      prisma.order.count({ where }),
    ]);

    const orders = cursor && ordersRaw.length > limit ? ordersRaw.slice(0, limit) : ordersRaw;
    const nextCursor =
      cursor && ordersRaw.length > limit ? (ordersRaw[limit] as { id: string }).id : undefined;

    return {
      orders,
      meta: {
        page: cursor ? undefined : page,
        limit,
        total,
        totalPages: cursor ? undefined : Math.ceil(total / limit),
        nextCursor,
      },
    };
  }

  static async getById(storeId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId, deletedAt: null },
      include: {
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        items: {
          include: {
            product: {
              include: { images: { take: 1, orderBy: { position: 'asc' } } },
            },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    return order;
  }

  static async getByOrderNumber(storeId: string, orderNumber: string) {
    const order = await prisma.order.findFirst({
      where: { orderNumber, storeId, deletedAt: null },
      include: {
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        items: {
          include: {
            product: {
              include: { images: { take: 1, orderBy: { position: 'asc' } } },
            },
          },
        },
        payments: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    return order;
  }

  static async create(
    storeId: string,
    customerId: string | undefined,
    sessionId: string,
    data: CreateOrderData,
    referralCode?: string
  ) {
    // Get cart
    const cart = await CartService.getOrCreate(storeId, sessionId, customerId);

    if (cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Cart is empty');
    }

    // Calculate totals (done before the transaction — no locks needed here)
    const subtotal = cart.items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    // Calculate tax using store's configured tax rates
    const taxRates = await prisma.taxRate.findMany({ where: { storeId, isActive: true } });
    const taxRate = taxRates.length > 0 ? Number(taxRates[0].rate) / 100 : 0;
    const tax = Math.round(subtotal * taxRate);

    // Resolve shipping for the order's delivery area. Until now this was
    // hardcoded to 0 — the storefront cart/checkout calls
    // /stores/public/:id/shipping/calculate and DOES show a fee in the
    // breakdown, but the persisted Order had shipping=0, so the merchant
    // was silently losing the delivery fee on every order. Re-run the
    // same calculation server-side here (never trust a client-asserted
    // shipping cost) using the address's `area` field. When no zone
    // matches, the calculator returns 0 — same outcome as before for
    // stores with zero shipping zones configured.
    // Prefer explicit sub-area → governorate → legacy city/state fallback so
    // orders created before the cascade selector (where the governorate lived
    // in `area` or `state`) still match shipping zones correctly.
    const addr = data.shippingAddress as Record<string, unknown>;
    const shippingArea =
      (typeof addr.area === 'string' && addr.area) ||
      (typeof addr.governorate === 'string' && addr.governorate) ||
      data.shippingAddress.city ||
      data.shippingAddress.state ||
      '';
    // Pass the governorate so the server-side charge resolves the SAME
    // per-area rate the storefront /calculate displayed (display=charge
    // parity; disambiguates same-named areas across governorates).
    const shippingGovernorate = typeof addr.governorate === 'string' ? addr.governorate : undefined;
    let shipping = 0;
    try {
      const result = await ShippingService.calculateShipping(
        storeId,
        shippingArea,
        subtotal,
        shippingGovernorate
      );
      // Guard: if the store configured per-area rates and the chosen area
      // matches none of them, refuse the order rather than silently ship at
      // 0 (the storefront hides unpriced areas, but a direct API POST could
      // submit one — this prevents an undercharge).
      if (!result.matched && result.storeHasAreaRates) {
        throw new AppError(
          400,
          'AREA_NOT_DELIVERABLE',
          'Delivery is not available for the selected area'
        );
      }
      shipping = result.freeShipping ? 0 : result.shippingCost;
    } catch (err) {
      // The not-deliverable guard is a deliberate rejection — re-throw it so
      // the order is refused (don't swallow it into a 0-shipping fallback).
      if (err instanceof AppError) throw err;
      // Defensive: if the shipping lookup throws, fall back to 0 rather
      // than fail the entire checkout. Worst case is a one-off undercharge
      // that surfaces in the merchant's order detail with shipping=0
      // (visible vs the cart UI shipping line — easy to spot).
      logger.error({ err, storeId, shippingArea }, 'Shipping calculation failed; defaulting to 0');
    }
    // Free-shipping coupon: zero out shipping after we resolved the
    // base fee, so a "Free shipping over X" coupon stacks correctly
    // with the store's free-shipping threshold (whichever zeros first).
    // The coupon resolution below also independently zeroes shipping.

    // Resolve coupon (if any) on the server -- we never trust a client-asserted
    // discount, since the cart could have changed between /coupons/validate
    // and order creation. CouponService.getByCode enforces active/starts/expires/
    // usage-limit at read time; the atomic usage-count increment inside the
    // transaction below closes the remaining concurrency gap.
    let appliedCoupon: Awaited<ReturnType<typeof CouponService.getByCode>> | null = null;
    let couponDiscount = 0;
    if (data.couponCode) {
      appliedCoupon = await CouponService.getByCode(storeId, data.couponCode);
      if (appliedCoupon.minOrderAmount && subtotal < appliedCoupon.minOrderAmount) {
        throw new AppError(
          400,
          'MIN_ORDER_NOT_MET',
          `Minimum order amount of ${(appliedCoupon.minOrderAmount / 1000).toFixed(
            3
          )} KWD required for this coupon`
        );
      }
      if (appliedCoupon.type !== 'free_shipping') {
        couponDiscount = CouponService.calculateDiscount(
          {
            type: appliedCoupon.type,
            value: appliedCoupon.value,
            maxDiscount: appliedCoupon.maxDiscount,
          },
          subtotal
        );
      } else {
        // Free-shipping coupon — zero out the shipping line we just
        // resolved above. Stacks naturally with the store's own
        // free-shipping threshold (whichever zeros first wins; both
        // mean the customer pays no delivery fee).
        shipping = 0;
      }
    }

    // Resolve loyalty redemption on the SERVER. data.pointsToRedeem is a
    // request, never a trusted discount. Guests (no customerId) can't redeem.
    // We compute the actual burnable points + discount against the customer's
    // real balance + the store's redemption caps, then cap the loyalty
    // discount at the subtotal REMAINING after the coupon so the two discounts
    // can't drive the order below zero or over-discount the goods. The actual
    // point decrement happens inside the order transaction (atomic) via
    // LoyaltyService.redeemPoints with the resolved point count.
    let loyaltyPointsRedeemed = 0;
    let loyaltyDiscount = 0;
    if (customerId && typeof data.pointsToRedeem === 'number' && data.pointsToRedeem > 0) {
      const ctx = await LoyaltyService.getRedeemableContext(storeId, customerId);
      if (ctx) {
        // Cap against the goods value still payable after the coupon discount.
        const redeemableSubtotal = Math.max(0, subtotal - couponDiscount);
        const quote = computeRedemption(
          ctx.settings,
          data.pointsToRedeem,
          redeemableSubtotal,
          ctx.availablePoints
        );
        if (quote.applied) {
          loyaltyPointsRedeemed = quote.pointsToRedeem;
          loyaltyDiscount = quote.discountFils;
        }
      }
    }

    const discount = couponDiscount + loyaltyDiscount;
    const total = Math.max(0, subtotal + tax + shipping - discount);

    // Generate order number
    const orderNumber = generateOrderNumber();

    // Resolve the backorder feature flag BEFORE the transaction so we do not
    // make an async service call inside a Prisma interactive transaction
    // (that would extend the transaction's hold time unnecessarily and is a
    // Neon cold-start risk). The flag is captured once and referenced by the
    // closure below.
    const backorderFeatureEnabled = await featureService.isFeatureEnabled(
      storeId,
      'inventory.backorder'
    );

    // Create order in transaction.
    //
    // DB-006: Inventory is guarded by an atomic conditional decrement
    // (`UPDATE … WHERE inventory >= qty`) *inside* the transaction so that two
    // concurrent checkouts cannot both succeed when only one unit remains — the
    // losing writer's UPDATE affects 0 rows. This replaced an earlier
    // SELECT … FOR UPDATE that held the row lock across the whole transaction
    // and serialized every checkout on a hot SKU (see
    // docs/superpowers/plans/2026-06-05-checkout-concurrency-scaling.md).
    const order = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      // backorderedItems collects items where the pre-decrement inventory was
      // insufficient and the inventory.backorder feature is enabled — these get
      // a BackorderLine row created after the order is persisted (further down
      // in this transaction). When the feature is disabled, out-of-stock items
      // are rejected regardless of the per-product allowBackorder flag.
      const backorderedItems: Array<{ productId: string; variantId?: string; quantity: number }> =
        [];

      // Atomic check + decrement per tracked item. A conditional
      // `UPDATE … WHERE inventory >= qty` does the oversell guard AND the
      // decrement in ONE statement, so there is no SELECT … FOR UPDATE held
      // across the rest of this multi-step order transaction (which under a
      // single-SKU flash-sale storm serialized every checkout on the row lock).
      // A losing concurrent writer sees 0 rows affected → INSUFFICIENT_INVENTORY
      // (or backorder), never an oversell. Variant items decrement the variant
      // (authoritative check) AND the parent product (unconditional), matching
      // prior behavior; the InventoryHistory row tracks the PRODUCT stock, so we
      // capture the accurate product pre/post stock per line for the ledger.
      const stockChanges = new Map<string, { previousStock: number; newStock: number }>();
      for (const item of cart.items) {
        if (!item.product.trackInventory) continue;
        const qty = item.quantity;
        const variantId = (item as { variantId?: string }).variantId;
        const lineKey = `${item.productId}::${variantId ?? ''}`;

        let res = variantId
          ? await decrementVariantInventory(tx, variantId, qty)
          : await decrementProductInventory(tx, item.productId, qty);

        if (!res.ok) {
          // Insufficient stock — accept ONLY when BOTH the store feature flag
          // and the per-product/variant allowBackorder flag are set (the same
          // dual-check as before: a disabled feature must never silently
          // backorder just because the per-product flag is on). Fetched fresh
          // to match the prior FOR UPDATE behavior, only on the rare miss path.
          const perFlag = variantId
            ? (
                await tx.productVariant.findUnique({
                  where: { id: variantId },
                  select: { allowBackorder: true },
                })
              )?.allowBackorder
            : (
                await tx.product.findUnique({
                  where: { id: item.productId },
                  select: { allowBackorder: true },
                })
              )?.allowBackorder;
          if (!backorderFeatureEnabled || !perFlag) {
            throw new AppError(
              400,
              'INSUFFICIENT_INVENTORY',
              `Not enough inventory for ${item.product.name}${variantId ? ' (variant)' : ''}`
            );
          }
          // Backorder accepted — force the decrement (may go negative) + track
          // for BackorderLine creation below.
          res = variantId
            ? await forceDecrementVariantInventory(tx, variantId, qty)
            : await forceDecrementProductInventory(tx, item.productId, qty);
          backorderedItems.push({ productId: item.productId, variantId, quantity: qty });
        }

        // Variant sale also decrements the parent product.inventory
        // (unconditional, matching prior behavior); ledger tracks PRODUCT stock.
        if (variantId) {
          const prod = await forceDecrementProductInventory(tx, item.productId, qty);
          stockChanges.set(lineKey, {
            previousStock: prod.previousStock,
            newStock: prod.newStock,
          });
        } else {
          stockChanges.set(lineKey, {
            previousStock: res.previousStock,
            newStock: res.newStock,
          });
        }
      }

      // Per-customer coupon usage limit (money-integrity audit F3-adjacent
      // gap, 2026-07-02: `usageLimitPerUser` was collected + stored but
      // never enforced — only the store-wide `usageLimit` was). Count this
      // customer's PRIOR orders that redeemed the same coupon and reject
      // once they've reached the cap, mirroring the global-limit check's
      // semantics: an order only "counts" while it hasn't been
      // cancelled/refunded, because `applyRefundEffects`/`updateStatus`
      // decrement `Coupon.usageCount` back on those two statuses (see
      // order.service.ts ~1164-1171, ~733-737) — so a cancelled/refunded
      // order shouldn't count against the per-user cap either.
      //
      // Identify the customer the same way the rest of the order code does
      // (see aggregateCustomers in customers.routes.ts): registered
      // customers by `customerId`; guests by shipping-address email/phone
      // (JSON path match, same field names/precedent as the customer
      // detail lookup in customers.routes.ts). A guest checkout with
      // NEITHER an email nor a phone on the shipping address has no
      // reliable identity to check — we deliberately do NOT block in that
      // case (a false block on an unidentifiable guest is worse than the
      // narrow loophole; the store-wide usageLimit still caps total abuse).
      if (appliedCoupon && appliedCoupon.usageLimitPerUser && appliedCoupon.usageLimitPerUser > 0) {
        const guestEmail =
          typeof data.shippingAddress.email === 'string' && data.shippingAddress.email
            ? data.shippingAddress.email
            : undefined;
        const guestPhone =
          typeof data.shippingAddress.phone === 'string' && data.shippingAddress.phone
            ? data.shippingAddress.phone
            : undefined;

        const identityWhere: Prisma.OrderWhereInput | null = customerId
          ? { customerId }
          : guestEmail || guestPhone
            ? {
                OR: [
                  ...(guestEmail
                    ? [{ shippingAddress: { path: ['email'], equals: guestEmail } }]
                    : []),
                  ...(guestPhone
                    ? [{ shippingAddress: { path: ['phone'], equals: guestPhone } }]
                    : []),
                ],
              }
            : null;

        if (identityWhere) {
          const priorUsageCount = await tx.order.count({
            where: {
              storeId,
              couponCode: appliedCoupon.code,
              status: { notIn: ['cancelled', 'refunded'] },
              ...identityWhere,
            },
          });
          if (priorUsageCount >= appliedCoupon.usageLimitPerUser) {
            throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
          }
        }
      }

      // Atomically reserve a coupon redemption before creating the order so
      // that two concurrent checkouts can't both slip past a usage limit by
      // reading the same stale count. updateMany with a usageCount < limit
      // guard updates zero rows when the limit is reached, which we detect
      // via `count === 0` and roll back by throwing.
      if (appliedCoupon) {
        const reserve = await tx.coupon.updateMany({
          where: {
            id: appliedCoupon.id,
            isActive: true,
            ...(appliedCoupon.usageLimit ? { usageCount: { lt: appliedCoupon.usageLimit } } : {}),
          },
          data: { usageCount: { increment: 1 } },
        });
        if (reserve.count === 0) {
          throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
        }
      }

      // Create order
      const newOrder = await tx.order.create({
        data: {
          storeId,
          customerId,
          orderNumber,
          status: 'pending',
          subtotal,
          tax,
          shipping,
          discount,
          couponCode: appliedCoupon?.code ?? null,
          couponDiscount,
          loyaltyPointsRedeemed: loyaltyPointsRedeemed > 0 ? loyaltyPointsRedeemed : null,
          loyaltyDiscount,
          total,
          locale: data.locale ?? null,
          smsOptIn: data.smsOptIn ?? false,
          shippingAddress: data.shippingAddress,
          billingAddress: data.billingAddress || data.shippingAddress,
          notes: data.notes,
          items: {
            create: cart.items.map(item => ({
              productId: item.productId,
              // Persist the variant link onto OrderItem. Without this,
              // `updateStatus(cancel/refund)`, `rollbackForPaymentFailure`,
              // and `ReturnService.complete` all read OrderItem.variantId
              // to restore variant inventory — and always saw null.
              // Variant stock drifted every cancel/refund. CartItem
              // already carries variantId; we just have to copy it.
              variantId: (item as { variantId?: string | null }).variantId ?? null,
              productName: item.product.name,
              sku: item.product.sku,
              quantity: item.quantity,
              price: item.product.price,
              // Snapshot cost-of-goods at sale time so profit reports
              // stay correct even if the product's cost changes later.
              costPrice: item.product.costPrice ?? null,
              total: item.product.price * item.quantity,
            })),
          },
        },
        include: {
          items: true,
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      // Record inventory history. The decrement already happened atomically in
      // the loop above (stockChanges holds the accurate pre/post PRODUCT stock
      // per line); here we only write the ledger, atomic with the order via the
      // same transaction, using newOrder.id as the reference (DB-010). Collected
      // and written as a single createMany instead of one create() per line item.
      const inventoryHistoryRows = cart.items.flatMap(item => {
        if (!item.product.trackInventory) return [];
        const variantId = (item as { variantId?: string }).variantId;
        const sc = stockChanges.get(`${item.productId}::${variantId ?? ''}`);
        if (!sc) return [];
        return [
          {
            productId: item.productId,
            storeId,
            type: 'sale' as const,
            quantity: -item.quantity,
            previousStock: sc.previousStock,
            newStock: sc.newStock,
            reason: 'Sold via order',
            reference: newOrder.id,
          },
        ];
      });
      if (inventoryHistoryRows.length > 0) {
        await tx.inventoryHistory.createMany({ data: inventoryHistoryRows });
      }

      // Create BackorderLine rows and mark OrderItems as cost-deferred for any
      // items that were allowed through with insufficient inventory.
      if (backorderedItems.length > 0) {
        for (const newItem of newOrder.items) {
          const bo = backorderedItems.find(
            b =>
              b.productId === newItem.productId &&
              (b.variantId ?? null) === (newItem.variantId ?? null)
          );
          if (!bo) continue;
          await tx.backorderLine.create({
            data: {
              storeId,
              orderItemId: newItem.id,
              productId: newItem.productId,
              variantId: newItem.variantId,
              qty: newItem.quantity,
            },
          });
          await tx.orderItem.update({
            where: { id: newItem.id },
            data: { costPriceDeferred: true },
          });
        }
      }

      // Redeem loyalty points INSIDE the order transaction so the point
      // decrement + the redeem_discount ledger row commit atomically with the
      // order — points are never spent without an order, and the order is
      // never created without the deduction. The conditional gate inside
      // redeemPoints makes a concurrent checkout that already drained the
      // balance throw INSUFFICIENT_POINTS here, rolling back this whole order.
      // customerId is guaranteed non-null here (guests never set
      // loyaltyPointsRedeemed > 0 above).
      if (loyaltyPointsRedeemed > 0 && customerId) {
        await LoyaltyService.redeemPoints(
          storeId,
          customerId,
          newOrder.id,
          loyaltyPointsRedeemed,
          tx
        );
      }

      // Clear cart
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // Check for abandoned cart recovery
      try {
        const abandonedCart = await tx.abandonedCart.findFirst({
          where: {
            storeId,
            OR: [
              { cartId: cart.id },
              { customerId: cart.customerId, status: { not: 'recovered' } },
            ],
            status: { in: ['pending', 'step1_sent', 'step2_sent', 'step3_sent'] },
          },
        });
        if (abandonedCart) {
          await tx.abandonedCart.update({
            where: { id: abandonedCart.id },
            data: {
              status: 'recovered',
              recoveredAt: new Date(),
              recoveredOrderId: newOrder.id,
            },
          });
          logger.info(`Abandoned cart ${abandonedCart.id} recovered by order ${newOrder.id}`);
        }
      } catch (err) {
        logger.error({ err }, 'Abandoned cart recovery detection failed');
        // Never fail order creation
      }

      return newOrder;
    });

    // Link order to affiliate referral. Must be awaited (not fire-and-forget):
    // the per-request tenant tx (held by tenantContext until res.finish) can
    // commit before a detached promise's bare prisma.* calls run, silently
    // dropping commission attribution with no reconciliation sweep. Awaiting
    // keeps it inside the same request flow/tx, mirroring reverseCommission's
    // await+catch pattern below (refund path).
    if (referralCode) {
      await affiliateService
        .linkOrderToReferral(storeId, order.id, referralCode)
        .catch(err => logger.error({ err }, 'Affiliate referral link failed'));
    }

    // Notifications: only fire NOW for COD orders. For online-payment orders
    // (Tap / MyFatoorah / Hesabe / UPayments) the customer hasn't actually
    // paid yet at this point — firing emails / push / dispatcher here would
    // produce "new order" pings that turn into ghosts when the customer
    // abandons at the gateway and the order rolls back. Online-payment
    // notifications fire from PaymentService.handleWebhook once payment
    // transitions to 'completed' (see payment.factory.ts).
    if (data.paymentMethod === 'cod') {
      inngest
        .send({
          name: 'order/created',
          data: {
            orderId: order.id,
            storeId,
            paymentMethod: data.paymentMethod,
            locale: order.locale ?? undefined,
          },
        })
        .catch((err: unknown) =>
          logger.error({ err, orderId: order.id }, 'Failed to enqueue order/created')
        );

      try {
        socketService.newOrderNotification(storeId, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          total: order.total,
          customerName:
            `${order.customer?.firstName || ''} ${order.customer?.lastName || ''}`.trim() ||
            order.customer?.email ||
            'Customer',
        });
      } catch (notifyError) {
        logger.error({ err: notifyError }, 'Failed to send order notification');
      }
    }

    // Checkout decremented inventory inside the tx above (now committed) — bust
    // the storefront product caches so a sold-out item stops showing "in stock".
    await bustProductCaches(storeId);

    return order;
  }

  /**
   * Compensating action when /payments/create fails AFTER an order has been
   * committed (cart cleared, inventory decremented, coupon usage incremented).
   *
   * Rebuilds the customer's cart from the order items, restores inventory,
   * rolls back any coupon redemption, and marks the order as cancelled. Idempotent
   * — safe to call twice; will return early if the order is already cancelled
   * or has any payment record.
   *
   * Without this, every failed payment attempt strands an unpaid pending order
   * with empty-cart-on-server, blocking the customer from retrying and slowly
   * draining inventory.
   */
  static async rollbackForPaymentFailure(
    storeId: string,
    orderId: string,
    sessionId: string
  ): Promise<void> {
    await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, storeId },
        include: { items: true, payments: true },
      });

      // Idempotent guards
      if (!order) return;
      if (order.status === 'cancelled') return;
      if (order.payments.length > 0) return;
      if (order.status !== 'pending') return; // Don't roll back further-progressed orders

      // 1. Restore inventory (mirror what create() decremented)
      for (const item of order.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { trackInventory: true, inventory: true },
        });
        if (!product?.trackInventory) continue;

        await tx.product.update({
          where: { id: item.productId },
          data: { inventory: { increment: item.quantity } },
        });

        await tx.inventoryHistory.create({
          data: {
            productId: item.productId,
            storeId,
            type: 'adjustment',
            quantity: item.quantity,
            previousStock: product.inventory,
            newStock: product.inventory + item.quantity,
            reason: 'Order rollback — payment step failed',
            reference: order.id,
          },
        });
      }

      // 2. Roll back coupon usage if one was reserved
      if (order.couponCode) {
        await tx.coupon.updateMany({
          where: { storeId, code: order.couponCode },
          data: { usageCount: { decrement: 1 } },
        });
      }

      // 3. Rebuild the cart from the order items so the customer can retry
      const cart = await tx.cart.findFirst({
        where: { storeId, sessionId },
      });
      const cartId =
        cart?.id ??
        (
          await tx.cart.create({
            data: { storeId, sessionId, customerId: order.customerId },
          })
        ).id;

      // Clear any current items first (defensive — usually empty post-create)
      await tx.cartItem.deleteMany({ where: { cartId } });
      // Re-create items from the order. CartItem has no price column —
      // price is read from the product at cart-render time.
      for (const item of order.items) {
        await tx.cartItem.create({
          data: {
            cartId,
            productId: item.productId,
            variantId: item.variantId ?? undefined,
            quantity: item.quantity,
          },
        });
      }

      // 4. Mark the order cancelled with a paper trail
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          notes:
            (order.notes ? order.notes + '\n' : '') +
            '[auto-cancelled: payment step failed before completion]',
        },
      });
    });

    logger.info(
      { orderId, storeId },
      'Order rolled back after payment-create failure (inventory + cart restored)'
    );

    // Inventory was restored in the tx above — bust product caches so stock
    // reappears as available on the storefront.
    await bustProductCaches(storeId);
  }

  static async updateStatus(
    storeId: string,
    orderId: string,
    status:
      | 'pending'
      | 'confirmed'
      | 'processing'
      | 'shipped'
      | 'delivered'
      | 'cancelled'
      | 'refunded'
  ) {
    const order = await this.getById(storeId, orderId);

    // Validate status transition — shared with the payment-gateway/webhook
    // direct writers via `assertValidTransition` (see its doc comment for
    // the allowed-list rationale).
    assertValidTransition(order.status, status);

    // Set deliveredAt when transitioning to delivered so the review-request
    // Inngest function has an accurate timestamp for the 90-day token expiry.
    const statusData: Record<string, unknown> = { status };
    if (status === 'delivered' && order.status !== 'delivered') {
      statusData.deliveredAt = new Date();
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId, storeId },
      data: statusData,
      include: {
        items: true,
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    // Bust the admin aggregated-customers snapshot — a status change can move
    // an order in/out of the totals it aggregates (total-spent, order-count,
    // last-order-date), so the cache must not serve a stale snapshot for up
    // to its 300s TTL after a mutation like this.
    await invalidateCustomersCache(storeId);

    // Append-only status audit trail. `order.status` was read (via getById)
    // BEFORE the update above, so it is the true prior status. Best-effort:
    // mirrors recordPaymentEvent — a failed audit write must never block the
    // status change (the Order row is the source of truth; this is the aid).
    // actorId is null here: updateStatus has no acting-user id in scope.
    try {
      await prisma.orderEvent.create({
        data: {
          storeId,
          orderId,
          fromStatus: order.status,
          toStatus: status,
          actorId: null,
        },
      });
    } catch (err) {
      logger.error(
        { err, orderId, storeId, fromStatus: order.status, toStatus: status },
        '[ORDER-EVENT] failed to record status change'
      );
    }

    // Refund / cancellation side-effects: inventory restore + coupon
    // decrement + affiliate-commission reversal + the order/refunded fanout
    // (which sends the merchant the "Refund issued" push + the customer the
    // refund email). Centralised in applyRefundEffects so gateway-driven
    // refunds (which bypass this method) get the exact same treatment.
    //
    // GATE: only run the refund reversal + "Refund issued" notification when
    // the order actually had a CAPTURED payment. Cancelling an UNPAID order
    // (e.g. an online order whose payment link was never completed, or an
    // auto-cancel of a stale unpaid order) must NOT fire a refund — there was
    // never any money to give back. Firing applyRefundEffects on an unpaid
    // cancel was sending merchants a spurious "Refund issued" push. We treat
    // an order as paid when its durable paymentStatus is 'paid' OR a Payment
    // row reached 'completed' (the two are kept in lock-step, but check both
    // so a partially-reconciled order is never mis-classified as unpaid).
    const hadCapturedPayment = hasCapturedPayment(order);
    if (status === 'cancelled' || status === 'refunded') {
      // ALWAYS reverse stock/coupons/loyalty on a cancel/refund (the order
      // reserved them — the `order/refunded` fanout applies them as
      // idempotent, retriable steps, so repeat calls are safe) — but
      // only fire the refund notification ("Refund issued" push + customer
      // refund email) when this is a GENUINE new refund via
      // `shouldApplyRefundEffects` (paid AND not already refunded).
      // `refunded` is terminal in `validTransitions` above, so the
      // not-already-refunded arm can't be reached from updateStatus today;
      // it's kept as a defensive belt-and-suspenders guard (and matters for
      // any future caller / a refunded→X transition) so a bookkeeping
      // re-touch of an already-refunded order can never double-notify.
      // `order` here is the PRE-transition snapshot fetched via getById
      // above, so `order.status` is the true prior status.
      await this.applyRefundEffects(storeId, orderId, {
        fireRefundNotification: shouldApplyRefundEffects(status, order),
      });
    }

    // Post-purchase side effects (payment-success / shipped / admin-refund
    // emails, WhatsApp/SMS/push dispatch, affiliate commission, loyalty award,
    // shipping-carrier auto-create) now fan out on the `order/status-changed`
    // Inngest event as retriable steps that dead-letter on failure (Lens E,
    // E2-4) — they used to run here as in-process fire-and-forget `.catch(log)`
    // calls that vanished silently on a provider outage or a mid-deploy. Only
    // the money reversal (applyRefundEffects, above — awaited) and the
    // real-time socket ping (below — fast in-process) stay inline.
    if (status === 'delivered') {
      // Existing event kept: 7-day review-request job + WBS delivered notify.
      inngest
        .send({ name: 'order/delivered', data: { orderId, storeId } })
        .catch((err: unknown) =>
          logger.error({ err, orderId }, 'Failed to enqueue order/delivered event')
        );
    }
    if (status === 'shipped') {
      // Existing event kept: WBS shipping notification.
      inngest
        .send({ name: 'order/shipped', data: { orderId, storeId } })
        .catch((err: unknown) =>
          logger.error({ err, orderId }, 'Failed to enqueue order/shipped event')
        );
    }
    inngest
      .send({
        name: 'order/status-changed',
        data: { orderId, storeId, status, hadCapturedPayment },
      })
      .catch((err: unknown) => {
        // Unlike `order/created` (which has order-created-stuck-sweep), this
        // event has no recovery sweep — so a failed enqueue (Inngest outage /
        // mid-deploy) would silently lose EVERY migrated side effect. Fall back
        // to running the fanout in-process (same pattern as the payment-webhook
        // inline fallback). Dynamic import avoids a load-time import cycle
        // (the fanout pulls in several services). Best-effort + non-blocking.
        logger.error(
          { err, orderId, status },
          'Failed to enqueue order/status-changed — running fanout inline as fallback'
        );
        handleOrderStatusChanged(orderId, storeId, status, hadCapturedPayment, {
          run: <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
        }).catch((e: unknown) =>
          logger.error(
            { err: e, orderId, status },
            'order/status-changed inline fallback also failed'
          )
        );
      });

    // Send real-time notification to customer
    try {
      socketService.orderStatusNotification(updatedOrder.customerId!, {
        orderNumber: updatedOrder.orderNumber,
        status,
      });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send order status notification');
    }

    return updatedOrder;
  }

  /**
   * Dispatcher for a refund/cancel's money reversals: inventory restore,
   * coupon usage decrement, affiliate-commission reversal, loyalty
   * earn/redeem reversal, and backorder-line cancellation. Provider-driven
   * refunds (payment.factory.refund) used to update the order row directly
   * and bypass `updateStatus()`, leaving stock under-counted, coupon limits
   * over-counted, and affiliates with refunded earnings still on their
   * balance. Centralised here so every refund path (gateway-initiated,
   * return-driven, manual admin) applies the same effects.
   *
   * Money-integrity redesign (2026-07-16): the reversals themselves used to
   * run INLINE, in this method, inside the caller's request-scoped
   * `withMoneyTx` — on a heavy order that exceeded the transaction's 30s
   * budget (`P2028`), the reversals half-applied and could never retry,
   * while the order's status flip (committed separately by `updateStatus`)
   * survived. This method is now a thin dispatcher: it fires `order/refunded`
   * with the reversal flags, and every reversal moves into the
   * `order-refunded` Inngest fanout as its own retriable, idempotent
   * `step.run` (see `lib/inngest/functions/order-refunded.ts`) that
   * dead-letters on failure instead of silently losing money state.
   *
   * The event fires for EVERY cancel/refund — a paid refund AND an unpaid
   * cancel — because stock/coupons were reserved either way and must be
   * released either way. Only the customer-facing "Refund issued"
   * notification is conditional, carried as the `notify` flag (paid AND
   * genuinely-new refund, via `shouldApplyRefundEffects` upstream in
   * `updateStatus`, or the caller's `fireRefundNotification` option for
   * direct callers like ReturnService/backorder cancel).
   */
  static async applyRefundEffects(
    storeId: string,
    orderId: string,
    options: { restoreInventory?: boolean; fireRefundNotification?: boolean } = {}
  ): Promise<void> {
    const restoreInventory = options.restoreInventory ?? true;
    // Whether to fire the "Refund issued" merchant push + customer refund
    // email inside the order-refunded fanout. Defaults true for genuine
    // provider refunds. Cancelling an UNPAID order still restores
    // inventory/coupons/loyalty (the stock was reserved) but must NOT claim
    // a refund happened.
    const notify = options.fireRefundNotification ?? true;
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      select: { id: true },
    });
    if (!order) return;

    // Let a failed enqueue propagate — every call site already handles
    // applyRefundEffects failures (catch-and-log, or a deliberate
    // let-it-propagate for Inngest-step retry semantics). Swallowing it
    // here would silently drop the ONLY signal that fires the reversals
    // (inventory/coupon/affiliate/loyalty/backorder), which is exactly the
    // silent money-loss failure mode this redesign removes.
    await inngest.send({
      name: 'order/refunded',
      data: { orderId, storeId, restoreInventory, notify },
    });
  }

  static async getCustomerOrders(
    storeId: string,
    customerId: string,
    options: { page?: number; limit?: number } = {}
  ) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(50, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = { storeId, customerId, deletedAt: null };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          items: {
            include: {
              product: {
                include: { images: { take: 1, orderBy: { position: 'asc' } } },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Admin-initiated order. Used when a merchant takes a phone order on
   * behalf of a customer who couldn't / didn't complete checkout
   * themselves. Skips cart resolution (no client cart involved) and
   * validates product prices server-side against the catalog —
   * NEVER trust client-asserted price/total.
   *
   * Creates the order in 'pending' / 'unpaid' state; the admin can
   * then issue a MyFatoorah payment link via the existing
   * /orders/:id/payment-link endpoint, OR mark it COD-paid, OR call
   * mark-paid once cash is collected. Ahmad 2026-05-16: 'admin can
   * land an order ... and copy the payment link'.
   */
  static async createAdminOrder(
    storeId: string,
    adminUserId: string,
    data: {
      // Customer: either an existing User.id OR guest contact info on
      // shippingAddress (firstName/lastName/email/phone).
      customerId?: string;
      shippingAddress: Record<string, unknown>;
      billingAddress?: Record<string, unknown>;
      items: Array<{
        productId: string;
        variantId?: string;
        quantity: number;
      }>;
      paymentMethod?: 'online' | 'cod';
      paymentProvider?: 'tap' | 'myfatoorah' | 'hesabe' | 'upayments' | 'cod';
      notes?: string;
      couponCode?: string;
      currency?: string;
      /**
       * Optional shipping fee override in integer fils (KWD × 1000).
       * When present, replaces the ShippingService-computed fee.
       * Used for negotiated phone-order rates.
       */
      shippingOverride?: number;
    }
  ) {
    if (data.items.length === 0) {
      throw new AppError(400, 'NO_ITEMS', 'Order must have at least one item');
    }

    // Hydrate product + variant prices from the DB. Admin form
    // submits only productId + quantity; we look up the canonical
    // price here so a tampered or stale price never persists.
    const productIds = Array.from(new Set(data.items.map(it => it.productId)));
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId, status: 'active' },
      include: {
        variants: true,
      },
    });
    const productMap = new Map(products.map(p => [p.id, p]));

    const resolved = data.items.map(it => {
      const product = productMap.get(it.productId);
      if (!product) {
        throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${it.productId} not found`);
      }
      let unitPrice = product.price;
      let variantSku: string | undefined;
      let variantTitle: string | undefined;
      if (it.variantId) {
        const variant = product.variants.find(v => v.id === it.variantId);
        if (!variant) {
          throw new AppError(
            404,
            'VARIANT_NOT_FOUND',
            `Variant ${it.variantId} not found for product ${product.name}`
          );
        }
        if (typeof variant.price === 'number') unitPrice = variant.price;
        variantSku = variant.sku ?? undefined;
        variantTitle = variant.title ?? undefined;
      }
      const quantity = Math.max(1, Math.floor(it.quantity));
      const lineTotal = unitPrice * quantity;
      return {
        productId: product.id,
        productName: product.name,
        sku: variantSku ?? product.sku ?? undefined,
        variantId: it.variantId,
        variantTitle,
        unitPrice,
        quantity,
        lineTotal,
      };
    });

    const subtotal = resolved.reduce((sum, r) => sum + r.lineTotal, 0);

    // Tax: same store-level resolution as the public checkout path.
    const taxRates = await prisma.taxRate.findMany({ where: { storeId, isActive: true } });
    const taxRate = taxRates.length > 0 ? Number(taxRates[0].rate) / 100 : 0;
    const tax = Math.round(subtotal * taxRate);

    // Shipping: try to resolve via ShippingService; fall back to 0 on
    // error (same defensive posture as public checkout).
    const shippingArea =
      typeof data.shippingAddress.area === 'string'
        ? (data.shippingAddress.area as string)
        : ((data.shippingAddress.city as string) ?? '');
    const shippingGovernorate =
      typeof data.shippingAddress.governorate === 'string'
        ? (data.shippingAddress.governorate as string)
        : undefined;
    let shipping = 0;
    try {
      // NOTE: this is the ADMIN manual-order path (createAdminOrder). Unlike
      // the customer checkout, it is intentionally NOT guarded against an
      // unpriced area — an authenticated admin may legitimately create an
      // order for any area and set/adjust shipping themselves.
      const res = await ShippingService.calculateShipping(
        storeId,
        shippingArea,
        subtotal,
        shippingGovernorate
      );
      shipping = res.freeShipping ? 0 : res.shippingCost;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, storeId, shippingArea },
        '[Admin-Order] shipping calculation failed; defaulting to 0'
      );
    }

    // Manual override: if the admin specified a negotiated shipping fee
    // (integer fils), it takes precedence over the calculated value.
    // This is intentionally applied AFTER calculateShipping so that any
    // future coupon type=free_shipping still runs against the base fee
    // first (the coupon block below may zero it out regardless).
    if (typeof data.shippingOverride === 'number') {
      const calculatedShipping = shipping;
      shipping = data.shippingOverride;
      logger.info(
        { storeId, shippingOverride: data.shippingOverride, calculatedShipping },
        '[Admin-Order] shipping override applied'
      );
    }

    // Coupon: resolved server-side via CouponService just like the
    // public flow.
    let couponDiscount = 0;
    let couponCode: string | undefined;
    // Kept in outer scope (not just `couponCode`) so the per-user usage
    // check inside the transaction below can read `usageLimitPerUser` —
    // mirrors `appliedCoupon` in OrderService.create.
    let appliedCoupon: Awaited<ReturnType<typeof CouponService.getByCode>> | null = null;
    if (data.couponCode) {
      appliedCoupon = await CouponService.getByCode(storeId, data.couponCode);
      if (appliedCoupon.minOrderAmount && subtotal < appliedCoupon.minOrderAmount) {
        throw new AppError(
          400,
          'MIN_ORDER_NOT_MET',
          `Minimum order amount of ${(appliedCoupon.minOrderAmount / 1000).toFixed(
            3
          )} KWD required for this coupon`
        );
      }
      if (appliedCoupon.type === 'free_shipping') {
        shipping = 0;
      } else {
        couponDiscount = CouponService.calculateDiscount(
          {
            type: appliedCoupon.type,
            value: appliedCoupon.value,
            maxDiscount: appliedCoupon.maxDiscount,
          },
          subtotal
        );
      }
      couponCode = appliedCoupon.code;
    }

    const total = Math.max(0, subtotal + tax + shipping - couponDiscount);
    const orderNumber = generateOrderNumber();

    // Create the order + items in one transaction. Inventory is NOT
    // decremented for admin orders by default — the merchant
    // confirms physical availability before placing. The mark-paid
    // path elsewhere decrements as needed when payment lands.
    const order = await withMoneyTx(prisma, async (tx: Prisma.TransactionClient) => {
      // Per-customer coupon usage limit (same money-integrity gap as
      // OrderService.create, 2026-07-02 audit: createAdminOrder resolved
      // coupons via CouponService.getByCode, which only enforces the
      // store-wide `usageLimit` — `usageLimitPerUser` was never checked on
      // this path, so an admin/phone order could bypass a customer's cap).
      // Identity resolution mirrors create(): registered customers by
      // `customerId`; guests by shippingAddress email/phone. An
      // unidentifiable guest (neither) is deliberately NOT blocked — same
      // narrow-loophole tradeoff as create() (store-wide usageLimit still
      // caps total abuse).
      if (
        couponCode &&
        appliedCoupon &&
        appliedCoupon.usageLimitPerUser &&
        appliedCoupon.usageLimitPerUser > 0
      ) {
        const guestEmail =
          typeof data.shippingAddress.email === 'string' && data.shippingAddress.email
            ? (data.shippingAddress.email as string)
            : undefined;
        const guestPhone =
          typeof data.shippingAddress.phone === 'string' && data.shippingAddress.phone
            ? (data.shippingAddress.phone as string)
            : undefined;

        const identityWhere: Prisma.OrderWhereInput | null = data.customerId
          ? { customerId: data.customerId }
          : guestEmail || guestPhone
            ? {
                OR: [
                  ...(guestEmail
                    ? [{ shippingAddress: { path: ['email'], equals: guestEmail } }]
                    : []),
                  ...(guestPhone
                    ? [{ shippingAddress: { path: ['phone'], equals: guestPhone } }]
                    : []),
                ],
              }
            : null;

        if (identityWhere) {
          const priorUsageCount = await tx.order.count({
            where: {
              storeId,
              couponCode,
              status: { notIn: ['cancelled', 'refunded'] },
              ...identityWhere,
            },
          });
          if (priorUsageCount >= appliedCoupon.usageLimitPerUser) {
            throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
          }
        }
      }

      const created = await tx.order.create({
        data: {
          orderNumber,
          storeId,
          customerId: data.customerId ?? null,
          status: 'pending',
          paymentStatus: 'unpaid',
          subtotal,
          tax,
          shipping,
          discount: couponDiscount,
          total,
          currency: data.currency ?? 'KWD',
          couponCode: couponCode ?? null,
          shippingAddress: data.shippingAddress as Prisma.InputJsonValue,
          billingAddress: (data.billingAddress ?? data.shippingAddress) as Prisma.InputJsonValue,
          notes: data.notes ?? null,
          items: {
            create: resolved.map(r => ({
              productId: r.productId,
              productName: r.productName,
              sku: r.sku,
              variantId: r.variantId,
              variantTitle: r.variantTitle,
              price: r.unitPrice,
              quantity: r.quantity,
              total: r.lineTotal,
            })),
          },
        },
        include: {
          items: true,
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      });
      return created;
    });

    await auditLog({
      action: 'order.admin_created',
      userId: adminUserId,
      resourceType: 'order',
      resourceId: order.id,
      details: {
        orderNumber: order.orderNumber,
        itemsCount: resolved.length,
        total,
      },
    });

    logger.info(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        adminUserId,
        itemsCount: resolved.length,
      },
      '[Admin-Order] created on behalf of customer'
    );

    return order;
  }
}
