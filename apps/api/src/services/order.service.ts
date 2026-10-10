import { randomUUID } from 'node:crypto';
import {
  prisma,
  Prisma,
  OrderStatus,
  withMoneyTx,
  scopeTransaction,
  withStore,
} from '@force/database';
import {
  checkMinimumOrder,
  allocateBundlePrice,
  codFeeForOrder,
  computeOrderAmounts,
  fromMinor,
  minorToDecimalString,
  normalizePhoneForStorage,
  REGION,
} from '@force/shared';
import { FiscalDocumentService } from './fiscal-document.service';
import { recordPaymentEvent } from './payment-event.service';

/** An address JSON with its `phone` in the one stored form (ruling MONEYB-7). */
function withStoredPhone(addr: Record<string, unknown>): Record<string, unknown> {
  return typeof addr.phone === 'string'
    ? { ...addr, phone: normalizePhoneForStorage(addr.phone) }
    : addr;
}
import { loadCodFeeConfig } from './payment-providers/cod.provider';
import { generateOrderNumber } from '../utils/order-number';
import { cartLineUnitPrice } from '../lib/cart-pricing';
import { pairBackorderedLines } from '../lib/backorder-pairing';
import { restoreCartShape } from '../lib/order-cart-restore';
import { AppError } from '../middleware/error-handler';
import { CartService } from './cart.service';
import { resolveBundle } from './bundle.service';
import { STOREFRONT_PRODUCT_SELECT } from './product.service';
import { CouponService, type CouponRuleViolation } from './coupon.service';
import {
  COUPON_OVERRIDE_AUDIT_ACTION,
  COUPON_OVERRIDE_EVENT,
  COUPON_OVERRIDE_ROLES,
} from '../lib/coupon-override';
import { resolveCustomerContext, resolveBestPromotion } from './promotion-resolver';
import { socketService } from './socket.service';
import { featureService } from './feature.service';
import {
  decrementProductInventory,
  decrementVariantInventory,
  forceDecrementVariantInventory,
} from './inventory-decrement';
import { inngest } from '../lib/inngest/client';
import { handleOrderStatusChanged } from '../lib/inngest/functions/order-status-changed';
import { ShippingService } from './shipping.service';
import { LoyaltyService, computeRedemption } from './loyalty.service';
import { WalletService } from './wallet.service';
import { affiliateService } from './affiliate.service';
import { auditLog } from '../middleware/security';
import { hasCapturedPayment, shouldApplyRefundEffects } from './order-refund-gating';
import logger from '../lib/logger';
import { frozenTaxInvoiceFields, resolveActiveTaxRate } from '../lib/order-tax';
import {
  invalidateStoreProductCachesAfterOrder,
  invalidateCustomersCache,
} from '../lib/public-cache';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { assertOrderAllowed, noteOrderCreated } from './plan-limit.service';
import { amountOnlyRefundKey } from '../lib/refund-methods';
import { lineUnitCost } from '../lib/order-line-cost';
import { customerKeyOf } from '../lib/customer-key';
import { SmsConsentService } from './sms-consent.service';
import { assertStockHoldCapNotExceeded } from '../lib/stock-hold-cap';

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
    // Stock-only change: Redis cleared now, storefront purge coalesced per
    // store during a burst of orders (#1220) — see public-cache.ts.
    await invalidateStoreProductCachesAfterOrder(storeId);
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
import { withSavepoint } from '../lib/savepoint';
export { assertValidTransition, VALID_ORDER_TRANSITIONS };

/**
 * Payment fields safe to return on `getById`/`getByOrderNumber` — this route
 * is reachable by the owning CUSTOMER (order.routes.ts:439), not just store
 * staff, so `payments: true` would leak gateway internals (`refundId`,
 * `failureReason`, raw `metadata` JSON) to the customer. Verified against
 * every consumer: apps/web's customer order view (transactionId, invoiceId),
 * apps/admin's + apps/orders' PaymentCard/ActionFooter (transactionId,
 * paymentUrl) — none read refundId/failureReason/metadata/refundedAmount
 * from this endpoint (refund results come back from the separate
 * POST /refund-via-provider response instead).
 */
const ORDER_PAYMENT_SELECT = {
  id: true,
  provider: true,
  method: true,
  status: true,
  amount: true,
  // What a refund-via-provider may still send is `amount - refundedAmount`
  // on the row that route picks; the admin/PWA confirm dialog quotes it (#2069).
  refundedAmount: true,
  transactionId: true,
  invoiceId: true,
  paymentUrl: true,
  paidAt: true,
  createdAt: true,
} as const satisfies Prisma.PaymentSelect;

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
  /** Customer-wallet spend request (D1). A REQUEST, never a trusted amount:
   *  the server spends min(balance, order total) and only when the store has
   *  BOTH `customer_wallet` and `customer_wallet_checkout` on and accounting
   *  off (WalletService.getCheckoutAvailability). Ignored for guests. */
  useWallet?: boolean;
  /** Buyer's UI locale at checkout time. Stored on the order so
   *  transactional emails are sent in the buyer's language. */
  locale?: 'en' | 'ar';
  /**
   * Customer SMS marketing opt-in captured at checkout. When true the customer
   * has explicitly consented to PROMOTIONAL SMS. Transactional SMS (shipped,
   * delivered, cancelled, refunded) are always allowed regardless of this flag.
   */
  smsOptIn?: boolean;
  /**
   * Order provenance — 'web' (human checkout, default) | 'agent' (MCP
   * place_order tool). Audit-only: never grants/restricts anything, only
   * stamped onto Order.source for reporting. Existing callers (public
   * checkout, authenticated storefront checkout) never pass this, so they
   * keep getting the 'web' default — no behavior change.
   */
  source?: string;
}

/**
 * The admin order list's filters, shared by `OrderService.list` and the
 * orders XLSX export so the export is exactly what the list shows (owner
 * report 2026-09-30: the export ignored every filter on screen).
 */
export interface OrderListWhere {
  status?: string;
  paymentStatus?: string;
  customerId?: string;
  from?: Date;
  to?: Date;
  /**
   * Free-text search over order number and the customer's name / email /
   * phone (registered customers).
   * Server-side, so it matches across ALL pages — the admin used to filter
   * only the 25 rows it had fetched.
   */
  search?: string;
  confirmedOnly?: boolean;
}

/**
 * Most customer ids the order search resolves up front. Above this the term
 * is too broad for an id list to be worth binding, and the search falls back
 * to the relation filter (same rows, unindexed plan). 1000 bind parameters is
 * nowhere near Postgres' 65535 ceiling.
 */
export const ORDER_SEARCH_CUSTOMER_ID_CAP = 1000;

/** The `shipping_address` keys a guest's contact lives under (see `contactOf`, lib/customer-key.ts). */
const GUEST_CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;

/**
 * The OR arms of the order-list search: order number, or the registered
 * customer's first name / last name / email / phone (issue 2405).
 *
 * WHY two steps. The obvious shape — `customer: { is: { firstName: contains } }`
 * per field — is compiled by Prisma into four LEFT JOINs onto `users` with an
 * OR spanning both tables. No index can serve an OR whose arms live on
 * different sides of a join, so every keystroke walked the store's whole
 * order history (measured: 150-270 ms per query at 50k orders, twice per
 * search because the list also counts). Resolving the matching customers
 * first turns every arm into a predicate on `orders` itself —
 * `order_number ILIKE` (trigram GIN) OR `customer_id IN (...)` (btree) —
 * which Postgres answers with a BitmapOr (measured: under 1 ms). The customer
 * lookup is itself a BitmapOr over the four `users` trigram indexes. Both
 * sets of indexes: migration 20261002090000_order_search_trgm_and_fk_indexes.
 *
 * Same rows as the relation filter, by construction: an order matches iff its
 * number matches or its customer matches on one of the four fields. The
 * customer lookup is restricted to users with an order in THIS store (a
 * semi-join, bounded by the store's own customers), not by `users.store_id` —
 * a registered customer's `store_id` is not necessarily the order's store.
 *
 * GUEST orders (`customer_id IS NULL`, contact only in the `shipping_address`
 * JSON) are matched by the same term on first name, last name, email and phone
 * through `guestOrderIdsMatching`, served by the partial expression trigram
 * indexes of migration 20261003100000_order_search_guest_contact_trgm_idx.
 *
 * Falls back to the relation filter when the term is shorter than a trigram
 * (3 chars — the indexes cannot serve it, so the lookup would only add a
 * scan). A term matching more than `ORDER_SEARCH_CUSTOMER_ID_CAP` customers
 * or guest orders degrades ONLY that half to its relation/JSON arm; the other
 * half keeps its indexed `IN (...)` arm (issue 2444).
 */
export async function orderSearchWhere(
  storeId: string,
  search: string
): Promise<Prisma.OrderWhereInput[]> {
  const contains = { contains: search, mode: 'insensitive' as const };
  const customerMatch: Prisma.UserWhereInput[] = [
    { firstName: contains },
    { lastName: contains },
    { email: contains },
    { phone: contains },
  ];
  // GUEST orders (no `customer_id`) carry the buyer's contact only in the
  // `shipping_address` JSON snapshot — the same place `customerKeyOf` reads
  // email/phone from. 174 of 188 production orders are guest orders. The JSON
  // path filter is the unindexed twin of `guestOrderIdsMatching` below.
  const guestJsonMatch: Prisma.OrderWhereInput = {
    customerId: null,
    OR: GUEST_CONTACT_FIELDS.map(field => ({
      shippingAddress: { path: [field], string_contains: search, mode: 'insensitive' as const },
    })),
  };
  const relationFallback: Prisma.OrderWhereInput[] = [
    { orderNumber: contains },
    { customer: { is: { OR: customerMatch } } },
    guestJsonMatch,
  ];
  if (search.length < 3) return relationFallback;

  // The matching customers are read THROUGH this store's orders (keyed by `storeId`, which is
  // what the tenant guard requires), not from `users` directly. That is also the exact
  // relation-join semantics: a customer with users.store_id NULL, or registered on another
  // store, matches when they ordered here. Filtering `users.store_id = storeId` would drop them.
  const [customerRows, guestOrderIds] = await Promise.all([
    prisma.order.groupBy({
      by: ['customerId'],
      where: { storeId, customerId: { not: null }, customer: { is: { OR: customerMatch } } },
      orderBy: { customerId: 'asc' },
      take: ORDER_SEARCH_CUSTOMER_ID_CAP + 1,
    }),
    guestOrderIdsMatching(storeId, search),
  ]);
  const customers = customerRows.map(r => ({ id: r.customerId as string }));
  // Each half degrades on its OWN: a broad guest term (every Egyptian guest phone starts `+20`)
  // must not cost the registered half its indexed `customer_id IN (...)` arm, nor the reverse
  // (issue 2444). Both over the cap is exactly `relationFallback`.
  const arms: Prisma.OrderWhereInput[] = [{ orderNumber: contains }];
  if (customers.length > ORDER_SEARCH_CUSTOMER_ID_CAP) {
    arms.push({ customer: { is: { OR: customerMatch } } });
  } else if (customers.length > 0) {
    arms.push({ customerId: { in: customers.map(c => c.id) } });
  }
  if (guestOrderIds.length > ORDER_SEARCH_CUSTOMER_ID_CAP) {
    arms.push(guestJsonMatch);
  } else if (guestOrderIds.length > 0) {
    arms.push({ id: { in: guestOrderIds } });
  }
  return arms;
}

/** `%term%` with LIKE metacharacters escaped, so the term is matched literally. */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Ids of this store's live GUEST orders whose shipping contact (first name,
 * last name, email or phone) contains `search`, capped at
 * `ORDER_SEARCH_CUSTOMER_ID_CAP + 1` so the caller can tell "too many".
 *
 * The WHERE is shaped to match the partial expression GIN indexes of
 * migration 20261003100000_order_search_guest_contact_trgm_idx exactly:
 * `customer_id IS NULL` is the index predicate and each ILIKE reads the same
 * `shipping_address ->> '<key>'` expression the index was built on, so
 * Postgres answers the four-way OR with a BitmapOr of the four trigram
 * indexes (then `store_id` filters the few hits) instead of walking every
 * order. Do not rewrite these to `#>>`, `jsonb_extract_path_text` or
 * `LOWER(...) LIKE` — a different expression cannot use the index.
 *
 * Registered customers' orders are excluded on purpose (`customer_id IS NULL`):
 * they keep matching through the customer's own account fields, exactly as
 * before, so a registered customer's results do not change. The search term is
 * PII (a phone or an email): it is only ever a bound parameter, never logged.
 */
export async function guestOrderIdsMatching(storeId: string, search: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(guestOrderIdsSql(storeId, search));
  return rows.map(r => r.id);
}

/** The statement behind `guestOrderIdsMatching`; exported so the plan test EXPLAINs the real SQL. */
export function guestOrderIdsSql(storeId: string, search: string): Prisma.Sql {
  const like = likeContains(search);
  return Prisma.sql`
    SELECT id FROM public.orders
    WHERE store_id = ${storeId}
      AND customer_id IS NULL
      AND deleted_at IS NULL
      AND (
            shipping_address ->> 'firstName' ILIKE ${like}
         OR shipping_address ->> 'lastName'  ILIKE ${like}
         OR shipping_address ->> 'email'     ILIKE ${like}
         OR shipping_address ->> 'phone'     ILIKE ${like}
      )
    LIMIT ${ORDER_SEARCH_CUSTOMER_ID_CAP + 1}
  `;
}

export class OrderService {
  /**
   * WHERE clause for the order list and its export. Async because a search
   * first resolves the matching customers (see `orderSearchWhere`).
   */
  static async listWhere(
    storeId: string,
    filters: OrderListWhere
  ): Promise<Prisma.OrderWhereInput> {
    const { status, paymentStatus, customerId, from, to, confirmedOnly } = filters;
    // Defensive deletedAt filter. The schema marks Order as soft-deletable
    // but no code path currently sets `deletedAt`, so this is a no-op
    // today — kept here so a future "archive order" feature doesn't
    // accidentally surface archived rows in the admin list (which would
    // also pollute analytics aggregates that count off this query).
    const where: Prisma.OrderWhereInput = { storeId, deletedAt: null };
    if (status) where.status = status as OrderStatus;
    if (paymentStatus)
      where.paymentStatus = paymentStatus as Prisma.OrderWhereInput['paymentStatus'];

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
    const search = filters.search?.trim();
    if (search) where.OR = await orderSearchWhere(storeId, search);
    return where;
  }

  static async list(
    storeId: string,
    options: {
      page?: number;
      limit?: number;
      status?: string;
      customerId?: string;
      from?: Date;
      to?: Date;
      /** See `OrderListWhere.search`. */
      search?: string;
      paymentStatus?: string;
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
    const { cursor } = options;
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const skip = (page - 1) * limit;

    const where = await OrderService.listWhere(storeId, options);

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
      // `id` is the tiebreaker, and it is load-bearing rather than tidiness.
      // Keyset pagination is only stable when the ORDER BY uniquely identifies
      // the cursor row, and createdAt is not unique — bulk-imported or
      // same-second orders share a timestamp, so a page boundary landing inside
      // such a group could skip rows or repeat them.
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
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
              select: {
                ...STOREFRONT_PRODUCT_SELECT,
                images: { take: 1, orderBy: { position: 'asc' } },
              },
            },
          },
        },
        payments: { select: ORDER_PAYMENT_SELECT },
        // Surfaces WHICH promotion discounted the order alongside
        // couponCode/couponDiscount/promotionDiscount (all plain scalar
        // columns already returned by `include`) so admin/customer order
        // views can show the promotion's name, not just its opaque id.
        appliedPromotion: { select: { id: true, name: true, nameAr: true } },
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    // InstaPay (SP6a): what the merchant needs to match the transfer against their
    // InstaPay app: the reference the customer entered and the hold deadline. A
    // derived summary, never the raw payment metadata. Only present on an InstaPay
    // order, so every other order keeps exactly the shape it always had.
    const result: typeof order & {
      instapay?: {
        customerReference: string | null;
        customerReferenceAt: string | null;
        handle: string | null;
        expiresAt: string | null;
      };
    } = order;
    if (order.payments?.some(p => p.provider === 'instapay')) {
      const ip = await prisma.payment.findFirst({
        where: { orderId, provider: 'instapay' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      const m = (ip?.metadata ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      result.instapay = {
        customerReference: str(m.customerReference),
        customerReferenceAt: str(m.customerReferenceAt),
        handle: str(m.handle),
        expiresAt: order.paymentConfirmationExpiresAt?.toISOString() ?? null,
      };
    }

    return result;
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
              select: {
                ...STOREFRONT_PRODUCT_SELECT,
                images: { take: 1, orderBy: { position: 'asc' } },
              },
            },
          },
        },
        payments: { select: ORDER_PAYMENT_SELECT },
        appliedPromotion: { select: { id: true, name: true, nameAr: true } },
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
    referralCode?: string,
    /**
     * Server-observed client IP, never client-supplied — threaded through
     * from the route (`ipKeyGenerator(req.ip)`, same normalisation every
     * rate limiter in `middleware/security.ts` already uses). Optional:
     * non-HTTP callers (admin manual orders use `createAdminOrder`, not this
     * method; a future script) simply get no IP signal in the stock-hold cap
     * below.
     */
    requestContext?: { checkoutIp?: string | null }
  ) {
    await assertOrderAllowed(storeId);
    // One stored phone form (ruling MONEYB-7): E.164 for an Egyptian mobile,
    // ASCII digits otherwise — whatever keyboard the shopper typed on.
    //
    // paymentMethod is canonicalized here too (trim + lowercase). The HTTP
    // schemas accept it as a bare `z.string()` (not an enum — unlike
    // /payments/create's `provider`, which IS a strict lowercase enum), so
    // without this every `=== 'cod'` / `=== 'instapay'` exact-match below —
    // the stock-hold cap, the COD-fee calc, and the COD notification trigger
    // — silently no-ops for a client that sends `'COD'`/`'Cod'`/`'InstaPay'`.
    // For the stock-hold cap specifically that is a straight bypass: the cap
    // check would skip (treating the order as an uncapped method), stock
    // still gets reserved, and a follow-up `POST /payments/create` with the
    // PROPERLY-cased, strictly-enum-validated `provider: 'cod'` then attaches
    // a real COD payment row — which IS what excludes the order from the
    // 2-day auto-cancel sweep (keyed on `Payment.provider`, not this field)
    // — leaving an uncapped, unbounded hold from one casing trick on the
    // very first request.
    data = {
      ...data,
      paymentMethod: data.paymentMethod.trim().toLowerCase(),
      shippingAddress: {
        ...data.shippingAddress,
        phone: normalizePhoneForStorage(data.shippingAddress.phone),
      },
      ...(data.billingAddress
        ? {
            billingAddress: {
              ...data.billingAddress,
              phone: normalizePhoneForStorage(data.billingAddress.phone),
            },
          }
        : {}),
    };

    // Stock-hold abuse fix: for COD/InstaPay (no synchronous payment capture)
    // reject a NEW order once the caller already has too many open unpaid
    // holds on this store by phone, email OR IP. Runs before any cart/stock
    // read so an abusive run never reaches inventory. See stock-hold-cap.ts
    // for why only these two methods are capped and why no identity → no-op.
    await assertStockHoldCapNotExceeded(prisma, storeId, data.paymentMethod, {
      phone: data.shippingAddress.phone,
      email: typeof data.shippingAddress.email === 'string' ? data.shippingAddress.email : null,
      ip: requestContext?.checkoutIp ?? null,
    });

    // Get cart
    const cart = await CartService.getOrCreate(storeId, sessionId, customerId);
    // Raw CartBundle rows ({ id, bundleId, quantity } — one per BOX type in
    // the cart). A cart holding ONLY bundles (no loose items) is valid, so
    // the empty-cart guard below must check both, not just `cart.items`.
    const cartBundles = cart.bundles ?? [];

    if (cart.items.length === 0 && cartBundles.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Cart is empty');
    }

    // CartService's product select is storefront-safe (T-H2) and omits
    // trackInventory/costPrice on purpose — fetch them separately here since
    // order creation needs both internally: trackInventory gates the
    // inventory-decrement guard below, costPrice is snapshotted onto each
    // OrderItem for profit reporting. Neither is ever serialized in the
    // order response.
    //
    // Scoped to the store AND to live rows. Two separate defects otherwise:
    //
    //   `storeId` — an unscoped findMany on the order-creation path makes a
    //   cross-tenant read load-bearing for checkout availability. UUID ids make
    //   a collision impractical rather than impossible, but every other tenant
    //   read in this service is scoped and this one was not.
    //
    //   `deletedAt` — the miss-detection below exists to catch a product that
    //   vanished between cart load and order creation, and it only caught a
    //   HARD delete. Soft delete is the path merchants actually use (the admin
    //   "delete product" button sets `deletedAt`), so a soft-deleted product
    //   still resolved here, passed the guard, and was ordered — with an
    //   inventory decrement against a row the storefront no longer sells.
    // The variants the cart actually holds, for their COST: a variant product's
    // cost is entered per variant (SimpleVariantsForm), so snapshotting only
    // the parent's `costPrice` left every variant line without a cost — no
    // COGS journal, profit reported as 0.
    const cartVariantIds = cart.items
      .map(i => (i as { variantId?: string | null }).variantId)
      .filter((v): v is string => !!v);
    const productInternals = await prisma.product.findMany({
      where: {
        id: { in: cart.items.map(i => i.productId) },
        storeId,
        deletedAt: null,
      },
      select: {
        id: true,
        trackInventory: true,
        costPrice: true,
        categories: { select: { categoryId: true } },
        variants: {
          where: { id: { in: cartVariantIds } },
          select: { id: true, costPrice: true },
        },
      },
    });
    const productInternalsById = new Map(productInternals.map(p => [p.id, p]));

    // Every cart line MUST resolve to a live product. A hard delete between
    // cart load and here leaves a map miss, and the two `trackInventory` reads
    // below defaulted that miss to `true` — so the order attempted an
    // inventory decrement and an inventory-history row for a row that no
    // longer exists. It could never have succeeded: OrderItem.product is a
    // required relation, so the transaction dies on the foreign key anyway —
    // but only AFTER the decrement was attempted, and with an opaque Prisma
    // error rather than something a merchant or a log reader can act on.
    //
    // Fail here instead, before any money or stock moves, and say which line.
    // Guessing a default for an absent product is the resolver-defaults
    // anti-pattern: the honest answer to "does this deleted product track
    // inventory" is that there is no product.
    const missingProductIds = cart.items
      .map(i => i.productId)
      .filter(id => !productInternalsById.has(id));
    if (missingProductIds.length > 0) {
      // Ids travel in `details`, NOT interpolated into the message. The message
      // is user-facing copy and must come from LanguageContext on the client;
      // a raw UUID list is neither translatable nor useful to a shopper. The
      // ids ARE useful to the cart page, which uses them to mark the offending
      // lines — so they are structured data, not prose.
      throw new AppError(
        409,
        'PRODUCT_NO_LONGER_AVAILABLE',
        'A product in your cart is no longer available. Remove it and try again.',
        { productIds: missingProductIds }
      );
    }

    // --- Bundles (Task 6): resolve, refuse if no longer purchasable, and
    // pre-compute the per-box price allocation. Everything here is a READ —
    // no stock is touched yet. The oversell guard is the atomic per-line
    // decrement inside the transaction below (Ruling T5-c); this block only
    // establishes what a box costs and how that cost splits across its
    // components.
    //
    // Price is recomputed from `resolveBundle` (current component prices,
    // current pricingType/pricingValue) — never trusted from the cart, which
    // may have been priced minutes or hours ago.
    const resolvedBundles = await Promise.all(
      cartBundles.map(async cb => ({
        cartBundle: cb,
        resolved: await resolveBundle(prisma, storeId, cb.bundleId),
      }))
    );

    // A bundle that was purchasable when added to the cart is not trusted to
    // still be: a component could have sold out, the bundle could have been
    // deactivated, or its date window could have closed since. `isPurchasable`
    // is recomputed fresh by `resolveBundle` above — refuse rather than sell
    // a box the merchant can no longer fulfil.
    for (const { resolved } of resolvedBundles) {
      if (!resolved.isPurchasable) {
        throw new AppError(
          409,
          'BUNDLE_NOT_PURCHASABLE',
          `"${resolved.name}" is no longer available. Remove it from your cart and try again.`
        );
      }
    }

    // Raw BundleItem rows for every bundle in the cart — `resolveBundle`'s
    // `lines` only carries `{ key, unitPrice, quantity }` (enough to price
    // and allocate), not the productId/variantId/name/sku/costPrice an
    // OrderItem needs. `key` on a resolved line IS the BundleItem id, so this
    // map is joined back onto the allocation by that id below. A component
    // product can never be hard-deleted out from under a bundle (BundleItem's
    // FK to Product is `onDelete: Restrict`), so — unlike loose cart items —
    // there is no "missing product" case to guard here.
    const bundleIds = cartBundles.map(cb => cb.bundleId);
    const bundleItemRows =
      bundleIds.length > 0
        ? await prisma.bundleItem.findMany({
            where: { bundleId: { in: bundleIds } },
            select: {
              id: true,
              productId: true,
              variantId: true,
              quantity: true,
              product: { select: { name: true, sku: true, costPrice: true, trackInventory: true } },
              // The component variant's own cost — see lineUnitCost.
              variant: { select: { costPrice: true } },
            },
          })
        : [];
    const bundleItemById = new Map(bundleItemRows.map(bi => [bi.id, bi]));

    /** One component line, allocated for exactly ONE box — reused across every box of that bundle in the cart (allocation is a pure function of `lines`+`price`, so it is identical for every box). */
    interface BundleExpansion {
      cartBundle: (typeof cartBundles)[number];
      resolved: (typeof resolvedBundles)[number]['resolved'];
      allocated: ReturnType<typeof allocateBundlePrice>;
    }

    const bundleExpansions: BundleExpansion[] = resolvedBundles.map(({ cartBundle, resolved }) => {
      const allocated = allocateBundlePrice(resolved.lines, resolved.price);

      // Defence in depth for money invariant 1. Admin validates
      // allocatability at SAVE time (bundle.routes.ts), but that check runs
      // against the componentSum AT THAT TIME — a component's price can
      // drift afterward and `resolveBundle` always recomputes componentSum
      // from CURRENT prices, so a bundle that was allocatable when saved is
      // not guaranteed to still be allocatable at checkout. Refusing here
      // (order never created, nothing written) is the only acceptable
      // outcome if that drift ever produces a residual — silently writing a
      // group whose lines don't sum to the price the customer was quoted
      // would violate the invariant this whole task exists to guarantee.
      const allocatedSum = allocated.reduce((sum, line) => sum + line.totalAllocated, 0);
      if (allocatedSum !== resolved.price) {
        throw new AppError(
          409,
          'BUNDLE_PRICE_NOT_ALLOCATABLE',
          `"${resolved.name}" can no longer be priced exactly at checkout. Please try again.`
        );
      }

      return { cartBundle, resolved, allocated };
    });

    // Calculate totals (done before the transaction — no locks needed here).
    // Price each line at its chosen VARIANT's price when one is selected,
    // falling back to the parent product price for variant-less products —
    // matches CartService and prevents charging every variant the parent
    // (lowest) price.
    const bundlesSubtotal = bundleExpansions.reduce(
      (sum, b) => sum + b.resolved.price * b.cartBundle.quantity,
      0
    );
    // Order.bundleDiscount = Σ((componentSum − bundlePrice) × bundleQuantity)
    // across every bundle in the cart — the merchant-facing "how much did
    // bundling save the customer" figure, independent of the per-line
    // allocation used for accounting.
    const bundleDiscount = bundleExpansions.reduce(
      (sum, b) => sum + (b.resolved.componentSum - b.resolved.price) * b.cartBundle.quantity,
      0
    );
    // The LOOSE-items-only subtotal — every cart line that is not part of a
    // bundle. It is the basis a coupon is evaluated against, because a
    // coupon never discounts a bundle (Ruling B1: no stacking on an
    // already-discounted box; `cartItems` below, which drives
    // `matchesTargeting`/`matchingSubtotal`, is likewise built from
    // `cart.items` only). Identical to `subtotal` for every cart with no
    // bundle, so a store without the `bundles` feature is unaffected.
    const looseSubtotal = cart.items.reduce(
      (sum, item) => sum + cartLineUnitPrice(item) * item.quantity,
      0
    );
    const subtotal = looseSubtotal + bundlesSubtotal;

    // Build the targeting cart snapshot (product + category ids, per-line
    // totals) shared by coupon targeting and automatic promotion resolution.
    // Prices each line the same way as `subtotal` so scoped discounts compute
    // against the exact piastres the customer is charged.
    const cartItems = cart.items.map(item => ({
      productId: item.productId,
      categoryIds: (productInternalsById.get(item.productId)?.categories ?? []).map(
        c => c.categoryId
      ),
      quantity: item.quantity,
      lineTotal: cartLineUnitPrice(item) * item.quantity,
    }));

    // Per-store, opt-in minimum order value (Store.settings.minimumOrderFils,
    // piastres; 0/unset = no minimum). Platform-level — any store can configure
    // it, never a hardcoded slug. This is the REAL guard for the customer
    // checkout path; the storefront cart/checkout mirror it for UX only.
    // Deliberately NOT applied to OrderService.createAdminOrder — merchants
    // must be able to override the minimum for phone/manual orders.
    const storeForMinOrder = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { settings: true },
      })
    );
    const minimumOrderFilsRaw = (storeForMinOrder?.settings as Record<string, unknown> | null)?.[
      'minimumOrderFils'
    ];
    const minimumOrderFils =
      typeof minimumOrderFilsRaw === 'number' ? minimumOrderFilsRaw : undefined;
    const minimumOrderCheck = checkMinimumOrder(subtotal, minimumOrderFils);
    if (!minimumOrderCheck.met) {
      throw new AppError(
        400,
        'MINIMUM_ORDER_NOT_MET',
        `Minimum order value of ${minorToDecimalString(minimumOrderFils as number)} EGP required`
      );
    }

    // Resolve the store's configured tax rate. The tax itself is computed
    // below, once the discount is known — VAT is levied after discount (#193).
    const activeTax = await resolveActiveTaxRate(storeId);

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
    // Resolve the customer targeting context (group + first-order) from the
    // checkout identity. The guest identity vars used elsewhere for the
    // per-user usage check are derived later (~line 600); resolve the same
    // identity directly here so coupon targeting and promotion resolution see
    // the customer's real group/first-order status.
    const idPhone =
      typeof data.shippingAddress.phone === 'string' ? data.shippingAddress.phone : null;
    const idEmail =
      typeof data.shippingAddress.email === 'string' ? data.shippingAddress.email : null;
    const custCtx = await resolveCustomerContext(storeId, {
      phone: idPhone,
      email: idEmail,
      customerId: customerId ?? null,
    });
    const targetingCtx = { ...custCtx, cartItems };

    let appliedCoupon: Awaited<ReturnType<typeof CouponService.getByCode>> | null = null;
    let couponDiscount = 0;
    if (data.couponCode) {
      appliedCoupon = await CouponService.getByCode(storeId, data.couponCode);
      // Gate on the LOOSE subtotal, not the bundle-inclusive one. A coupon
      // discounts only loose lines (Ruling B1), so measuring its minimum
      // against a total that INCLUDES bundles let a bundle-only cart pass
      // the minimum and then receive a zero discount from the very coupon it
      // had just "qualified" for. `looseSubtotal === subtotal` whenever the
      // cart holds no bundle, so this is the identity for every store
      // without the `bundles` feature.
      if (appliedCoupon.minOrderAmount && looseSubtotal < appliedCoupon.minOrderAmount) {
        throw new AppError(
          400,
          'MIN_ORDER_NOT_MET',
          `Minimum order amount of ${minorToDecimalString(appliedCoupon.minOrderAmount)} ${REGION.currency} required for this coupon`
        );
      }
      // Targeting is evaluated for EVERY coupon type, including free_shipping —
      // on THIS (storefront checkout) path. `createAdminOrder` below does NOT
      // evaluate targeting yet: whether a merchant-created order may bypass a
      // coupon's customer-group / first-order / quantity / scope rules is an
      // open owner decision (issue 1370).
      // It used to be skipped for free_shipping, which zeroed the shipping line
      // unconditionally: a code restricted to a customer group, to first orders,
      // to a minimum quantity, or to specific products or categories applied to
      // anyone who typed it. `evaluateForCart` already accepts the type — the
      // branch simply never asked it.
      const evalResult = CouponService.evaluateForCart(appliedCoupon, targetingCtx);
      if (!evalResult.eligible) {
        throw new AppError(400, 'COUPON_NOT_ELIGIBLE', 'This coupon does not apply to your cart.');
      }
      if (appliedCoupon.type === 'free_shipping') {
        // The benefit is the zeroed shipping line, not a cart discount, so the
        // computed discount is deliberately not applied on top. Stacks
        // naturally with the store's own free-shipping threshold — whichever
        // zeros first wins, and both mean the customer pays no delivery fee.
        shipping = 0;
      } else {
        couponDiscount = evalResult.discount;
      }
    }

    // Automatic promotions apply without a code. Resolve the single best one
    // (largest eligible discount, priority-broken ties) and pit it against the
    // coupon: the larger single discount wins ("best-of", they don't stack).
    // free_shipping is not an accepted promotion type (rejected at the admin
    // schema boundary) — only value-bearing percentage/fixed promotions are
    // ever resolved here. free_shipping COUPONS are unrelated and still work.
    const bestPromo = await resolveBestPromotion(storeId, targetingCtx);
    const promotionDiscount = bestPromo ? bestPromo.discount : 0;

    const primaryDiscount = Math.max(couponDiscount, promotionDiscount);
    // Record the promotion whenever it matches-or-beats the coupon (and is
    // non-zero). The discount amount itself is only ever counted once via
    // `primaryDiscount`, so this is a record of which lever applied.
    const appliedPromotionId =
      bestPromo && promotionDiscount >= couponDiscount && promotionDiscount > 0
        ? bestPromo.promotionId
        : null;
    // The coupon was actually applied (→ consume its usage) when it is a
    // free-shipping coupon (always acts on the shipping line) OR its discount
    // matched-or-beat any competing promotion. If a promotion strictly
    // out-discounted the coupon, the coupon was NOT applied and must neither
    // block on its per-user limit nor consume a redemption.
    // Exact-tie guard: when couponDiscount === promotionDiscount (both > 0),
    // appliedPromotionId is already set above (promotion wins ties), so the
    // promotion is the recorded lever. Without the `!appliedPromotionId`
    // check here, couponDiscount === primaryDiscount would ALSO be true on
    // that tie, and both couponDiscount and promotionDiscount would persist
    // as D — double-counting a single D-sized discount in the breakdown
    // (though `discount` itself, via primaryDiscount, stays correct at D).
    // free_shipping coupons are unaffected — they act on the shipping line
    // and always apply alongside any promotion.
    const couponApplied =
      !!appliedCoupon &&
      (appliedCoupon.type === 'free_shipping' ||
        (couponDiscount === primaryDiscount && couponDiscount > 0 && !appliedPromotionId));

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
        // Cap against the goods value still payable after the primary discount
        // (the winning coupon-or-promotion). Loyalty stacks on the remainder.
        const redeemableSubtotal = Math.max(0, subtotal - primaryDiscount);
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

    const discount = primaryDiscount + loyaltyDiscount;
    // COD fee (ruling MONEYB-3): quoted at checkout from the same config and
    // the same function, frozen here, inside `total` and the VAT base — never
    // added after the shopper pressed "Place order".
    const codFee =
      data.paymentMethod === 'cod'
        ? codFeeForOrder({ subtotal, discount, shipping }, await loadCodFeeConfig(storeId))
        : 0;
    // subtotal → discounts → shipping → COD fee → VAT → total (ruling MONEYB-2):
    // shipping and the COD fee the seller charges are in the VAT base; tax
    // already inside listed prices is extracted, never added again (M3-6).
    const { tax, total, taxableAmount } = computeOrderAmounts({
      subtotal,
      discount,
      shipping,
      codFee,
      ratePercent: activeTax.ratePercent,
      includedInPrice: activeTax.includedInPrice,
    });

    // Customer wallet (D1). Resolved on the SERVER from the real balance; the
    // debit itself happens inside the order transaction below and re-checks the
    // balance under the wallet row lock, so a concurrent spend that drained it
    // throws INSUFFICIENT_WALLET_BALANCE there and rolls this whole order back.
    // `total` keeps meaning "order value"; the gateway / COD courier collects
    // `total - walletAmount`. With useWallet absent (every existing client) or
    // either feature off, walletAmount stays 0 and nothing below changes.
    let walletAmount = 0;
    if (customerId && data.useWallet === true && total > 0) {
      const availability = await WalletService.getCheckoutAvailability(storeId);
      if (availability.available) {
        const balance = await WalletService.getBalance(storeId, customerId);
        walletAmount = Math.min(balance, total);
      }
    }
    // Wallet covers the whole order: nothing is left for a gateway, so the
    // order is paid the moment it is created (see the notification block
    // after the transaction, and the /payments/create guard).
    const paidInFullByWallet = walletAmount > 0 && walletAmount === total;

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
    const order = await withMoneyTx(prisma, async (moneyTx: Prisma.TransactionClient) =>
      // `scopeTransaction` sets the store on this transaction's own connection AND makes it
      // the ambient tenant transaction, so the code-level tenant guard (R-EBDA-003) and the
      // `prisma` proxy both see the store.
      scopeTransaction(moneyTx, { storeId }, async (tx: Prisma.TransactionClient) => {
        // The public checkout (`POST /public/orders`) and the MCP `place_order`
        // tool reach this with NO tenant context, and `backorder_lines` (written
        // below for backordered lines) has a STRICT RLS policy: under `ebda_app`
        // that insert is rejected and the whole order rolls back. Set the store
        // on this transaction's own connection. Inert on the owner role; a
        // no-op repeat when the caller's context already carried it.
        // backorderedItems collects items where the pre-decrement inventory was
        // insufficient and the inventory.backorder feature is enabled — these get
        // a BackorderLine row created after the order is persisted (further down
        // in this transaction). When the feature is disabled, out-of-stock items
        // are rejected regardless of the per-product allowBackorder flag.
        const backorderedItems: Array<{
          productId: string;
          variantId?: string;
          quantity: number;
          stockTaken: number;
        }> = [];

        // Expand every cart bundle into its component OrderItem specs, ONE
        // bundleGroupId per BOX (never per bundle-in-cart) so a single box can
        // later be returned independently of any others of the same bundle in
        // the same order. `allocated` was computed once per bundle above (pure
        // function of `lines`+`price`), so it is simply re-read for every box —
        // every box of the same bundle gets the identical per-line price/total.
        interface BundleComponentLine {
          productId: string;
          variantId: string | null;
          productName: string;
          sku: string | null;
          costPrice: number | null;
          trackInventory: boolean;
          quantity: number;
          price: number;
          total: number;
          bundleId: string;
          bundleGroupId: string;
          bundleName: string;
          bundleNameAr: string | null;
        }
        const bundleComponentLines: BundleComponentLine[] = [];
        for (const { cartBundle, resolved, allocated } of bundleExpansions) {
          for (let box = 0; box < cartBundle.quantity; box++) {
            const bundleGroupId = randomUUID();
            for (const line of allocated) {
              // `line.key` is the BundleItem id (see resolveBundle) — joined
              // back onto the raw component data fetched above.
              //
              // P2-3 (final review): the raw rows are read AFTER `resolveBundle`
              // and BEFORE this transaction, and `PUT /stores/:id/bundles/:id`
              // with `items` does a deleteMany + recreate that MINTS NEW
              // BundleItem ids. A merchant saving an edit in that window made
              // this lookup miss, and the non-null assertion turned it into a
              // TypeError — an unhandled 500 on checkout, in code that is
              // otherwise careful to answer 409. Refuse the same way every
              // other "the bundle moved under us" case does; no order is
              // created either way.
              const bi = bundleItemById.get(line.key);
              if (!bi) {
                throw new AppError(
                  409,
                  'BUNDLE_NOT_PURCHASABLE',
                  `"${resolved.name}" was just changed. Reload your cart and try again.`
                );
              }
              bundleComponentLines.push({
                productId: bi.productId,
                variantId: bi.variantId,
                productName: bi.product.name,
                sku: bi.product.sku,
                costPrice: bi.variant?.costPrice ?? bi.product.costPrice ?? null,
                trackInventory: bi.product.trackInventory,
                quantity: bi.quantity,
                price: line.unitAllocated,
                total: line.totalAllocated,
                bundleId: resolved.id,
                bundleGroupId,
                bundleName: resolved.name,
                bundleNameAr: resolved.nameAr,
              });
            }
          }
        }

        // Shared atomic check + decrement, used by BOTH loose cart items and
        // every bundle component line below — one code path, not two. A
        // conditional `UPDATE … WHERE inventory >= qty` does the oversell guard
        // AND the decrement in ONE statement, so there is no SELECT … FOR
        // UPDATE held across the rest of this multi-step order transaction
        // (which under a single-SKU flash-sale storm serialized every checkout
        // on the row lock). A losing concurrent writer sees 0 rows affected →
        // INSUFFICIENT_INVENTORY (or backorder), never an oversell.
        //
        // RULING T5-c: this is also how COMBINED demand across loose items and
        // every bundle's expansion is enforced. There is no separate
        // "sum demand then check" pass — every call below runs sequentially,
        // in this one transaction, against Postgres's actual current row
        // value. Two bundles sharing a component (or a bundle plus a loose
        // item of the same product) each call this once, in order; the second
        // call always sees the stock the first call already consumed, so
        // jointly-oversold demand fails on whichever call runs second — and
        // because it throws, the WHOLE transaction (including the first
        // call's decrement) rolls back. Checking each bundle's availability
        // against a shared pre-transaction snapshot (what the cart itself
        // does, independently, for cart-side warnings) is exactly what this
        // must NOT do for the actual oversell guard.
        const decrementTrackedStock = async (target: {
          productId: string;
          variantId?: string | null;
          quantity: number;
          label: string;
        }): Promise<{ previousStock: number; newStock: number }> => {
          const { productId, quantity: qty, label } = target;
          const variantId = target.variantId ?? undefined;

          let res = variantId
            ? await decrementVariantInventory(tx, variantId, qty)
            : await decrementProductInventory(tx, productId, qty);

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
                    where: { id: productId, storeId },
                    select: { allowBackorder: true },
                  })
                )?.allowBackorder;
            if (!backorderFeatureEnabled || !perFlag) {
              throw new AppError(
                400,
                'INSUFFICIENT_INVENTORY',
                `Not enough inventory for ${label}`
              );
            }
            // Backorder accepted — force the decrement + track for
            // BackorderLine creation below. Variant lines floor at 0 so the
            // admin grid never shows a negative. A NON-variant product's
            // negative inventory is a real, meaningful backorder debt, so its
            // decrement stays unfloored (inlined here rather than kept as an
            // exported helper — see inventory-decrement.ts's module comment for
            // why an exported one was a hazard).
            if (variantId) {
              res = await forceDecrementVariantInventory(tx, variantId, qty);
            } else {
              const [row] = await tx.$queryRaw<Array<{ inventory: number }>>`
              UPDATE public.products SET inventory = inventory - ${qty}
              WHERE id = ${productId}
              RETURNING inventory
            `;
              const newStock = row?.inventory ?? 0;
              res = { ok: true, previousStock: newStock + qty, newStock };
            }
            // What checkout actually took from stock (#2299): all of it for a
            // non-variant row (the rest is negative debt), only what was on hand
            // for a variant row (floored at 0). The whole-order restore gives
            // back no more than this.
            backorderedItems.push({
              productId,
              variantId,
              quantity: qty,
              stockTaken: Math.max(0, res.previousStock - res.newStock),
            });
          }
          return { previousStock: res.previousStock, newStock: res.newStock };
        };

        // Atomic check + decrement per tracked item. A variant item decrements
        // ONLY the variant row and a variant-less item ONLY the product row —
        // never both (see lib/effective-inventory.ts for why the parent column
        // is not stock for a variant product). The InventoryHistory row is
        // keyed on productId, so for a variant line its pre/post stock
        // describe the variant's movement; that is the movement that actually
        // occurred.
        const stockChanges = new Map<string, { previousStock: number; newStock: number }>();
        for (const item of cart.items) {
          // No `?? true` fallback: presence is guaranteed by the guard above.
          if (!productInternalsById.get(item.productId)!.trackInventory) continue;
          const qty = item.quantity;
          const variantId = (item as { variantId?: string }).variantId;
          const lineKey = `${item.productId}::${variantId ?? ''}`;

          const stockChange = await decrementTrackedStock({
            productId: item.productId,
            variantId,
            quantity: qty,
            label: `${item.product.name}${variantId ? ' (variant)' : ''}`,
          });

          // ONE row per line. A variant sale moves the variant's stock and
          // nothing else — `products.inventory` is not a running total for a
          // variant product, it is unused (held at 0). Mirroring the sale onto
          // the parent is what drove that column negative across the catalogue
          // (24 products, to -16) and made six read paths report a permanent,
          // un-clearable "out of stock". The InventoryHistory row below is keyed
          // on productId (the table has no variantId column), so for a variant
          // line its previous/new stock describe the VARIANT's movement — which
          // is the movement that actually happened.
          stockChanges.set(lineKey, stockChange);
        }

        // Same decrement path, for every bundle component line built above.
        // Runs AFTER the loose-item loop, in the SAME transaction — see the
        // Ruling T5-c note on `decrementTrackedStock` above for why this
        // ordering is what makes combined demand (a shared component across
        // bundles, or a bundle plus a loose item of the same product) refuse
        // correctly rather than overselling. Keyed by array index (not
        // productId/variantId) because, unlike loose cart items, the SAME
        // product/variant can legitimately appear on multiple lines here (two
        // boxes of the same bundle, or two different bundles sharing a
        // component) — each needs its OWN InventoryHistory row.
        const bundleStockChanges: Array<{ previousStock: number; newStock: number } | null> = [];
        for (const line of bundleComponentLines) {
          if (!line.trackInventory) {
            bundleStockChanges.push(null);
            continue;
          }
          const stockChange = await decrementTrackedStock({
            productId: line.productId,
            variantId: line.variantId,
            quantity: line.quantity,
            label: `${line.productName} (component of "${line.bundleName}")`,
          });
          bundleStockChanges.push(stockChange);
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
        if (
          appliedCoupon &&
          couponApplied &&
          appliedCoupon.usageLimitPerUser &&
          appliedCoupon.usageLimitPerUser > 0
        ) {
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
        if (appliedCoupon && couponApplied) {
          const reserve = await tx.coupon.updateMany({
            where: {
              id: appliedCoupon.id,
              storeId,
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
            // A fully wallet-paid order has no gateway step to wait for — it is
            // created paid, the same end state a completed gateway webhook
            // leaves (payment-confirm.service: confirmed + paid).
            status: paidInFullByWallet ? 'confirmed' : 'pending',
            ...(paidInFullByWallet ? { paymentStatus: 'paid' as const } : {}),
            walletAmount,
            subtotal,
            tax,
            // Which convention `tax` was charged under, frozen onto the order.
            // Every consumer of `order.tax` (GL posting, refund allocation) must
            // know whether it is inside `subtotal`/`total` or on top of them, and
            // the store-level switch it came from can be flipped afterwards.
            taxIncludedInPrice: activeTax.includedInPrice,
            // Seller TRN / legal name / rate frozen for the tax invoice — only
            // when VAT was collected under a VERIFIED profile (ruling TAX-2).
            ...frozenTaxInvoiceFields(activeTax),
            shipping,
            codFee,
            taxableAmount,
            discount,
            // Persist the coupon fields ONLY when the coupon actually applied.
            // If a promotion out-discounted the coupon it was not consumed (no
            // usageCount increment above); leaving its code/discount on the order
            // would make the per-user usage count over-count and the
            // payment-failure rollback decrement a redemption that was never
            // reserved. free_shipping coupons keep their code with a 0 discount,
            // exactly as before.
            couponCode: couponApplied ? (appliedCoupon?.code ?? null) : null,
            couponDiscount: couponApplied ? couponDiscount : 0,
            // Store the promotion discount that actually applied (mirrors the
            // coupon gating). When the coupon out-discounted the promotion,
            // `appliedPromotionId` is null and no promotion discount is recorded,
            // so the persisted couponDiscount + promotionDiscount + loyaltyDiscount
            // reconciles to `discount` in every non-tie case.
            promotionDiscount: appliedPromotionId ? promotionDiscount : 0,
            appliedPromotionId,
            // Reporting-only, like couponDiscount/promotionDiscount above — the
            // saving is already reflected in a LOWER `subtotal` (bundles are
            // priced at `bundlePrice`, not `componentSum`), so this is never
            // added again into `discount`/`total`.
            bundleDiscount,
            loyaltyPointsRedeemed: loyaltyPointsRedeemed > 0 ? loyaltyPointsRedeemed : null,
            loyaltyDiscount,
            total,
            locale: data.locale ?? null,
            smsOptIn: data.smsOptIn ?? false,
            source: data.source ?? 'web',
            // Stock-hold cap signal (lib/stock-hold-cap.ts) — never read for
            // anything else. NULL when the caller passed none.
            checkoutIp: requestContext?.checkoutIp ?? null,
            shippingAddress: data.shippingAddress,
            billingAddress: data.billingAddress || data.shippingAddress,
            notes: data.notes,
            items: {
              create: [
                ...cart.items.map(item => ({
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
                  // Charge the chosen variant's price (fall back to the parent
                  // product for variant-less products). Persisting product.price
                  // here undercharged every variant at the parent (lowest) price.
                  price: cartLineUnitPrice(item),
                  // Snapshot cost-of-goods at sale time so profit reports
                  // stay correct even if the product's cost changes later.
                  // A variant line takes the variant's own cost, falling back
                  // to the parent product's (same rule as account.service's
                  // inventory valuation and lib/order-line-cost.ts).
                  costPrice: lineUnitCost(
                    productInternalsById.get(item.productId),
                    (item as { variantId?: string | null }).variantId
                  ),
                  total: cartLineUnitPrice(item) * item.quantity,
                })),
                // Every bundle box's components, appended to the SAME array the
                // loose cart items build above — ordinary product lines from
                // here on, with no bundle-aware code anywhere downstream
                // (stock, scan-to-pick, returns, backorders, per-line COGS all
                // already work off OrderItem).
                ...bundleComponentLines.map(line => ({
                  productId: line.productId,
                  variantId: line.variantId,
                  productName: line.productName,
                  sku: line.sku,
                  quantity: line.quantity,
                  price: line.price,
                  costPrice: line.costPrice,
                  total: line.total,
                  bundleId: line.bundleId,
                  bundleGroupId: line.bundleGroupId,
                  bundleName: line.bundleName,
                  bundleNameAr: line.bundleNameAr,
                })),
              ],
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
          // No `?? true` fallback: presence is guaranteed by the guard above.
          if (!productInternalsById.get(item.productId)!.trackInventory) return [];
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
        // Same ledger, for every bundle component line — keyed by array index
        // via `bundleStockChanges` (see its declaration above for why that
        // index, not productId/variantId, is the right key here). One row per
        // component line, same as a loose item: "decrements component stock,
        // not any bundle counter" — there is no bundle-level stock anywhere to
        // record instead.
        const bundleInventoryHistoryRows = bundleComponentLines.flatMap((line, i) => {
          const sc = bundleStockChanges[i];
          if (!sc) return [];
          return [
            {
              productId: line.productId,
              storeId,
              type: 'sale' as const,
              quantity: -line.quantity,
              previousStock: sc.previousStock,
              newStock: sc.newStock,
              reason: 'Sold via order (bundle component)',
              reference: newOrder.id,
            },
          ];
        });
        const allInventoryHistoryRows = [...inventoryHistoryRows, ...bundleInventoryHistoryRows];
        if (allInventoryHistoryRows.length > 0) {
          await tx.inventoryHistory.createMany({ data: allInventoryHistoryRows });
        }

        // Create BackorderLine rows and mark OrderItems as cost-deferred for any
        // items that were allowed through with insufficient inventory.
        // One BackorderLine per backordered decrement — a CONSUMING pairing, so
        // N bundle boxes sharing a product cannot each claim the same shortfall
        // (see lib/backorder-pairing.ts, #1552).
        if (backorderedItems.length > 0) {
          for (const { line: newItem, quantity, stockTaken } of pairBackorderedLines(
            newOrder.items,
            backorderedItems
          )) {
            await tx.backorderLine.create({
              data: {
                storeId,
                orderItemId: newItem.id,
                productId: newItem.productId,
                variantId: newItem.variantId,
                qty: quantity,
                stockTaken: stockTaken ?? null,
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

        // Spend from the customer wallet INSIDE the order transaction, for the
        // same reason as the loyalty redemption above: the balance is never
        // spent without an order and the order never exists without the spend.
        if (walletAmount > 0 && customerId) {
          await WalletService.debitForOrder(
            { storeId, customerId, orderId: newOrder.id, amount: walletAmount },
            tx
          );
        }

        // Clear cart. Bundles live in their own table — clearing the cart
        // must clear both, or a gateway redirect that never lands leaves a
        // PAID bundle in the cart at a live price, and the customer checks
        // out again believing the first attempt failed (double charge).
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.cartBundle.deleteMany({ where: { cartId: cart.id } });

        // The sale's fiscal document (tax invoice or receipt) with its gap-free
        // serial, in THIS transaction: the order and its number commit or roll
        // back together (ruling MONEYB-1).
        await FiscalDocumentService.issueSaleDocument(tx, storeId, newOrder.id);

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
              where: { id: abandonedCart.id, storeId },
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
      })
    );

    // Link order to affiliate referral. Must be awaited (not fire-and-forget):
    // the per-request tenant tx now COMMITS BEFORE THE RESPONSE IS SENT
    // (middleware/request-transaction.ts), so a detached promise's bare
    // prisma.* calls land on a closed transaction even sooner than they used
    // to — silently dropping commission attribution with no reconciliation
    // sweep. Awaiting keeps it inside the same request flow/tx, mirroring
    // reverseCommission's await+catch pattern below (refund path). Work that
    // genuinely has to outlive the transaction goes through
    // `deferAfterTenantCommit` (lib/after-tenant-commit.ts) instead — this one
    // must not, because the order response depends on it having happened.
    if (referralCode) {
      await affiliateService
        .linkOrderToReferral(storeId, order.id, referralCode)
        .catch(err => logger.error({ err }, 'Affiliate referral link failed'));
    }

    // SMS-marketing consent (issue 206). Only an explicit tick records
    // anything; an unticked box is not a withdrawal. Keyed by `customerKeyOf`
    // (user id, else lowercased email, else phone) so a guest's consent sits
    // on the same key the Customers page shows. Inside a savepoint and
    // non-fatal: a failed consent write must never fail the order, and the
    // gate fails closed (no row → no promotional SMS).
    const consentPhone = data.shippingAddress?.phone;
    if (data.smsOptIn === true && typeof consentPhone === 'string' && consentPhone.trim()) {
      const customerKey = customerKeyOf({
        customerId,
        shippingAddress: data.shippingAddress,
      });
      if (customerKey) {
        await withSavepoint(() =>
          SmsConsentService.recordGrant(storeId, {
            customerKey,
            userId: customerId ?? null,
            phone: consentPhone,
            source: 'checkout',
          })
        ).catch(err =>
          logger.error({ err, orderId: order.id, storeId }, '[Order] SMS consent write failed')
        );
      }
    }

    // Notifications: only fire NOW for COD orders. For online-payment orders
    // (Paymob / Kashier / Fawry) the customer hasn't actually
    // paid yet at this point — firing emails / push / dispatcher here would
    // produce "new order" pings that turn into ghosts when the customer
    // abandons at the gateway and the order rolls back. Online-payment
    // notifications fire from PaymentService.handleWebhook once payment
    // transitions to 'completed' (see payment.factory.ts).
    //
    // A fully wallet-paid order is in the same position as COD: nothing will
    // ever arrive from a gateway webhook to fire these, so fire them now.
    if (data.paymentMethod === 'cod' || paidInFullByWallet) {
      inngest
        .send({
          name: 'order/created',
          data: {
            orderId: order.id,
            storeId,
            paymentMethod: paidInFullByWallet ? 'wallet' : data.paymentMethod,
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

    // Monthly order cap (SP5): NEVER blocks checkout. Flags the store over its
    // plan and notifies the merchant once a month — see `noteOrderCreated`.
    void deferAfterTenantCommit('plan.noteOrderCreated', () => noteOrderCreated(storeId));

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

      // 1. Restore inventory — mirror EXACTLY what create() decremented: the
      //    variant row for a variant line, the product row otherwise. This
      //    used to increment the product for every line including variant
      //    ones, so a rolled-back variant order handed stock back to a column
      //    that was never debited while leaving the variant permanently short.
      for (const item of order.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId, storeId },
          select: { trackInventory: true, inventory: true },
        });
        if (!product?.trackInventory) continue;

        let previousStock: number;
        if (item.variantId) {
          const restored = await tx.productVariant.update({
            where: { id: item.variantId },
            data: { inventory: { increment: item.quantity } },
            select: { inventory: true },
          });
          previousStock = restored.inventory - item.quantity;
        } else {
          await tx.product.update({
            where: { id: item.productId, storeId },
            data: { inventory: { increment: item.quantity } },
          });
          previousStock = product.inventory;
        }

        //    The type is `return_stock` — NOT `adjustment` — because this row
        //    is the CANONICAL IDEMPOTENCY MARKER the `order/refunded` fanout
        //    reads (`order-refunded.ts` restore-inventory:
        //    `reference: orderId, type: 'return_stock'`). This rollback has
        //    already returned the stock, so any later `order/refunded` for
        //    this order MUST skip its restore. `refundReversedAt` alone is not
        //    enough: it only hides the order from `refund-reversal-stuck-sweep`,
        //    and the sweep is no longer the only way the fanout can be reached
        //    for a cancelled order — `cancelled → refunded` is a legal
        //    transition (PR #770), so a real provider refund on a
        //    rolled-back-then-paid order calls applyRefundEffects directly.
        //    With an 'adjustment' row the marker check missed and every line
        //    was incremented a SECOND time (invented stock). The `reason`
        //    below keeps this distinguishable from a customer return.
        await tx.inventoryHistory.create({
          data: {
            productId: item.productId,
            storeId,
            type: 'return_stock',
            quantity: item.quantity,
            previousStock,
            newStock: previousStock + item.quantity,
            reason: 'Order rollback — payment step failed',
            reference: order.id,
          },
        });
      }

      // 2. Roll back coupon usage if one was reserved
      if (order.couponCode) {
        // Zero floor, like the fanout's reverse-coupon step (issue 2303).
        await tx.coupon.updateMany({
          where: { storeId, code: order.couponCode, usageCount: { gt: 0 } },
          data: { usageCount: { decrement: 1 } },
        });

        // The coupon's canonical marker, written in the SAME tx as the
        // decrement — the fanout's reverse-coupon step guards on its OWN
        // `coupon_reversed` orderEvent, not on the inventory marker above
        // (an order with no tracked inventory writes no InventoryHistory row
        // at all, yet still consumed its coupon). Without this, the refund of
        // a rolled-back-then-paid order decremented usageCount twice and
        // handed a redemption back to the merchant's limit.
        await tx.orderEvent.create({
          data: {
            storeId,
            orderId: order.id,
            fromStatus: null,
            toStatus: 'coupon_reversed',
            actorId: null,
            metadata: { source: 'rollbackForPaymentFailure' },
          },
        });
      }

      // 2b. Put back any customer-wallet spend (D1). This rollback stamps
      //     `refundReversedAt` below, so the order/refunded fanout — which is
      //     where a cancel normally returns the wallet portion — will never
      //     run for this order; the reversal has to happen here, in the same
      //     transaction. Idempotent on `order-payment-reversal:<orderId>`.
      if (order.walletAmount > 0) {
        await WalletService.reverseOrderPayment({ storeId, orderId: order.id }, tx);
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

      // Clear any current rows first (defensive — usually empty post-create).
      await tx.cartItem.deleteMany({ where: { cartId } });
      await tx.cartBundle.deleteMany({ where: { cartId } });
      // Re-create the cart the customer should find waiting for them:
      // genuinely loose lines aggregated by (productId, variantId), and ONE
      // `CartBundle` per bundle at the number of boxes ordered. Aggregation
      // is required because `cart_items` carries a partial unique index per
      // (cartId, productId[, variantId]) and a bundle order can produce two
      // OrderItem rows for one product. Restoring the BOX (rather than
      // dissolving it into its components, which the pre-P1-1 code did) is
      // what keeps the retried cart priced at the bundle price instead of
      // the shelf-price component sum. See `restoreCartShape`.
      // `OrderItem.bundleId` has no FK to `Bundle` (snapshot semantics), so
      // confirm — store-scoped — which of them still exist before writing a
      // `cart_bundles` row against one. A FK violation here would abort the
      // whole compensating transaction and strand the order in `pending`
      // with its inventory unrestored; a vanished bundle falls back to loose
      // lines instead, which is the pre-P1-1 behaviour and still leaves the
      // customer holding their goods.
      const candidateBundleIds = [
        ...new Set(order.items.map(i => i.bundleId).filter((id): id is string => !!id)),
      ];
      const liveBundleIds = new Set(
        candidateBundleIds.length > 0
          ? (
              await tx.bundle.findMany({
                where: { id: { in: candidateBundleIds }, storeId },
                select: { id: true },
              })
            ).map(b => b.id)
          : []
      );
      const restored = restoreCartShape(order.items, liveBundleIds);
      for (const item of restored.items) {
        await tx.cartItem.create({ data: { cartId, ...item } });
      }
      for (const bundle of restored.bundles) {
        await tx.cartBundle.create({ data: { cartId, ...bundle } });
      }

      // 4. Mark the order cancelled with a paper trail.
      //
      // `refundReversedAt` is stamped HERE, in the same transaction as the
      // reversal, because this rollback IS the reversal: steps 1-2 above
      // already restored inventory and released the coupon. It is the
      // predicate `refund-reversal-stuck-sweep` uses to find orders that still
      // need reversing; leaving it null let the sweep re-send order/refunded.
      //
      // The stamp is the sweep's guard and the markers written in steps 1-2
      // are the FANOUT's guard — both are required, and neither substitutes
      // for the other. The stamp only stops this order being SELECTED by the
      // sweep; it does nothing about the other ways `order/refunded` is
      // reached (a provider refund on a cancelled order goes straight to
      // applyRefundEffects). The markers only stop a fanout that DOES run
      // from re-applying the reversal. When step 1 wrote 'adjustment' instead
      // of the canonical 'return_stock', the sweep-driven re-send restored
      // stock a SECOND time and decremented the coupon again — stock
      // inventable on a loop, firing organically on every legitimate failed
      // payment-create.
      // No money was ever taken (the payment step failed): the sale's fiscal
      // document keeps its number and is marked cancelled (MONEYB-1).
      await FiscalDocumentService.cancelSaleDocument(tx, storeId, order.id);

      await tx.order.update({
        where: { id: order.id, storeId },
        data: {
          status: 'cancelled',
          refundReversedAt: new Date(),
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
      | 'refunded',
    /**
     * `restoreInventory: false` — a cancel whose goods are NOT going back on
     * the shelf (a return to origin the merchant chose not to restock,
     * ruling MONEYB-5). Every other caller restores stock as before.
     */
    opts: { restoreInventory?: boolean } = {}
  ) {
    const order = await this.getById(storeId, orderId);

    // Validate status transition — shared with the payment-gateway/webhook
    // direct writers via `assertValidTransition` (see its doc comment for
    // the allowed-list rationale).
    assertValidTransition(order.status, status);
    // An InstaPay order leaves `awaiting_payment_confirmation` for `confirmed`
    // ONLY through the merchant's confirm (instapay-confirmation: it also records
    // the payment, the audit trail and the post-payment fan-out). A bare status
    // write would mark the order confirmed with no money recorded behind it.
    if (order.status === 'awaiting_payment_confirmation' && status === 'confirmed') {
      throw new AppError(
        409,
        'INSTAPAY_CONFIRM_REQUIRED',
        'Confirm the InstaPay payment to confirm this order'
      );
    }
    // pending/cancelled → refunded exists for orders that captured a payment
    // (PR #770). A manual status change must not mark an order that never took
    // money as refunded.
    if (
      status === 'refunded' &&
      (order.status === 'pending' || order.status === 'cancelled') &&
      !hasCapturedPayment(order)
    ) {
      throw new AppError(
        400,
        'ORDER_NOT_PAID',
        'This order has no captured payment, so it cannot be marked refunded'
      );
    }

    // Set deliveredAt when transitioning to delivered so the review-request
    // Inngest function has an accurate timestamp for the 90-day token expiry.
    const statusData: Record<string, unknown> = {
      status,
      // Arm the order/status-changed fanout for THIS transition: the fanout
      // claims it once (dedup across duplicate events, #558) and
      // order-status-fanout-stuck-sweep re-sends it if no fanout ever claims
      // it (an accepted-but-undelivered event, #619).
      statusFanoutRequestedAt: new Date(),
      statusFanoutClaimedAt: null,
      // WHICH transition (issue 2070): the stuck sweep re-sends this, not
      // whatever status a later direct writer left the row at.
      statusFanoutRequestedStatus: status,
      statusFanoutCompletedAt: null,
    };
    if (status === 'delivered' && order.status !== 'delivered') {
      statusData.deliveredAt = new Date();
    }
    // Paid on delivery (ruling MONEYB-7): a cash-on-delivery parcel handed over
    // IS the cash collected — the courier does not release it unpaid. Delivered
    // settles the COD payment the same way "Mark paid" does, so revenue, the GL
    // and the customer's order page stop showing a delivered order as unpaid.
    const codToSettle =
      status === 'delivered' && order.paymentStatus === 'unpaid'
        ? (order.payments ?? []).find(p => p.provider === 'cod' && p.status === 'cod_pending')
        : undefined;
    if (codToSettle) {
      statusData.paymentStatus = 'paid';
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
    // to its 300s TTL after a mutation like this. Deferred (same class as
    // customers.routes.ts's erase route, #1876): this update runs inside
    // orderRoutes' request tenant transaction, which commits AFTER the
    // handler returns — invalidating inline here lets a GET /customers
    // racing the still-open transaction re-cache the pre-update snapshot for
    // the full TTL. `deferAfterTenantCommit` fires it after COMMIT instead.
    void deferAfterTenantCommit('order.updateStatus.invalidateCustomersCache', () =>
      invalidateCustomersCache(storeId)
    ).catch(err =>
      logger.warn({ err, storeId, orderId }, '[order.updateStatus] cache invalidation failed')
    );

    if (codToSettle) {
      await prisma.payment.update({
        where: { id: codToSettle.id },
        data: { status: 'completed', paidAt: new Date() },
      });
      await recordPaymentEvent({
        paymentId: codToSettle.id,
        storeId,
        orderId,
        eventType: 'status_change',
        fromStatus: 'cod_pending',
        toStatus: 'completed',
        provider: 'cod',
        triggeredByUserId: null,
        details: { reason: 'cod_collected_on_delivery', orderNumber: order.orderNumber },
      });
      // Same post-payment fan-out as "Mark paid" (journal posting); its
      // notification half is deduped by orderCreatedNotifiedAt.
      void deferAfterTenantCommit('order.codCollectedOnDelivery', () =>
        inngest.send({
          name: 'order/created',
          data: { orderId, storeId, paymentMethod: 'cod', locale: undefined },
        })
      );
    }

    // Append-only status audit trail. `order.status` was read (via getById)
    // BEFORE the update above, so it is the true prior status. Best-effort:
    // mirrors recordPaymentEvent — a failed audit write must never block the
    // status change (the Order row is the source of truth; this is the aid).
    // actorId is null here: updateStatus has no acting-user id in scope.
    try {
      // Savepointed (issue 2215's class): the status update above shares the
      // request's tenant transaction; a swallowed failure here must not abort
      // it and silently roll the status change back behind a 2xx.
      await withSavepoint(() =>
        prisma.orderEvent.create({
          data: {
            storeId,
            orderId,
            fromStatus: order.status,
            toStatus: status,
            actorId: null,
          },
        })
      );
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
        ...(opts.restoreInventory === false ? { restoreInventory: false } : {}),
      });
    }

    // Post-purchase side effects (payment-success / shipped / admin-refund
    // emails, WhatsApp/SMS/push dispatch, affiliate commission, loyalty award,
    // shipping-carrier auto-create) now fan out on the `order/status-changed`
    // Inngest event as retriable steps that dead-letter on failure (Lens E,
    // E2-4) — they used to run here as in-process fire-and-forget `.catch(log)`
    // calls that vanished silently on a provider outage or a mid-deploy. Only
    // the money reversal request (applyRefundEffects, above — awaited; its
    // event is sent after COMMIT and swept if dropped, Ruling AP-2) and the
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
        // A REJECTED enqueue (Inngest outage / mid-deploy) runs the fanout
        // in-process right away (same pattern as the payment-webhook inline
        // fallback) rather than waiting for order-status-fanout-stuck-sweep,
        // which covers the accepted-but-never-delivered case. Both go through
        // the fanout's claim, so the two can never both send. `handleOrderStatusChanged` is imported statically at
        // the top of this file — an earlier revision used a dynamic import to
        // dodge a load-time cycle and the note outlived the code.
        // Best-effort + non-blocking.
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
    options: {
      restoreInventory?: boolean;
      fireRefundNotification?: boolean;
      /**
       * Whether the whole-order fanout may put the order's customer-wallet
       * spend back (D1, `reverse-wallet-payment` step). Defaults true — every
       * whole-order cancel/refund returns it. Partial events (a partial
       * return, a backorder single-LINE cancel — which also passes false,
       * belt and braces) never reverse the wallet.
       */
      reverseWallet?: boolean;
      /**
       * Item-level (partial-return) reversal. When present, the
       * `order-refunded` fanout restores ONLY the listed order-item
       * lines/quantities and SKIPS every whole-order reversal (coupon,
       * affiliate commission, loyalty, the refundReversedAt completion stamp
       * and the whole-sale GL journal reversal — the GL instead posts a
       * pro-rata adjustment for just the returned lines, see
       * accounting/posting/partial-return-posting.ts) — the customer kept
       * the rest of the order, so those stay earned/consumed. `refundKey`
       * (the Return id)
       * is the idempotency key for the partial restore, so two different
       * partial returns on one order each restore their own lines exactly
       * once. `refundAmount` overrides the notification amount so the
       * customer's "Refund issued" email states the partial amount, not the
       * order total.
       */
      partial?: {
        items: Array<{ orderItemId: string; quantity: number }>;
        refundKey: string;
        refundAmount?: number;
        /**
         * Set by the backorder single-line cancel (`refundKey`
         * `backorder:<id>`): that line is already cancelled, so the fanout's
         * `cancel-backorders` step must not cancel the item's OTHER open
         * backorder lines.
         */
        backorderLineId?: string;
        /**
         * A partial refund made OUTSIDE a return (`items` empty, `refundKey`
         * `refund:<providerRefundId>`, `refundAmount` = what was refunded):
         * the GL books it as a revenue refund and nothing else acts on it —
         * see PartialRefund.amountOnly in order-refunded.ts. Use
         * `recordRefundOutsideReturn` rather than building this by hand.
         */
        amountOnly?: boolean;
      };
      /**
       * Send the event now instead of after the request transaction commits.
       * ONLY for a caller whose facts are already committed on a transaction
       * of its own — PaymentService.refund commits the refund record before it
       * returns, so a later rollback of the request cannot un-happen it, and
       * waiting for the request would drop the GL entry of a refund that
       * stands whenever the request then fails.
       */
      sendNow?: boolean;
    } = {}
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

    // Arm the stuck-reversal sweep for a WHOLE-order, stock-restoring event,
    // whatever produced it (status change, manual full return, webhook):
    // stamp when the reversal was requested and re-null the completion claim,
    // so the fanout's final `claim-reversed` step is what marks it done. Keyed
    // on this rather than on status/updatedAt, a refund that never changes the
    // order's status (#839), a later unrelated edit (#855) and an earlier
    // event that claimed a still-live order (#858) can no longer hide a
    // dropped fanout. restoreInventory:false (backorder-line cancel) is not
    // armed: the sweep re-sends restoreInventory:true, which would invent
    // stock that was never reserved. Partial events never claim the ORDER; they
    // arm their own Return instead (below).
    if (restoreInventory && !options.partial) {
      await prisma.order.updateMany({
        where: { id: orderId, storeId },
        data: { refundReversalRequestedAt: new Date(), refundReversedAt: null },
      });
    }
    // The PARTIAL equivalent (issues 2246 / 2267): a partial event keyed on a
    // Return (ReturnService passes the Return id as refundKey) arms THAT row,
    // in the same transaction, and the fanout's partial arm stamps
    // `reversalAppliedAt` when it has run. refund-reversal-stuck-sweep re-sends
    // the item-level event for a return requested but never applied — the
    // post-commit enqueue failure Ruling AP-2 had accepted as a residual. A
    // partial keyed on anything else (no Return row) matches nothing here.
    if (restoreInventory && options.partial?.refundKey) {
      await prisma.return.updateMany({
        where: { id: options.partial.refundKey, storeId, orderId },
        data: { reversalRequestedAt: new Date(), reversalAppliedAt: null },
      });
    }

    // The event is sent only AFTER the caller's request transaction commits
    // (`deferAfterTenantCommit`); a rolled-back request drops it.
    //
    // Sending it inline, before COMMIT, let a status change that then rolled
    // back still reverse the ledger and restore stock: production has a
    // delivered + paid order whose sale entry was reversed "refund applied"
    // while the order itself never left `delivered` (demo-shop, order
    // ORD-1781512189610-9972A710, 2026-07-09 — the 30s request transaction
    // timed out, the status flip rolled back, the reversal had already
    // committed and the event had already been sent). The `order/refunded`
    // consumers — including the GL reversal — cannot tell a committed refund
    // from an uncommitted one, so the event must not exist until the refund
    // does.
    //
    // Outside a request (Inngest steps such as the payment-webhook refund
    // path, crons, scripts) there is no transaction to wait for: the send
    // runs inline and a failed enqueue still PROPAGATES, keeping the
    // let-it-throw retry semantics those callers rely on. Inside a request a
    // post-commit enqueue failure is alerted loudly by deferAfterTenantCommit,
    // and for a whole-order reversal the `refundReversalRequestedAt` stamp
    // written above (in the same transaction) lets
    // refund-reversal-stuck-sweep re-send it.
    const send = () =>
      inngest.send({
        name: 'order/refunded',
        data: {
          orderId,
          storeId,
          restoreInventory,
          notify,
          partial: options.partial,
          reverseWallet: options.reverseWallet ?? true,
        },
      });
    if (options.sendNow) {
      await send();
      return;
    }
    await deferAfterTenantCommit('order.applyRefundEffects.sendOrderRefunded', send);
  }

  /**
   * Record a refund the merchant made OUTSIDE a payment provider (cash handed
   * back, an InstaPay or bank transfer) when they mark the order refunded
   * (ruling MONEYB-5). Without this record a `refunded` status moved no money
   * on paper either, yet the customer was told "refund issued". Each captured
   * payment row is marked refunded for its full amount with the method,
   * reference and who recorded it; the order's paymentStatus follows.
   */
  static async recordManualRefund(
    storeId: string,
    orderId: string,
    input: { method: string; reference: string | null; actorId: string | null }
  ): Promise<void> {
    const payments = await prisma.payment.findMany({
      where: {
        orderId,
        order: { storeId },
        status: { in: ['completed', 'partially_refunded'] },
      },
      select: { id: true, amount: true, metadata: true, status: true, provider: true },
    });
    const now = new Date();
    for (const p of payments) {
      await prisma.payment.update({
        where: { id: p.id },
        data: {
          status: 'refunded',
          refundedAmount: p.amount,
          metadata: {
            ...((p.metadata as Record<string, unknown> | null) ?? {}),
            refundMethod: input.method,
            refundReference: input.reference,
            refundRecordedBy: input.actorId,
            refundRecordedAt: now.toISOString(),
            refundSource: 'manual_record',
          } as Prisma.InputJsonValue,
        },
      });
      await recordPaymentEvent({
        paymentId: p.id,
        storeId,
        orderId,
        eventType: 'status_change',
        fromStatus: p.status,
        toStatus: 'refunded',
        provider: p.provider,
        triggeredByUserId: input.actorId,
        details: { reason: 'manual_refund_recorded', method: input.method },
      });
    }
    await prisma.order.update({
      where: { id: orderId, storeId },
      data: { paymentStatus: 'refunded' },
    });
  }

  /**
   * A partial refund made OUTSIDE a return — in the provider's dashboard (the
   * refund webhook, a refund-status refresh) or the order page's
   * refund-via-provider with an amount. Owner decision 2026-10-01 (#1209,
   * #1455): booked as a revenue refund for exactly `amount`, with no stock
   * movement, idempotent per provider refund id. The GL entry is keyed on
   * `refund:<providerRefundId>`, so a redelivered webhook or a refresh that
   * re-reports the same refund books nothing more.
   *
   * No customer notification: a refund taken in the dashboard has never
   * notified the customer, and that is not changed here.
   */
  static async recordRefundOutsideReturn(
    storeId: string,
    orderId: string,
    refund: { providerRefundId: string; amount: number },
    options: { sendNow?: boolean } = {}
  ): Promise<void> {
    await this.applyRefundEffects(storeId, orderId, {
      restoreInventory: false,
      fireRefundNotification: false,
      reverseWallet: false,
      sendNow: options.sendNow,
      partial: {
        items: [],
        refundKey: amountOnlyRefundKey(refund.providerRefundId),
        refundAmount: refund.amount,
        amountOnly: true,
      },
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
   * then issue a payment link via the existing
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
      paymentProvider?: 'paymob' | 'kashier' | 'fawry' | 'instapay' | 'cod';
      notes?: string;
      couponCode?: string;
      currency?: string;
      /**
       * Optional shipping fee override in integer piastres (EGP × 100).
       * When present, replaces the ShippingService-computed fee.
       * Used for negotiated phone-order rates.
       */
      shippingOverride?: number;
      /**
       * Apply `couponCode` outside its rules (owner decision 2026-09-25,
       * #1370, ruling M-OVR-1). Honoured only for `actorRole` in
       * COUPON_OVERRIDE_ROLES and only with a `couponOverrideReason`; the
       * override, who made it and why are written to the order's event and
       * audit log.
       */
      overrideCouponRules?: boolean;
      couponOverrideReason?: string;
    },
    actor: { role?: string } = {}
  ) {
    await assertOrderAllowed(storeId);
    if (data.items.length === 0) {
      throw new AppError(400, 'NO_ITEMS', 'Order must have at least one item');
    }

    // The admin form may attach an existing customer by id. Products,
    // variants and coupons below are all validated against this store — the
    // customer was not, so any platform user's uuid could be attached to a
    // fabricated order and their name + email read back through the order
    // detail include. Validate it the same way.
    if (data.customerId) {
      const customer = await prisma.user.findFirst({
        where: { id: data.customerId, storeId, role: 'customer' },
        select: { id: true },
      });
      if (!customer) {
        throw new AppError(404, 'NOT_FOUND', 'Customer not found for this store');
      }
    }

    // Hydrate product + variant prices from the DB. Admin form
    // submits only productId + quantity; we look up the canonical
    // price here so a tampered or stale price never persists.
    const productIds = Array.from(new Set(data.items.map(it => it.productId)));
    // `deletedAt: null`: without it an admin manual order hydrates prices from,
    // and decrements stock against, a product the merchant already deleted —
    // `ProductService.delete` leaves `status: 'active'`, so the filter above
    // does not exclude it.
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId, status: 'active', deletedAt: null },
      include: {
        variants: true,
        // Category ids feed the coupon's category scope (#1370).
        categories: { select: { categoryId: true } },
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
        // Admin manual orders never snapshotted cost at all, so every line
        // they created had no COGS and no profit. Same rule as checkout.
        costPrice: lineUnitCost(product, it.variantId),
        quantity,
        lineTotal,
      };
    });

    const subtotal = resolved.reduce((sum, r) => sum + r.lineTotal, 0);

    // Tax: same store-level resolution as the public checkout path, levied
    // after the coupon discount below (#193).
    const activeTax = await resolveActiveTaxRate(storeId);

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
    // (integer piastres), it takes precedence over the calculated value.
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

    // Coupon — owner decision 2026-09-25 (#1370, ruling M-OVR-1): an admin /
    // phone order ENFORCES the coupon's rules by default, exactly like
    // checkout — dates, store-wide and per-customer usage limits, minimum
    // order, customer group, first order, minimum quantity, product/category
    // scope — and a scoped coupon discounts only its in-scope lines. A
    // store_admin/super_admin may override the rules with a reason; the
    // override is recorded (order event + audit log) with who and why.
    let couponDiscount = 0;
    let couponCode: string | undefined;
    // Kept in outer scope (not just `couponCode`) so the per-user usage
    // check inside the transaction below can read `usageLimitPerUser` —
    // mirrors `appliedCoupon` in OrderService.create.
    let appliedCoupon: Awaited<ReturnType<typeof CouponService.getByCode>> | null = null;
    const overrideCoupon = !!data.couponCode && data.overrideCouponRules === true;
    const overrideReason = data.couponOverrideReason?.trim() ?? '';
    const couponViolations: CouponRuleViolation[] = [];
    if (overrideCoupon) {
      if (!actor.role || !COUPON_OVERRIDE_ROLES.includes(actor.role)) {
        throw new AppError(
          403,
          'COUPON_OVERRIDE_FORBIDDEN',
          'Only a store admin can override coupon rules'
        );
      }
      if (!overrideReason) {
        throw new AppError(
          400,
          'COUPON_OVERRIDE_REASON_REQUIRED',
          'A reason is required to override coupon rules'
        );
      }
    }
    if (data.couponCode) {
      // Active coupons of THIS store only — an override bypasses the rules,
      // never the merchant's own on/off switch.
      appliedCoupon = await prisma.coupon.findFirst({
        where: {
          storeId,
          code: { equals: data.couponCode, mode: 'insensitive' },
          isActive: true,
        },
      });
      if (!appliedCoupon) {
        throw new AppError(404, 'NOT_FOUND', 'Coupon not found or inactive');
      }
      const idPhone =
        typeof data.shippingAddress.phone === 'string' ? data.shippingAddress.phone : null;
      const idEmail =
        typeof data.shippingAddress.email === 'string' ? data.shippingAddress.email : null;
      const custCtx = await resolveCustomerContext(storeId, {
        phone: idPhone,
        email: idEmail,
        customerId: data.customerId ?? null,
      });
      const targetingCtx = {
        ...custCtx,
        cartItems: resolved.map(r => ({
          productId: r.productId,
          categoryIds: (productMap.get(r.productId)?.categories ?? []).map(c => c.categoryId),
          quantity: r.quantity,
          lineTotal: r.lineTotal,
        })),
      };
      couponViolations.push(
        ...CouponService.adminOrderCouponViolations(appliedCoupon, targetingCtx, subtotal)
      );
      if (couponViolations.length > 0 && !overrideCoupon) {
        const first = couponViolations[0];
        throw new AppError(400, first.code, first.message);
      }
      if (appliedCoupon.type === 'free_shipping') {
        shipping = 0;
      } else {
        couponDiscount = CouponService.adminOrderCouponDiscount(
          appliedCoupon,
          targetingCtx,
          subtotal,
          overrideCoupon
        );
      }
      couponCode = appliedCoupon.code;
    }

    // Same order of operations and VAT base as checkout (ruling MONEYB-2):
    // shipping is in the base; inclusive tax is extracted, never added (M3-6).
    // Admin manual orders carry no COD fee (the merchant sets the price).
    const { tax, total, taxableAmount } = computeOrderAmounts({
      subtotal,
      discount: couponDiscount,
      shipping,
      ratePercent: activeTax.ratePercent,
      includedInPrice: activeTax.includedInPrice,
    });
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
            if (!overrideCoupon) {
              throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
            }
            couponViolations.push({
              code: 'COUPON_LIMIT_REACHED',
              message: 'Per-customer coupon usage limit reached',
            });
          }
        }
      }

      // Reserve the redemption atomically, like checkout. Admin orders never
      // counted toward `usageCount`, yet cancelling one ran the fanout's
      // reverse-coupon step and DEcremented it — handing another customer's
      // redemption back to the limit. An override still counts the use; it
      // only skips the `< usageLimit` guard.
      if (appliedCoupon) {
        const reserve = await tx.coupon.updateMany({
          where: {
            id: appliedCoupon.id,
            storeId,
            isActive: true,
            ...(!overrideCoupon && appliedCoupon.usageLimit
              ? { usageCount: { lt: appliedCoupon.usageLimit } }
              : {}),
          },
          data: { usageCount: { increment: 1 } },
        });
        if (reserve.count === 0) {
          throw overrideCoupon
            ? new AppError(404, 'NOT_FOUND', 'Coupon not found or inactive')
            : new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
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
          // See the public checkout path above — the convention `tax` was
          // charged under travels with the order, not with the store.
          taxIncludedInPrice: activeTax.includedInPrice,
          // Seller TRN / legal name / rate frozen for the tax invoice — only
          // when VAT was collected under a VERIFIED profile (ruling TAX-2).
          ...frozenTaxInvoiceFields(activeTax),
          shipping,
          taxableAmount,
          discount: couponDiscount,
          total,
          currency: data.currency ?? REGION.currency,
          couponCode: couponCode ?? null,
          shippingAddress: withStoredPhone(data.shippingAddress) as Prisma.InputJsonValue,
          billingAddress: withStoredPhone(
            data.billingAddress ?? data.shippingAddress
          ) as Prisma.InputJsonValue,
          notes: data.notes ?? null,
          items: {
            create: resolved.map(r => ({
              productId: r.productId,
              productName: r.productName,
              sku: r.sku,
              variantId: r.variantId,
              // OrderItem's column is `variantName`. Writing `variantTitle`
              // (no such field) made Prisma reject the whole create, so every
              // admin manual order with a variant line failed since the
              // phone-order MVP (2ba38332) — found by the cost-snapshot test.
              variantName: r.variantTitle,
              price: r.unitPrice,
              costPrice: r.costPrice,
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

      // The durable record of a coupon override — in the order transaction,
      // so an overridden order can never exist without it. The audit-log row
      // below is best-effort (auditLog swallows its own failures).
      if (overrideCoupon && couponCode) {
        await tx.orderEvent.create({
          data: {
            storeId,
            orderId: created.id,
            fromStatus: null,
            toStatus: COUPON_OVERRIDE_EVENT,
            actorId: adminUserId,
            metadata: {
              couponCode,
              reason: overrideReason,
              actorRole: actor.role ?? null,
              // Rules the order actually broke (empty = override was not needed).
              violations: couponViolations.map(v => v.code),
              discount: couponDiscount,
            },
          },
        });
      }
      // Fiscal document + gap-free serial in the same transaction (MONEYB-1).
      await FiscalDocumentService.issueSaleDocument(tx, storeId, created.id);
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

    if (overrideCoupon && couponCode) {
      // storeId set so the merchant's order timeline shows it (the customer's
      // view of the timeline filters it out — order.routes.ts).
      await auditLog({
        action: COUPON_OVERRIDE_AUDIT_ACTION,
        userId: adminUserId,
        storeId,
        resourceType: 'order',
        resourceId: order.id,
        details: {
          orderNumber: order.orderNumber,
          couponCode,
          description: overrideReason,
          violations: couponViolations.map(v => v.code),
          discount: couponDiscount,
        },
      });
    }

    logger.info(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        adminUserId,
        itemsCount: resolved.length,
      },
      '[Admin-Order] created on behalf of customer'
    );

    // Same soft monthly-cap policy as storefront checkout (SP5).
    void deferAfterTenantCommit('plan.noteOrderCreated', () => noteOrderCreated(storeId));

    return order;
  }
}
