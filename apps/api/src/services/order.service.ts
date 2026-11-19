import { createHash } from 'node:crypto';
import { customerRow, customerRows, isLiveCustomer, pickSelected } from '../lib/customer-directory';
import { orderSearchIds, ORDER_SEARCH_CUSTOMER_ID_CAP } from '../lib/order-search-ids';
import { matchingCustomers, type CustomerMatches } from './admin-search.service';
export {
  ORDER_SEARCH_CUSTOMER_ID_CAP,
  orderSearchIds,
  orderSearchIdsSql,
} from '../lib/order-search-ids';
import { randomUUID } from 'node:crypto';
import {
  prisma,
  Prisma,
  OrderStatus,
  withMoneyTx,
  scopeTransaction,
  withStore,
} from '@ebda/database';
import {
  checkMinimumOrder,
  allocateBundlePrice,
  codFeeForOrder,
  computeOrderAmounts,
  fromMinor,
  minorToDecimalString,
  normalizePhoneForStorage,
  normalizeArabicSearch,
  activePersonalisation,
  REGION,
  orderNumberFromScanCode,
} from '@ebda/shared';
import { FiscalDocumentService } from './fiscal-document.service';
import { recordPaymentEvent, recordPaymentEventForStore } from './payment-event.service';

/** An address JSON with its `phone` in the one stored form (ruling MONEYB-7). */
function withStoredPhone(addr: Record<string, unknown>): Record<string, unknown> {
  return typeof addr.phone === 'string'
    ? { ...addr, phone: normalizePhoneForStorage(addr.phone) }
    : addr;
}
import { loadCodFeeConfig } from './payment-providers/cod.provider';
import { generateOrderNumber } from '../utils/order-number';
import { countPriorCouponUses, type CouponLimitTx } from '../lib/coupon-per-customer-limit';
import { PriceResolver, wholesaleEntitledUncached } from './price-resolver.service';
import { assertGoldLinesPriceable, assertSameRates } from './gold-rate/gate';
import { assertGoldPaymentAllowed } from './gold-rate/payment-policy';
import { redactOrderForCustomer } from './gold-rate/public';
import { ANONYMOUS_BUYER, type BuyerIdentity } from '../lib/buyer-identity';
import { canSeeWholesaleOnly } from '../lib/audience';
import {
  assertMoqSatisfied,
  priceSnapshot,
  eligibleForCoupon,
  loyaltyRedeemableSubtotal,
} from '../lib/order-pricing';
import { pairBackorderedLines } from '../lib/backorder-pairing';
import { restoreCartShape } from '../lib/order-cart-restore';
import { AppError } from '../middleware/error-handler';
import { variantRequiredError } from '../lib/variant-required';
import { resolveOrderDeliveryNote } from '../lib/order-delivery-slot';
import { CartService } from './cart.service';
import { resolveBundle } from './bundle.service';
import { STOREFRONT_PRODUCT_SELECT } from './product.service';
import { CouponService, type CouponRuleViolation } from './coupon.service';
import {
  COUPON_OVERRIDE_AUDIT_ACTION,
  COUPON_OVERRIDE_EVENT,
  COUPON_OVERRIDE_ROLES,
} from '../lib/coupon-override';
import { STOCK_NOT_TAKEN_EVENT } from '../lib/stock-not-taken';
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
import { lineAllowsBackorder } from '../lib/effective-inventory';
import { frozenTaxInvoiceFields, resolveActiveTaxRate } from '../lib/order-tax';
import {
  invalidateStoreProductCachesAfterOrder,
  invalidateCustomersCache,
} from '../lib/public-cache';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { sendCartRecoveredToCi } from '../lib/ci/emit';
import { assertOrderAllowed, noteOrderCreated } from './plan-limit.service';
import { amountOnlyRefundKey } from '../lib/refund-methods';
import { lineUnitCost } from '../lib/order-line-cost';
import { customerKeyOf } from '../lib/customer-key';
import { SmsConsentService } from './sms-consent.service';
import {
  assertStockHoldCapNotExceeded,
  HOLD_CAPPED_PAYMENT_METHODS,
  resolveStoreHoldCaps,
} from '../lib/stock-hold-cap';
import {
  storeDb,
  storeMoney,
  storeRepo,
  type CreateOrderArgs,
  type MoneyClient,
} from '../lib/repo-factory';

/**
 * The store's `settings` + `timezone` from its own backend (NEON-ZERO-1 N-4): a Durable Object store's record is its DO, a
 * Postgres store keeps the `withStore` read it always had. Same row, same select.
 */
async function readStoreSettings(storeId: string) {
  const query = { where: { id: storeId }, select: { settings: true, timezone: true } } as const;
  const repo = await storeRepo(storeId);
  return repo.backend === 'do'
    ? repo.db.store.findUnique(query)
    : withStore(storeId, tx => tx.store.findUnique(query));
}

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
/** Thrown inside the checkout transaction when a concurrent request with the same key already created the order. */
class CheckoutReplay extends Error {
  constructor(readonly orderId: string) {
    super('checkout replay');
  }
}

const CHECKOUT_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
/** sha256(session | key) or null when the client sent no key; a malformed key is a 400 (never silently ignored). */
function checkoutIdempotencyHash(sessionId: string, key: string | null | undefined): string | null {
  if (key === undefined || key === null || key === '') return null;
  if (!CHECKOUT_KEY_RE.test(key))
    throw new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8 to 128 characters of letters, digits and . _ : -'
    );
  return createHash('sha256').update(`${sessionId}|${key}`).digest('hex');
}

/** Key-sorted JSON, so the same request always hashes the same. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter(k => o[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * What the shopper ASKED for (address, payment method, coupon, points, wallet, notes, delivery slot). Stored beside the
 * checkout key: a retry that changes any of it under the SAME key is a different request and gets 409 IDEMPOTENCY_CONFLICT,
 * never the first order (which would have been COD for a shopper who has since chosen a card). `expectedTotal` is a guard,
 * not intent, and is left out.
 */
function checkoutRequestHash(data: CreateOrderData): string {
  const { expectedTotal: _ignored, ...intent } = data as unknown as Record<string, unknown>;
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

const IDEMPOTENCY_CONFLICT = () =>
  new AppError(
    409,
    'IDEMPOTENCY_CONFLICT',
    'This checkout was already submitted with different details. Review it and place the order again.'
  );

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

export interface OrderQuote {
  subtotal: number;
  discount: number;
  shipping: number;
  codFee: number;
  tax: number;
  /** The amount the server will put on the order (piastres). `expectedTotal` is compared with this. */
  total: number;
  taxIncludedInPrice: boolean;
  lines: Array<{
    itemId: string;
    productId: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    listPrice: number;
    priceSource: 'base' | 'tier' | 'group';
    priceTierMinQty: number | null;
  }>;
}

interface CreateOrderData {
  /** The total (piastres) the shopper last saw. Compared, never charged: a mismatch is 409 PRICE_CHANGED (Ruling B2B-9). */
  expectedTotal?: number;
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
  /** The delivery date (store-local YYYY-MM-DD) + window picked at a `daysAhead` checkout (Ruling B4-7). A request, validated against live settings. */
  deliveryDate?: string;
  deliveryWindowId?: string;
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

/** The `shipping_address` keys a guest's contact lives under (see `contactOf`, lib/customer-key.ts). */
const GUEST_CONTACT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;

/**
 * The OR arms of the order-list search: order number, or the registered
 * customer's first name / last name / email / phone (issue 2405).
 *
 * WHY lookups first. The obvious shape — `customer: { is: { firstName: contains } }` per
 * field — is compiled by Prisma into four LEFT JOINs onto `users` with an OR spanning both
 * tables, which no index can serve (measured: 150-270 ms per query at 50k orders). Resolving the
 * matching ids first turns every arm into a predicate on `orders` itself: `id IN (...)` for the
 * order number and the guests, `customer_id IN (...)` (btree) for registered customers.
 *
 * The lookups run in the store-scoped SECURITY DEFINER `ebda_order_search_ids` (Ruling
 * SEARCH-T14-5/-7), because as `ebda_app` the RLS barrier forbids every ILIKE trigram index when
 * the predicate is written inline. It takes the store only from the session scope and returns ids
 * only; this function then re-reads orders through RLS.
 *
 * Which customers match: users WITH AN ORDER in this store (soft-deleted orders do not count)
 * whom the `users` RLS policy would show a store scope — registered on THIS store (`users.store_id`),
 * the caller, the store's owner/staff, or a super admin. A customer with `users.store_id` NULL or
 * registered on another store is NOT matched, exactly as the relation join already behaved under
 * `ebda_app` (the old comment here claimed the opposite; that was true only for an owner role).
 *
 * Customers and GUEST orders (`customer_id IS NULL`, contact only in the `shipping_address` JSON)
 * both come from `matchingCustomers` (Search P2): Arabic-normalised names ("احمد" finds "أحمد"), the
 * phone in any form ("0101 234 5678", "+20…", "٠١٠…"), and the email, served by the normalised
 * expression trigram indexes of migration 20261027000100 (and the older email indexes). The order
 * number also matches by its digits alone ("#١٢٣٤" finds "EB-1234").
 *
 * Falls back to the relation filter when the term is shorter than a trigram
 * (3 chars — the indexes cannot serve it, so the lookup would only add a
 * scan), and for a customer searching their own orders (`indexed: false`). A term matching more than `ORDER_SEARCH_CUSTOMER_ID_CAP` customers
 * or guest orders degrades ONLY that half to its relation/JSON arm; the other
 * half keeps its indexed `IN (...)` arm (issue 2444).
 */
/**
 * What a barcode scanner types: the 18 digits of `scanCodeFor('ORD-xxxxxx-xxxxx')`
 * (Ruling BARCODE-4). Returns the real order number, or null for anything that is
 * not a scan code (typed searches, phones, `EBD-` payment numbers).
 */
export function orderNumberFromScan(input: string): string | null {
  const n = orderNumberFromScanCode(input.trim());
  return n.startsWith('ORD-') ? n : null;
}

/**
 * The OR arms of the order search for a DO store (Ruling CF-R4-1): the same three arms as the indexed Postgres path (order
 * number, registered customers by `customer_id`, guest orders by id), their ids resolved inside the StoreDO from its derived
 * search index (Arabic-folded names, any phone form, email, the guest contact snapshot). There is no relation fallback on a
 * DO, so a term so broad that a cap is hit is refused loudly rather than answered with a short list.
 */
async function orderSearchArmsOnDo(
  money: MoneyClient,
  search: string
): Promise<Prisma.OrderWhereInput[]> {
  const r = await money.searchOrders({ search });
  if (r.truncated)
    throw new AppError(
      422,
      'ORDER_SEARCH_TOO_BROAD',
      'That search matches too many orders: add more of the name, number or phone'
    );
  const arms: Prisma.OrderWhereInput[] = [];
  if (r.numberIds.length) arms.push({ id: { in: r.numberIds } });
  if (r.userIds.length) arms.push({ customerId: { in: r.userIds } });
  if (r.guestOrderIds.length) arms.push({ id: { in: r.guestOrderIds } });
  if (arms.length === 0) arms.push({ id: { in: [] } });
  return arms;
}

export async function orderSearchWhere(
  storeId: string,
  search: string,
  opts: {
    indexed?: boolean;
    /** The customer lookup, when the caller already ran it (the ⌘K route does): not repeated. */
    matches?: CustomerMatches;
    /** Cap for the order-number id lookups (default `ORDER_SEARCH_CUSTOMER_ID_CAP + 1`). */
    numberIdLimit?: number;
  } = {}
): Promise<Prisma.OrderWhereInput[]> {
  // A scanned receipt/slip/email barcode opens that order: one exact arm, no customer fan-out.
  // Still store-scoped: callers AND this with their own `storeId`.
  const scanned = orderNumberFromScan(search);
  if (scanned) return [{ orderNumber: scanned }];
  // A store on its Durable Object answers from the DO's own search index (Ruling CF-R4-1); the Postgres code below is untouched.
  const money = await storeMoney(storeId);
  if (money) return orderSearchArmsOnDo(money, search);
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
  // path filter is the unindexed guest lookup (the indexed `guest` definer kind was dropped, SEARCH-P2-5).
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
  // A customer searching THEIR OWN orders (`indexed: false`) never calls the store-wide id lookup:
  // the lookup answers for the whole store, and only a store viewer may ask the store a question.
  // The relation fallback is ANDed with their customerId by the caller.
  // Prisma's `contains` does not escape LIKE metacharacters, so the relation fallback would turn a
  // typed "%" into "match every order": a term holding one always takes the escaped lookups.
  if ((search.length < 3 && !/[%_\\]/.test(search)) || opts.indexed === false) {
    return relationFallback;
  }

  // Store-scoped id lookups (see the docblock): the order number (the typed text, plus its digits
  // alone when it has 4+, so "#١٢٣٤" finds "EB-1234"), and the customers + guest orders through
  // `matchingCustomers` (Arabic-normalised names, any phone form, email; Search P2 Task 17).
  // Only a term made of digits (with #, spaces, dashes) is also tried as the number's digits alone:
  // a mixed term like "Gwendolyn58123" must not turn its digits into an order-number filter.
  const folded = normalizeArabicSearch(search);
  const digits = /^[#\s-]*[0-9][0-9\s-]*$/.test(folded) ? folded.replace(/\D/g, '') : '';
  const [numberIdsRaw, digitIds, matches] = await Promise.all([
    orderSearchIds(storeId, 'order_number', search, opts.numberIdLimit),
    digits.length >= 4 && digits !== search
      ? orderSearchIds(storeId, 'order_number', digits, opts.numberIdLimit)
      : Promise.resolve([] as string[]),
    opts.matches ?? matchingCustomers(storeId, search),
  ]);
  const numberIds = [...new Set([...numberIdsRaw, ...digitIds])];
  const customerIds = matches.usersTruncated ? [] : matches.userIds;
  const guestOrderIds = matches.guestsTruncated ? [] : matches.guestOrderIds;
  const customers = customerIds.map(id => ({ id }));
  // Each half degrades on its OWN: a broad guest term (every Egyptian guest phone starts `+20`)
  // must not cost the registered half its indexed `customer_id IN (...)` arm, nor the reverse
  // (issue 2444). Both over the cap is exactly `relationFallback`.
  const arms: Prisma.OrderWhereInput[] = [];
  if (numberIds.length > ORDER_SEARCH_CUSTOMER_ID_CAP) arms.push({ orderNumber: contains });
  else if (numberIds.length > 0) arms.push({ id: { in: numberIds } });
  if (matches.usersTruncated || customers.length > ORDER_SEARCH_CUSTOMER_ID_CAP) {
    arms.push({ customer: { is: { OR: customerMatch } } });
  } else if (customers.length > 0) {
    arms.push({ customerId: { in: customers.map(c => c.id) } });
  }
  if (matches.guestsTruncated || guestOrderIds.length > ORDER_SEARCH_CUSTOMER_ID_CAP) {
    arms.push(guestJsonMatch);
  } else if (guestOrderIds.length > 0) {
    arms.push({ id: { in: guestOrderIds } });
  }
  // Nothing matched anywhere: an explicit match-nothing arm (an empty OR is easy to misread).
  if (arms.length === 0) arms.push({ id: { in: [] } });
  return arms;
}

/**
 * An order read for a store on its Durable Object (Ruling CF-R2-1). `Order.customer` is a `User` on the platform database,
 * which the DO cannot join: the DO read leaves the relation out of the include and the customers are attached here, with the
 * same select and the same visibility the Postgres relation join had under `ebda_app` (a customer registered on THIS store).
 */
async function attachCustomers<T extends { customerId: string | null }>(
  storeId: string,
  rows: T[],
  select: Prisma.UserSelect
): Promise<T[]> {
  const ids = [...new Set(rows.map(r => r.customerId).filter((x): x is string => !!x))];
  const doRows = await customerRows(storeId, ids);
  const users: Array<{ id: string }> = doRows
    ? doRows.map(u => pickSelected(u, select as Record<string, unknown>) as { id: string })
    : ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids }, storeId },
          select: { id: true, ...select },
        })
      : [];
  const byId = new Map(users.map(u => [u.id, u]));
  return rows.map(r => ({
    ...r,
    customer: r.customerId ? (byId.get(r.customerId) ?? null) : null,
  }));
}
/** The include of an order read: on a DO store without the `customer` relation (see `attachCustomers`). */
function forBackend<const I extends { customer?: unknown }>(onDo: boolean, include: I): I {
  if (!onDo) return include;
  const { customer: _external, ...rest } = include;
  return rest as I;
}

/**
 * `id -> nameAr` for a set of product ids, in ONE query selecting only those two columns, keyed on the primary key
 * (`id IN (...)`, scoped by store): the plan is a PK lookup, so no new index is needed. At most `limit` (<=100) orders
 * x their lines, de-duplicated. Exported for the query-shape test.
 */
export async function productArabicNames(
  db: { product: { findMany: (args: { where: object; select: object }) => Promise<unknown> } },
  storeId: string,
  productIds: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const ids = [...new Set(productIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return new Map();
  const rows = (await db.product.findMany({
    where: { storeId, id: { in: ids } },
    select: { id: true, nameAr: true },
  })) as Array<{ id: string; nameAr: string | null }>;
  return new Map(rows.filter(r => r.nameAr).map(r => [r.id, r.nameAr as string]));
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
    if (search) where.OR = await orderSearchWhere(storeId, search, { indexed: !customerId });
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

    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const where = await OrderService.listWhere(storeId, options);

    const baseFindManyArgs = {
      where,
      include: forBackend(onDo, {
        // `phone` is included so the admin customers page can surface
        // it without doing a second query. Stays nullable on the User
        // record itself.
        customer: {
          select: { id: true, email: true, firstName: true, lastName: true, phone: true },
        },
        items: true,
        payments: { select: { provider: true, status: true } },
        _count: { select: { items: true } },
      }),
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

    const [found, total] = await Promise.all([
      repo.db.order.findMany(findManyArgs),
      repo.db.order.count({ where }),
    ]);
    const ordersRaw = onDo
      ? await attachCustomers(storeId, found, {
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
        })
      : found;

    const pageRows = cursor && ordersRaw.length > limit ? ordersRaw.slice(0, limit) : ordersRaw;
    // QA-D1: the list rows carried only `payments[]`, so a consumer reading `paymentMethod` got null. The
    // method is the provider of the completed payment, else of the newest one (same rule as the detail card).
    // STORE-QA-8: the line's Arabic name for the list (lines snapshot only the English one). ONE extra read of
    // `products.nameAr` by primary key for the page's distinct product ids: no join, no include widening.
    const arNames = await productArabicNames(
      repo.db,
      storeId,
      pageRows.flatMap(o =>
        ((o as { items?: Array<{ productId?: string | null }> }).items ?? []).map(i => i.productId)
      )
    );
    const orders = pageRows.map(o => {
      const pays = ((o as { payments?: Array<{ provider: string; status: string }> }).payments ??
        []) as Array<{ provider: string; status: string }>;
      const chosen = pays.find(p => p.status === 'completed') ?? pays[0];
      const items = ((o as { items?: Array<{ productId?: string | null }> }).items ?? []).map(
        i => ({
          ...i,
          product: { nameAr: (i.productId && arNames.get(i.productId)) || null },
        })
      );
      return { ...o, items, paymentMethod: chosen?.provider ?? null };
    });
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
    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const found = await repo.db.order.findFirst({
      where: { id: orderId, storeId, deletedAt: null },
      include: forBackend(onDo, {
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
      }),
    });

    if (!found) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }
    const order = onDo
      ? (
          await attachCustomers(storeId, [found], {
            email: true,
            firstName: true,
            lastName: true,
          })
        )[0]
      : found;

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
      const ip = await repo.db.payment.findFirst({
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

  /** The order a previous request with this checkout key created, in the shape `create` returns; null when none. */
  static async findCheckoutReplay(storeId: string, idemHash: string, reqHash: string) {
    // A DO store's keyed retry is answered by its engine, which keys on `idempotency_key` (see `createOnDo`): there is no
    // Postgres row to look up, and asking Postgres for it threw POSTGRES_REMOVED on every keyed checkout (the storefront always
    // sends an Idempotency-Key). Found by money-path.test.ts (review NEW-2 of PR 455).
    if (await storeMoney(storeId)) return null;
    const found = await prisma.order.findFirst({
      where: { storeId, checkoutIdempotencyKey: idemHash },
      select: { id: true, checkoutRequestHash: true },
    });
    if (!found) return null;
    if (found.checkoutRequestHash && found.checkoutRequestHash !== reqHash)
      throw IDEMPOTENCY_CONFLICT();
    return OrderService.loadCreatedOrder(storeId, found.id);
  }

  private static async loadCreatedOrder(storeId: string, orderId: string) {
    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const found = await repo.db.order.findFirst({
      where: { id: orderId, storeId },
      include: forBackend(onDo, {
        items: true,
        customer: { select: { id: true, email: true, firstName: true, lastName: true } },
      }),
    });
    if (!found || !onDo) return found;
    return (
      await attachCustomers(storeId, [found], { email: true, firstName: true, lastName: true })
    )[0];
  }

  static async getByOrderNumber(storeId: string, orderNumberOrScan: string) {
    // Accepts the typed number or the scanned barcode digits (Ruling BARCODE-4).
    const orderNumber = orderNumberFromScan(orderNumberOrScan) ?? orderNumberOrScan;
    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const found = await repo.db.order.findFirst({
      where: { orderNumber, storeId, deletedAt: null },
      include: forBackend(onDo, {
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
      }),
    });

    if (!found) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    return onDo
      ? (
          await attachCustomers(storeId, [found], { email: true, firstName: true, lastName: true })
        )[0]
      : found;
  }

  /**
   * The exact amounts `create` would charge for this cart, buyer and inputs, computed by `create` itself in dry-run mode so
   * the two can never drift (design review I-1). The checkout shows `total` and sends it back as `expectedTotal`.
   */
  static async quote(
    storeId: string,
    customerId: string | undefined,
    sessionId: string,
    data: CreateOrderData,
    buyer: BuyerIdentity
  ): Promise<OrderQuote> {
    return (await OrderService.create(storeId, customerId, sessionId, data, undefined, {
      buyer,
      dryRun: true,
    })) as unknown as OrderQuote;
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
    requestContext?: {
      checkoutIp?: string | null;
      /**
       * The client's `Idempotency-Key` header for THIS checkout request (audit M-012). A retry of the same request (same session +
       * key) returns the order the first one created instead of creating a second.
       */
      idempotencyKey?: string | null;
      /**
       * Who this order is priced for (lib/buyer-identity.ts): the signed-in customer session, minted by the route via
       * `buyerFromRequest(req)`. Absent = anonymous (retail + public tiers), e.g. WhatsApp / MCP callers.
       */
      buyer?: BuyerIdentity;
      /**
       * Compute everything up to the final total with the REAL create logic (pricing, MOQ, coupon / promotion, loyalty,
       * shipping, COD fee, VAT) and return it as an `OrderQuote` WITHOUT touching stock, wallet or the database. This is
       * how the checkout learns the exact total the server will charge (`OrderService.quote`).
       */
      dryRun?: boolean;
    }
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
        ...(typeof data.shippingAddress.email === 'string'
          ? { email: data.shippingAddress.email.trim().toLowerCase() }
          : {}),
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

    // Checkout idempotency (audit M-012). The stored value is a hash of (session, key), so only the SAME session can replay a key.
    const idemHash = checkoutIdempotencyHash(sessionId, requestContext?.idempotencyKey);
    const reqHash = checkoutRequestHash(data);
    if (idemHash) {
      const prior = await OrderService.findCheckoutReplay(storeId, idemHash, reqHash);
      if (prior) return prior;
    }

    // Get cart
    // The lines are priced below with the REAL buyer; skip the cart service's own (anonymous) pricing pass, whose result was
    // thrown away (design review M-7).
    const cart = await CartService.getOrCreate(storeId, sessionId, customerId, ANONYMOUS_BUYER, {
      skipPricing: true,
    });
    // Raw CartBundle rows ({ id, bundleId, quantity } — one per BOX type in
    // the cart). A cart holding ONLY bundles (no loose items) is valid, so
    // the empty-cart guard below must check both, not just `cart.items`.
    const cartBundles = cart.bundles ?? [];

    if (cart.items.length === 0 && cartBundles.length === 0) {
      // A keyed retry of an order the DO already placed: the first request consumed the cart, so the retry finds it empty. The
      // order is read back by its key (scoped to this cart, like the engine's own replay) instead of failing EMPTY_CART.
      const idemKey = requestContext?.idempotencyKey;
      if (idemKey && (await storeMoney(storeId))) {
        const prior = await (
          await storeDb(storeId)
        ).order.findFirst({
          where: {
            storeId,
            idempotencyKey: `${cart.id}:${checkoutIdempotencyHash(cart.id, idemKey)}`,
          },
          select: { id: true },
        });
        if (prior) {
          const replay = await OrderService.loadCreatedOrder(storeId, prior.id);
          if (replay) return replay;
        }
      }
      throw new AppError(400, 'EMPTY_CART', 'Cart is empty');
    }

    // Store on its Durable Object (Ruling CF-ORDERS-1): pricing, stock reservation, hold cap, coupon limit, loyalty redeem,
    // wallet debit and the order rows are ONE section there, in place of the interactive transaction below.
    const money = await storeMoney(storeId);
    if (money) {
      return OrderService.createOnDo(money, {
        storeId,
        customerId,
        data,
        cart: { id: cart.id, items: cart.items, bundles: cartBundles },
        referralCode,
        requestContext,
      });
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
        // B2B minimum order quantity (Review Focus 7): judged below on the product total.
        moq: true,
        // Made-to-order lead time: the longest one in the cart sets the earliest delivery date (Ruling B4-7).
        leadTimeDays: true,
        audience: true,
        name: true,
        nameAr: true,
        // Every variant row (disabled included): the sizeless-line gate below.
        _count: { select: { variants: true } },
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

    // B2B-7b: a wholesale-only line in the cart (added before a revoke, or before the merchant changed the audience) cannot
    // be ordered by a buyer who is not an approved wholesale member. Same 409 as a deleted product: the cart page removes it.
    const wholesaleOnlyIds = cart.items
      .filter(i => productInternalsById.get(i.productId)?.audience === 'wholesale_only')
      .map(i => i.productId);
    if (
      wholesaleOnlyIds.length > 0 &&
      !(await canSeeWholesaleOnly(storeId, requestContext?.buyer ?? ANONYMOUS_BUYER))
    ) {
      throw new AppError(
        409,
        'PRODUCT_NO_LONGER_AVAILABLE',
        'A product in your cart is no longer available. Remove it and try again.',
        { productIds: [...new Set(wholesaleOnlyIds)] }
      );
    }

    // A variant product is sold as one of its variants (C-01). Cart writes enforce it, but a
    // line written before C-01 (or merged in from an old guest cart) can still be sizeless, and
    // with backorder on it would be sold with no size the warehouse can pick. Refuse it here,
    // bilingual, naming the product, with the line ids so the cart can mark them (FU46 M-6).
    const sizelessLines = cart.items.flatMap(item => {
      const variantId = (item as { variantId?: string | null }).variantId;
      const internals = productInternalsById.get(item.productId);
      return !variantId && internals && internals._count.variants > 0
        ? [{ productId: item.productId, name: internals.name, nameAr: internals.nameAr ?? null }]
        : [];
    });
    if (sizelessLines.length > 0) {
      const first = sizelessLines[0];
      const messageEn = `Please choose a size for “${first.name}” before checking out`;
      const messageAr = `اختار المقاس لـ «${first.nameAr || first.name}» قبل ما تكمل الطلب`;
      throw new AppError(400, 'VARIANT_REQUIRED', messageEn, {
        messageEn,
        messageAr,
        productIds: sizelessLines.map(l => l.productId),
        products: sizelessLines,
      });
    }

    // A required personalisation is re-checked HERE, not only at add-to-cart:
    // a line added before the merchant made the field required (or merged in
    // from a guest cart) carries no note, and the workshop cannot make it.
    // Names + labels travel in `details` so the checkout can say which item
    // and what to write, in the shopper's language.
    const missingPersonalisation = cart.items.flatMap(item => {
      const cfg = activePersonalisation(item.product.personalisation);
      const note = item.note;
      return cfg?.required && !note
        ? [
            {
              productId: item.productId,
              name: item.product.name,
              nameAr: item.product.nameAr ?? null,
              label: cfg.label,
              labelAr: cfg.labelAr,
            },
          ]
        : [];
    });
    if (missingPersonalisation.length > 0) {
      throw new AppError(
        400,
        'PERSONALISATION_REQUIRED',
        `Personalisation is required for: ${missingPersonalisation.map(m => m.name).join(', ')}`,
        {
          productIds: missingPersonalisation.map(m => m.productId),
          products: missingPersonalisation,
        }
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
    // Resolve every loose line's unit price through the ONE resolver (Ruling B2B-9: the price becomes binding here, in the
    // request that creates the order). Fresh group read, UNCACHED entitlement (a just-made downgrade binds the next order).
    // The pricing happens moments before the money transaction opens, the same window the totals above always had.
    // `expectedTotal` (below) catches a price that moved since the shopper last saw the cart.
    // Gold-rate pricing gate (Ruling B5-17), BEFORE the resolver sees a price: every gold line must be
    // inside the store's max rate age (GOLD_RATE_STALE), its materialised price must equal the price
    // recomputed from the stored spec and the CURRENT rate (GOLD_PRICE_DRIFT), and it must equal the
    // price the shopper was shown (PRICE_CHANGED). A quote (dryRun) returns the new totals instead of
    // refusing a moved price, so the checkout can show "السعر اتحدّث".
    const goldGate = await assertGoldLinesPriceable(
      prisma as unknown as Prisma.TransactionClient,
      storeId,
      cart.items.map(item => ({
        key: item.id,
        productId: item.productId,
        variantId: (item as { variantId?: string | null }).variantId ?? null,
        materialisedUnitPrice: item.variant?.price ?? item.product.price,
        quotedUnitPrice: (item as { quotedUnitPrice?: number | null }).quotedUnitPrice ?? null,
      })),
      { requireQuote: requestContext?.dryRun !== true }
    );
    const resolver = await PriceResolver.forBuyer(
      storeId,
      requestContext?.buyer ?? ANONYMOUS_BUYER,
      {
        uncachedEntitlement: wholesaleEntitledUncached,
      }
    );
    const linePrices = await resolver.priceCart(
      cart.items.map(item => ({
        key: item.id,
        product: {
          id: item.productId,
          price: item.product.price,
          moq: productInternalsById.get(item.productId)?.moq ?? null,
        },
        variant: item.variant
          ? { id: (item as { variantId: string }).variantId, price: item.variant.price }
          : null,
        qty: item.quantity,
      }))
    );
    const lineUnit = (item: { id: string }) => linePrices.get(item.id)!;
    const productQtyTotals = new Map<string, number>();
    for (const item of cart.items) {
      productQtyTotals.set(
        item.productId,
        (productQtyTotals.get(item.productId) ?? 0) + item.quantity
      );
    }
    // Review Focus 7: below MOQ an order is refused (inside the request, before any stock moves), all offenders listed.
    assertMoqSatisfied(
      cart.items.map(item => ({
        productId: item.productId,
        name: item.product.name,
        nameAr: item.product.nameAr ?? null,
        current: productQtyTotals.get(item.productId) ?? item.quantity,
        resolved: lineUnit(item),
      }))
    );
    const groupPriceApplied = cart.items.some(item => lineUnit(item).groupApplied);

    // The LOOSE-items-only subtotal — every cart line that is not part of a
    // bundle. Coupons and promotions are evaluated against the BASE-PRICED loose lines only: a line priced by a tier or a
    // group price is excluded (Ruling B2B-5) and a coupon never discounts a bundle (Ruling B1). Both bases equal the plain
    // loose subtotal for every store without tiers/groups/bundles, so those stores are unaffected.
    const looseSubtotal = cart.items.reduce(
      (sum, item) => sum + lineUnit(item).unitMinor * item.quantity,
      0
    );
    const couponBasisSubtotal = cart.items.reduce(
      (sum, item) =>
        eligibleForCoupon(lineUnit(item)) ? sum + lineUnit(item).unitMinor * item.quantity : sum,
      0
    );
    const subtotal = looseSubtotal + bundlesSubtotal;

    // Build the targeting cart snapshot (product + category ids, per-line
    // totals) shared by coupon targeting and automatic promotion resolution.
    // Only coupon-eligible (base-priced) lines are in it, priced exactly as charged.
    // `looseCartItems` keeps EVERY loose line: a free-shipping coupon judges its minimum, quantity and scope on the whole
    // loose cart, because shipping is not a price discount (Ruling B2B-M2, final review P2-3).
    const looseCartItems = cart.items.map(item => ({
      productId: item.productId,
      categoryIds: (productInternalsById.get(item.productId)?.categories ?? []).map(
        c => c.categoryId
      ),
      quantity: item.quantity,
      lineTotal: lineUnit(item).unitMinor * item.quantity,
      eligible: eligibleForCoupon(lineUnit(item)),
    }));
    const cartItems = looseCartItems
      .filter(item => item.eligible)
      .map(({ eligible: _eligible, ...item }) => item);

    // Per-store, opt-in minimum order value (Store.settings.minimumOrderFils,
    // piastres; 0/unset = no minimum). Platform-level — any store can configure
    // it, never a hardcoded slug. This is the REAL guard for the customer
    // checkout path; the storefront cart/checkout mirror it for UX only.
    // Deliberately NOT applied to OrderService.createAdminOrder — merchants
    // must be able to override the minimum for phone/manual orders.
    const storeForMinOrder = await readStoreSettings(storeId);
    // Ruling SHARIA-GOLD-1: a gold order is prepaid online unless the merchant allowed COD / installments.
    // The check runs here, in the request that creates the order, whatever the checkout showed.
    assertGoldPaymentAllowed({
      hasGold: goldGate.snapshots.size > 0,
      storeSettings: storeForMinOrder?.settings,
      provider: data.paymentMethod,
    });
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

    // Ruling B4-7: a store with `checkoutDelivery.daysAhead` takes a delivery DATE; the offered set is
    // recomputed here from the live store row and the cart's longest lead time, a pick outside it is
    // 422 DELIVERY_SLOT_UNAVAILABLE, and this is the only writer of the note's delivery line.
    // A quote (dryRun) never refuses on it.
    const deliveryNoteLine = requestContext?.dryRun
      ? null
      : resolveOrderDeliveryNote({
          settings: storeForMinOrder?.settings as Record<string, unknown> | null | undefined,
          timeZone: storeForMinOrder?.timezone,
          now: new Date(),
          maxLeadTimeDays: Math.max(0, ...productInternals.map(p => p.leadTimeDays ?? 0)),
          deliveryDate: data.deliveryDate,
          deliveryWindowId: data.deliveryWindowId,
          locale: data.locale,
          enforce: (data.source ?? 'web') === 'web',
        });
    const orderNotes = deliveryNoteLine
      ? data.notes
        ? `${deliveryNoteLine}\n${data.notes}`
        : deliveryNoteLine
      : data.notes;

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
    // Group membership for promotions and coupons comes from the SAME identity as the price (the session), never from the
    // typed phone / email (Ruling B2B-2c/2e): a guest gets no group benefits.
    const custCtx = await resolveCustomerContext(
      storeId,
      { phone: idPhone, email: idEmail, customerId: customerId ?? null },
      requestContext?.buyer ?? ANONYMOUS_BUYER
    );
    const targetingCtx = { ...custCtx, cartItems };

    let appliedCoupon: Awaited<ReturnType<typeof CouponService.getByCode>> | null = null;
    let couponDiscount = 0;
    if (data.couponCode) {
      try {
        appliedCoupon = await CouponService.getByCode(storeId, data.couponCode);
      } catch (err) {
        // Public path (quote + checkout): collapse not-found / inactive / not-started / expired / exhausted into
        // ONE generic answer, exactly as POST /coupons/validate does, so these endpoints are not a
        // coupon-existence oracle. Anything that is not an AppError (DB outage) still propagates.
        if (err instanceof AppError) {
          throw new AppError(400, 'INVALID_COUPON', 'Coupon code is not valid');
        }
        throw err;
      }
      // Gate on the LOOSE subtotal, not the bundle-inclusive one. A coupon
      // discounts only loose lines (Ruling B1), so measuring its minimum
      // against a total that INCLUDES bundles let a bundle-only cart pass
      // the minimum and then receive a zero discount from the very coupon it
      // had just "qualified" for. `looseSubtotal === subtotal` whenever the
      // cart holds no bundle, so this is the identity for every store
      // without the `bundles` feature.
      // Ruling B2B-M2 (final review P2-3): a free-shipping code acts on the shipping line, not the discount basis, so its
      // minimum, quantity and scope are judged on the whole loose cart, tier / group lines included. Every other coupon
      // type keeps the base-priced basis (B2B-5).
      const freeShipping = appliedCoupon.type === 'free_shipping';
      const couponMinBasis = freeShipping ? looseSubtotal : couponBasisSubtotal;
      if (appliedCoupon.minOrderAmount && couponMinBasis < appliedCoupon.minOrderAmount) {
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
      const evalResult = CouponService.evaluateForCart(
        appliedCoupon,
        freeShipping
          ? { ...targetingCtx, cartItems: looseCartItems.map(({ eligible: _e, ...item }) => item) }
          : targetingCtx
      );
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
        // Ruling B2B-M3: points are not redeemable against tier / group priced lines (same exclusion as coupons).
        const redeemableSubtotal = loyaltyRedeemableSubtotal({
          subtotal,
          nonBaseSubtotal: looseSubtotal - couponBasisSubtotal,
          primaryDiscount,
        });
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

    if (requestContext?.dryRun) {
      const quote: OrderQuote = {
        subtotal,
        discount,
        shipping,
        codFee,
        tax,
        total,
        taxIncludedInPrice: activeTax.includedInPrice,
        lines: cart.items.map(item => ({
          itemId: item.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: lineUnit(item).unitMinor,
          lineTotal: lineUnit(item).unitMinor * item.quantity,
          listPrice: lineUnit(item).listMinor,
          priceSource: lineUnit(item).source,
          priceTierMinQty: lineUnit(item).tierMinQty,
        })),
      };
      return quote as never;
    }

    // Ruling B2B-9: the shopper's `expectedTotal` is a QUOTE they saw, used ONLY to compare, never to charge. If the
    // server-resolved total differs (a tier edit, a revoked approval, a downgrade, a changed price since the cart was read),
    // refuse with the new lines so the checkout can re-render and the buyer can confirm. Absent = no comparison (older clients).
    if (typeof data.expectedTotal === 'number' && data.expectedTotal !== total) {
      throw new AppError(
        409,
        'PRICE_CHANGED',
        'Prices changed since you last saw your cart. Review the new total and confirm.',
        {
          expectedTotal: data.expectedTotal,
          total,
          lines: cart.items.map(item => ({
            itemId: item.id,
            productId: item.productId,
            unitPrice: lineUnit(item).unitMinor,
            lineTotal: lineUnit(item).unitMinor * item.quantity,
            priceSource: lineUnit(item).source,
            tierMinQty: lineUnit(item).tierMinQty,
          })),
        }
      );
    }

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
    let order: NonNullable<Awaited<ReturnType<typeof OrderService.loadCreatedOrder>>>;
    try {
      order = await withMoneyTx(prisma, async (moneyTx: Prisma.TransactionClient) =>
        // `scopeTransaction` sets the store on this transaction's own connection AND makes it
        // the ambient tenant transaction, so the code-level tenant guard (R-EBDA-003) and the
        // `prisma` proxy both see the store.
        scopeTransaction(moneyTx, { storeId }, async (tx: Prisma.TransactionClient) => {
          // Ruling B5-17: the gold rates this order was priced from must still be the current ones. Read
          // FOR SHARE, so a rate write in flight is waited for and a committed one is seen: PRICE_CHANGED,
          // never an order at the old rate.
          await assertSameRates(tx, storeId, goldGate);
          // CLAIM THE CART (audit M-012): take the cart row lock, then re-read what is in it under the lock. The cart was read
          // before this transaction; a concurrent submit of the same cart (double tap, timeout retry) would otherwise pass every
          // check below on its own stale copy and create a second order. The loser blocks here until the winner commits, then
          // finds the cart emptied (or the winner's order for its key) and rolls back before it touches stock or the wallet.
          await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cart.id} AND store_id = ${storeId} FOR UPDATE`;
          if (idemHash) {
            const winner = await tx.order.findFirst({
              where: { storeId, checkoutIdempotencyKey: idemHash },
              select: { id: true, checkoutRequestHash: true },
            });
            if (winner) {
              if (winner.checkoutRequestHash && winner.checkoutRequestHash !== reqHash)
                throw IDEMPOTENCY_CONFLICT();
              throw new CheckoutReplay(winner.id);
            }
          }
          // What is in the cart NOW must be exactly what was priced: compare the lines (id, product, variant, quantity), not
          // their number - a tab that swapped A for B, or changed A x1 to A x5, keeps the count but not the order.
          const [liveItems, liveBundles] = await Promise.all([
            tx.cartItem.findMany({
              where: { cartId: cart.id },
              select: { id: true, productId: true, variantId: true, quantity: true },
            }),
            tx.cartBundle.findMany({
              where: { cartId: cart.id },
              select: { id: true, bundleId: true, quantity: true },
            }),
          ]);
          const itemSig = (r: {
            id: string;
            productId: string;
            variantId?: string | null;
            quantity: number;
          }) => `${r.id}|${r.productId}|${r.variantId ?? ''}|${r.quantity}`;
          const bundleSig = (r: { id: string; bundleId: string; quantity: number }) =>
            `${r.id}|${r.bundleId}|${r.quantity}`;
          const same = (a: string[], b: string[]) =>
            a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
          if (
            !same(liveItems.map(itemSig), cart.items.map(itemSig)) ||
            !same(liveBundles.map(bundleSig), cartBundles.map(bundleSig))
          )
            throw new AppError(
              409,
              'CART_CHANGED',
              'The cart changed or was already checked out. Review it and try again.'
            );
          // Admission and stock reservation share one transaction. Full-wallet
          // orders are already paid; a failed wallet debit below rolls back all work.
          const manualHoldAdmitted =
            !paidInFullByWallet && HOLD_CAPPED_PAYMENT_METHODS.has(data.paymentMethod);
          // Ruling S4-1: every unpaid hold is counted, whatever label the client
          // sent — gateway/unknown labels against the looser cap. Only
          // `manualHoldAdmitted` (the tight-cap methods) unlocks COD/InstaPay later.
          if (!paidInFullByWallet) {
            await assertStockHoldCapNotExceeded(
              tx,
              storeId,
              data.paymentMethod,
              {
                phone: data.shippingAddress.phone,
                email:
                  typeof data.shippingAddress.email === 'string'
                    ? data.shippingAddress.email
                    : null,
                ip: requestContext?.checkoutIp ?? null,
              },
              resolveStoreHoldCaps(storeForMinOrder?.settings)
            );
          }
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
              // A variant inherits the product's flag: the shared rule
              // (`lineAllowsBackorder`, X-02 fix round), the same one the cart and
              // the storefront's pre-order label use.
              const productFlags = await tx.product.findUnique({
                where: { id: productId, storeId },
                select: { allowBackorder: true },
              });
              const variantFlags = variantId
                ? await tx.productVariant.findUnique({
                    where: { id: variantId },
                    select: { allowBackorder: true },
                  })
                : null;
              if (
                !productFlags ||
                !lineAllowsBackorder(productFlags, variantFlags, backorderFeatureEnabled)
              ) {
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
          // NEITHER an email nor a phone on the shipping address has no stable identity: such a guest is REFUSED the
          // coupon (COUPON_NEEDS_CONTACT, 2026-10-25; it used to be waved through, which made the coupon unlimited).
          if (
            appliedCoupon &&
            couponApplied &&
            appliedCoupon.usageLimitPerUser &&
            appliedCoupon.usageLimitPerUser > 0
          ) {
            // Guests are identified by E.164 phone / lowercased email, counted under an advisory lock in this same
            // transaction (lib/coupon-per-customer-limit.ts); an unidentifiable guest is refused, not waved through.
            const priorUsageCount = await countPriorCouponUses(
              tx as unknown as CouponLimitTx,
              storeId,
              appliedCoupon.code,
              {
                customerId,
                email:
                  typeof data.shippingAddress.email === 'string'
                    ? data.shippingAddress.email
                    : null,
                phone:
                  typeof data.shippingAddress.phone === 'string'
                    ? data.shippingAddress.phone
                    : null,
              }
            );
            if (priorUsageCount >= appliedCoupon.usageLimitPerUser) {
              throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
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
                ...(appliedCoupon.usageLimit
                  ? { usageCount: { lt: appliedCoupon.usageLimit } }
                  : {}),
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
              checkoutIdempotencyKey: idemHash,
              checkoutRequestHash: idemHash ? reqHash : null,
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
              // Name of the group whose price applied, snapshotted so a renamed / deleted group never rewrites history.
              priceGroupName: groupPriceApplied ? resolver.groupName : null,
              loyaltyPointsRedeemed: loyaltyPointsRedeemed > 0 ? loyaltyPointsRedeemed : null,
              loyaltyDiscount,
              total,
              locale: data.locale ?? null,
              smsOptIn: data.smsOptIn ?? false,
              source: data.source ?? 'web',
              // Stock-hold cap signal (lib/stock-hold-cap.ts) — never read for
              // anything else. NULL when the caller passed none.
              checkoutIp: requestContext?.checkoutIp ?? null,
              manualHoldAdmitted,
              shippingAddress: data.shippingAddress,
              billingAddress: data.billingAddress || data.shippingAddress,
              notes: orderNotes,
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
                    // Snapshot the chosen variant's title in BOTH languages (Ruling
                    // B0-41): `variantName` stays the canonical title every fiscal
                    // document, CSV export and pre-B0 reader expects; `variantNameAr`
                    // is what the Arabic storefront and admin render (falling back
                    // to `variantName`). Storefront orders never wrote it before, so
                    // admin/invoice/email showed no size or colour for a variant
                    // line; createAdminOrder already did.
                    variantName: item.variant?.title ?? null,
                    variantNameAr: item.variant?.titleAr || null,
                    // The customer's personalisation text (cart line note).
                    personalisation: item.note ?? null,
                    sku: item.product.sku,
                    quantity: item.quantity,
                    // Charge the chosen variant's price (fall back to the parent
                    // product for variant-less products). Persisting product.price
                    // here undercharged every variant at the parent (lowest) price.
                    price: lineUnit(item).unitMinor,
                    // How a gold line's price was made (Ruling B5-17): refunds read `price`, this is for display and audit.
                    ...(goldGate.snapshots.has(item.id)
                      ? { goldSnapshot: goldGate.snapshots.get(item.id) as Prisma.InputJsonValue }
                      : {}),
                    // Price provenance snapshot (Ruling B2B-3b): invoices, returns and analytics read these and never
                    // re-resolve a price. A pre-B2B order has NULLs, which read as 'base'.
                    ...priceSnapshot(lineUnit(item)),
                    // Snapshot cost-of-goods at sale time so profit reports
                    // stay correct even if the product's cost changes later.
                    // A variant line takes the variant's own cost, falling back
                    // to the parent product's (same rule as account.service's
                    // inventory valuation and lib/order-line-cost.ts).
                    costPrice: lineUnitCost(
                      productInternalsById.get(item.productId),
                      (item as { variantId?: string | null }).variantId
                    ),
                    total: lineUnit(item).unitMinor * item.quantity,
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
          const clearedItems = await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
          const clearedBundles = await tx.cartBundle.deleteMany({ where: { cartId: cart.id } });
          // belt and braces behind the row lock: what we delete must be exactly what we ordered, else roll the whole order back
          if (
            clearedItems.count !== cart.items.length ||
            clearedBundles.count !== cartBundles.length
          )
            throw new AppError(409, 'CART_CHANGED', 'The cart changed during checkout. Try again.');

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
                  // a guest cart (no customer) matches only its own row: `customerId: null` would match EVERY guest's
                  ...(cart.customerId
                    ? [{ customerId: cart.customerId, status: { not: 'recovered' } }]
                    : []),
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
              // CI-13: after COMMIT, so the planner sees the recovered row and the order.
              await sendCartRecoveredToCi(storeId, abandonedCart.id, newOrder.id);
            }
          } catch (err) {
            logger.error({ err }, 'Abandoned cart recovery detection failed');
            // Never fail order creation
          }

          return newOrder;
        })
      );
    } catch (err) {
      // the loser of a concurrent same-key request (or a unique-violation race on the key): return the winner's order
      const winnerId =
        err instanceof CheckoutReplay
          ? err.orderId
          : idemHash && (err as { code?: string })?.code === 'P2002'
            ? ((await OrderService.findCheckoutReplay(storeId, idemHash, reqHash))?.id ?? null)
            : null;
      if (winnerId) {
        const replay = await OrderService.loadCreatedOrder(storeId, winnerId);
        if (replay) return replay;
      }
      throw err;
    }

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
   * `create` for a store on its Durable Object (Ruling CF-ORDERS-1). The engine prices the lines from the DO's own rows (the
   * cart is only read for WHAT is being ordered), reserves stock, checks the hold cap and the coupon limit, redeems loyalty
   * points, debits the wallet and writes the order in one `moneyOp`. The cart and the post-commit effects stay here.
   * Residuals (documented in docs/cf/orders-on-do.md): the cart claim is not atomic with the order (carts have not moved),
   * and delivery slots, personalisation notes, affiliate attribution at order time and the fiscal sale document are not
   * written by the engine (Ruling DO-MONEY-2).
   */
  private static async createOnDo(
    money: MoneyClient,
    c: {
      storeId: string;
      customerId: string | undefined;
      data: CreateOrderData;
      cart: {
        id: string;
        items: Array<{
          id: string;
          productId: string;
          quantity: number;
          variantId?: string | null;
          quotedUnitPrice?: number | null;
          note?: string | null;
          product: { personalisation?: unknown };
        }>;
        bundles: Array<{ id?: string; bundleId: string; quantity: number }>;
      };
      referralCode?: string;
      requestContext?: {
        checkoutIp?: string | null;
        idempotencyKey?: string | null;
        buyer?: BuyerIdentity;
        dryRun?: boolean;
      };
    }
  ) {
    const { storeId, customerId, data } = c;
    const isQuote = c.requestContext?.dryRun === true;
    const missingPersonalisation = c.cart.items.filter(
      i => activePersonalisation(i.product.personalisation as never)?.required
    );
    if (missingPersonalisation.length > 0)
      throw new AppError(
        400,
        'PERSONALISATION_REQUIRED',
        'Personalisation is required for: ' +
          missingPersonalisation.map(i => i.productId).join(', '),
        { productIds: missingPersonalisation.map(i => i.productId) }
      );
    // Ruling FP-2: the customer's Postgres loyalty history is in the DO ledger before the DO order operation redeems from it.
    if (customerId && (data.pointsToRedeem ?? 0) > 0)
      await LoyaltyService.ensureDoHistory(storeId, customerId);
    const [loyaltyOn, backorderOn, wholesale, walletOk] = await Promise.all([
      featureService.isFeatureEnabled(storeId, 'loyalty'),
      featureService.isFeatureEnabled(storeId, 'inventory.backorder'),
      wholesaleEntitledUncached(storeId),
      customerId && data.useWallet === true
        ? WalletService.getCheckoutAvailability(storeId).then(a => a.available)
        : Promise.resolve(false),
    ]);
    let walletAmount = 0;
    if (customerId && walletOk) {
      const w = await (
        await storeDb(storeId)
      ).customerWallet.findFirst({
        where: { storeId, customerId },
        select: { balance: true },
      });
      walletAmount = w?.balance ?? 0; // the engine caps it to the order total
    }
    // Ruling B4-7 (CF-FINAL-1): the delivery date is validated against the live store row and the cart's longest lead time
    // (read from the DO's own products) and written as the first line of the order notes, exactly like the Postgres path.
    // A quote never refuses on it.
    let orderNotes: string | undefined = data.notes;
    // ONE primary-key read of the store row, shared by the delivery note and the per-store hold caps (QA-HOLDS-1).
    // From the store's own backend (a Durable Object store's record is its DO, NEON-ZERO-1 N-4); same row, same select.
    const storeRow = await readStoreSettings(storeId);
    if (!isQuote) {
      const leads = await (
        await storeDb(storeId)
      ).product.findMany({
        where: { id: { in: c.cart.items.map(i => i.productId) }, storeId },
        select: { leadTimeDays: true },
      });
      const deliveryNoteLine = resolveOrderDeliveryNote({
        settings: storeRow?.settings as Record<string, unknown> | null | undefined,
        timeZone: storeRow?.timezone,
        now: new Date(),
        maxLeadTimeDays: Math.max(0, ...leads.map(p => p.leadTimeDays ?? 0)),
        deliveryDate: data.deliveryDate,
        deliveryWindowId: data.deliveryWindowId,
        locale: data.locale,
        enforce: (data.source ?? 'web') === 'web',
      });
      if (deliveryNoteLine)
        orderNotes = data.notes ? `${deliveryNoteLine}\n${data.notes}` : deliveryNoteLine;
    }
    const orderArgs: CreateOrderArgs = {
      // the cart rows live on this DO: the engine claims them in the SAME section as the order (compared by content, deleted
      // there), so a double submit of one cart is CART_CHANGED 409 and never a second order (Ruling CF-R2-1, closes CF-ORDERS-CART-1)
      cart: { id: c.cart.id },
      lines: c.cart.items.map(i => ({
        productId: i.productId,
        quantity: i.quantity,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        quotedUnitPrice: i.quotedUnitPrice ?? null,
        ...(i.note ? { note: i.note } : {}),
      })),
      bundles: c.cart.bundles.map(b => ({ bundleId: b.bundleId, quantity: b.quantity })),
      buyer: c.requestContext?.buyer,
      customerId,
      couponCode: data.couponCode,
      walletAmount,
      pointsToRedeem: customerId ? data.pointsToRedeem : undefined,
      paymentMethod: data.paymentMethod,
      idempotencyKey: c.requestContext?.idempotencyKey
        ? (checkoutIdempotencyHash(c.cart.id, c.requestContext.idempotencyKey) ?? undefined)
        : undefined,
      shippingAddress: data.shippingAddress,
      billingAddress: data.billingAddress,
      checkoutIp: c.requestContext?.checkoutIp ?? undefined,
      // QA-HOLDS-1: env defaults, overridable per store (Store.settings.stockHoldCaps, bounded)
      holdCaps: resolveStoreHoldCaps(storeRow?.settings),
      wholesaleEntitled: wholesale,
      loyaltyFeatureEnabled: loyaltyOn,
      backorderEnabled: backorderOn,
      goldRequireQuote: c.requestContext?.dryRun !== true,
      expectedTotal: data.expectedTotal,
      orderNotes,
      locale: data.locale,
      smsOptIn: data.smsOptIn === true,
      source: data.source ?? 'web',
    };
    if (isQuote) {
      const q = await OrderService.translateDoRefusal(() => money.quoteOrder(orderArgs));
      return {
        subtotal: q.subtotal,
        discount: q.discount,
        shipping: q.shipping,
        codFee: q.codFee,
        tax: q.tax,
        total: q.total,
        taxIncludedInPrice: q.taxIncludedInPrice,
        lines: q.lines.map(({ index, ...priced }) => ({
          itemId: c.cart.items[index].id,
          ...priced,
        })),
      } as never;
    }
    const placed = await OrderService.translateDoRefusal(() => money.createOrder(orderArgs));
    // the engine consumed the cart (its rows were deleted in the order's section)
    if (!placed.replayed) {
      if (c.referralCode)
        await affiliateService
          .linkOrderToReferral(storeId, placed.orderId, c.referralCode)
          .catch(err => logger.error({ err }, 'Affiliate referral link failed'));
      if (data.paymentMethod === 'cod' || placed.paymentStatus === 'paid') {
        inngest
          .send({
            name: 'order/created',
            data: {
              orderId: placed.orderId,
              storeId,
              paymentMethod: placed.paymentStatus === 'paid' ? 'wallet' : data.paymentMethod,
              locale: data.locale ?? undefined,
            },
          })
          .catch((err: unknown) =>
            logger.error({ err, orderId: placed.orderId }, 'Failed to enqueue order/created')
          );
        try {
          socketService.newOrderNotification(storeId, {
            orderId: placed.orderId,
            orderNumber: placed.orderNumber,
            total: placed.total,
            customerName:
              `${data.shippingAddress.firstName ?? ''} ${data.shippingAddress.lastName ?? ''}`.trim() ||
              'Customer',
          });
        } catch (notifyError) {
          logger.error({ err: notifyError }, 'Failed to send order notification');
        }
      }
      const consentPhone = data.shippingAddress?.phone;
      if (data.smsOptIn === true && typeof consentPhone === 'string' && consentPhone.trim()) {
        const customerKey = customerKeyOf({ customerId, shippingAddress: data.shippingAddress });
        if (customerKey) {
          await withSavepoint(() =>
            SmsConsentService.recordGrant(storeId, {
              customerKey,
              userId: customerId ?? null,
              phone: consentPhone,
              source: 'checkout',
            })
          ).catch(err =>
            logger.error({ err, orderId: placed.orderId }, '[Order] SMS consent write failed')
          );
        }
      }
      await bustProductCaches(storeId);
      void deferAfterTenantCommit('plan.noteOrderCreated', () => noteOrderCreated(storeId));
    }
    const order = await (
      await storeDb(storeId)
    ).order.findFirst({
      where: { id: placed.orderId, storeId },
      include: { items: true },
    });
    return { ...order, customer: null } as unknown as NonNullable<
      Awaited<ReturnType<typeof OrderService.loadCreatedOrder>>
    >;
  }

  /**
   * `rollbackForPaymentFailure` for a store on its Durable Object (Ruling CF-R2-1): the cancel (stock, coupon, wallet, the
   * order's status and note, and the unissued-money fiscal cancellation) is ONE `cancel` section; the cart the shopper finds
   * waiting is then rebuilt on the DO from the order's lines. Same guards as the Postgres path: an order that is not `pending`,
   * is cancelled, or already has a payment is left alone.
   */
  private static async rollbackOnDo(
    money: MoneyClient,
    storeId: string,
    orderId: string,
    sessionId: string
  ): Promise<void> {
    const repo = await storeRepo(storeId);
    const order = await repo.db.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: true, payments: true },
    });
    if (!order) return;
    if (order.status === 'cancelled') return;
    if (order.payments.length > 0) return;
    if (order.status !== 'pending') return;

    await money.cancel({
      orderId,
      restoreInventory: true,
      note: '[auto-cancelled: payment step failed before completion]',
    });

    const cart =
      (await repo.db.cart.findFirst({ where: { storeId, sessionId } })) ??
      (await repo.writer.cart.create({
        data: { storeId, sessionId, customerId: order.customerId },
      }));
    await repo.writer.cartItem.deleteMany({ where: { cartId: cart.id } });
    await repo.writer.cartBundle.deleteMany({ where: { cartId: cart.id } });
    const candidateBundleIds = [
      ...new Set(order.items.map(i => i.bundleId).filter((id): id is string => !!id)),
    ];
    const liveBundleIds = new Set(
      candidateBundleIds.length > 0
        ? (
            await repo.db.bundle.findMany({
              where: { id: { in: candidateBundleIds }, storeId },
              select: { id: true },
            })
          ).map(b => b.id)
        : []
    );
    const restored = restoreCartShape(order.items, liveBundleIds);
    for (const item of restored.items)
      await repo.writer.cartItem.create({ data: { cartId: cart.id, ...item } });
    for (const bundle of restored.bundles)
      await repo.writer.cartBundle.create({ data: { cartId: cart.id, ...bundle } });

    logger.info(
      { orderId, storeId },
      'Order rolled back after payment-create failure (inventory + cart restored)'
    );
    await bustProductCaches(storeId);
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
    const money = await storeMoney(storeId);
    if (money) return OrderService.rollbackOnDo(money, storeId, orderId, sessionId);
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
    opts: {
      restoreInventory?: boolean;
      unpaidOnly?: boolean;
      /** Cancel only from these states, decided atomically on a DO store (Fixes #614); see MoneyClient.cancel. */
      onlyFrom?: string[];
      exceptionNote?: string;
    } = {}
  ) {
    // Cancel on a store's Durable Object (Ruling CF-ORDERS-1): the status flip AND the whole reversal (stock, coupon, loyalty,
    // wallet, backorders) are one section there. The state machine is checked on the DO's own status first.
    if (status === 'cancelled') {
      const money = await storeMoney(storeId);
      if (money) return OrderService.cancelOnDo(money, storeId, orderId, opts);
      // Postgres store: the caller holds the row lock (lib/wa/store-events-consumer.ts), so this read is current.
      if (opts.onlyFrom) {
        const cur = await (
          await storeDb(storeId)
        ).order.findFirst({
          where: { id: orderId, storeId },
          select: { status: true },
        });
        if (cur && !opts.onlyFrom.includes(cur.status))
          throw new AppError(
            409,
            'ORDER_STATUS_MOVED',
            `The order is already ${cur.status}; it was not cancelled`
          );
      }
    }
    // Refund by status (Ruling CF-PAY-1) and every other status (Ruling CF-FINAL-1) on a Durable Object store.
    {
      const money = await storeMoney(storeId);
      if (money) {
        if (status === 'refunded') return OrderService.refundOnDo(money, storeId, orderId);
        return OrderService.advanceOnDo(
          money,
          storeId,
          orderId,
          status as Exclude<typeof status, 'cancelled'>
        );
      }
    }
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
      // Existing event kept: 7-day review-request job.
      inngest
        .send({ name: 'order/delivered', data: { orderId, storeId } })
        .catch((err: unknown) =>
          logger.error({ err, orderId }, 'Failed to enqueue order/delivered event')
        );
    }
    inngest
      .send({
        name: 'order/status-changed',
        data: {
          orderId,
          storeId,
          status,
          hadCapturedPayment,
          // When THIS transition was requested (ordering key for downstream consumers).
          requestedAt: (statusData.statusFanoutRequestedAt as Date).toISOString(),
        },
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

  /** The DO engine's refusals under the codes (and statuses) the Postgres path throws, so a client sees one contract. */
  private static async translateDoRefusal<T>(run: () => Promise<T>): Promise<T> {
    const MAP: Record<string, [number, string]> = {
      OUT_OF_STOCK: [400, 'INSUFFICIENT_INVENTORY'],
      COUPON_EXHAUSTED: [400, 'INVALID_COUPON'],
      COUPON_USER_LIMIT: [400, 'COUPON_LIMIT_REACHED'],
      COUPON_INVALID: [400, 'INVALID_COUPON'],
      PRODUCT_UNAVAILABLE: [409, 'PRODUCT_NO_LONGER_AVAILABLE'],
      GOLD_PRICE_DRIFT: [409, 'PRICE_CHANGED'],
      COUPON_EXPIRED: [400, 'INVALID_COUPON'],
      INSUFFICIENT_WALLET: [409, 'INSUFFICIENT_WALLET_BALANCE'],
      TOO_MANY_OPEN_ORDERS: [429, 'TOO_MANY_OPEN_HOLDS'],
    };
    try {
      return await run();
    } catch (err) {
      const hit = err instanceof AppError ? MAP[err.code] : undefined;
      if (err instanceof AppError && hit) throw new AppError(hit[0], hit[1], err.message);
      throw err;
    }
  }

  private static async refundOnDo(money: MoneyClient, storeId: string, orderId: string) {
    const db = await storeDb(storeId);
    const before = await db.order.findFirst({
      where: { id: orderId, storeId },
      select: {
        status: true,
        paymentStatus: true,
        customerId: true,
        orderNumber: true,
        payments: { select: { status: true } },
      },
    });
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    assertValidTransition(before.status, 'refunded');
    if (
      (before.status === 'pending' || before.status === 'cancelled') &&
      !hasCapturedPayment(before)
    )
      throw new AppError(
        400,
        'ORDER_NOT_PAID',
        'This order has no captured payment, so it cannot be marked refunded'
      );
    const requestedAt = new Date();
    const r = await money.refundBook({ orderId, keepPaymentStatus: true });
    if (!r.replayed) {
      const hadCapturedPayment = hasCapturedPayment(before);
      await OrderService.applyRefundEffects(storeId, orderId, {
        fireRefundNotification: shouldApplyRefundEffects('refunded', before),
      });
      await invalidateCustomersCache(storeId).catch(err =>
        logger.warn({ err, storeId, orderId }, '[order.updateStatus] cache invalidation failed')
      );
      inngest
        .send({
          name: 'order/status-changed',
          data: {
            orderId,
            storeId,
            status: 'refunded',
            hadCapturedPayment,
            requestedAt: requestedAt.toISOString(),
          },
        })
        .catch((err: unknown) =>
          logger.error({ err, orderId }, 'Failed to enqueue order/status-changed for a DO refund')
        );
    }
    return (await db.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: true },
    })) as never;
  }

  /** confirmed / processing / shipped / delivered on a Durable Object store: one section there, then the Postgres path's tail. */
  private static async advanceOnDo(
    money: MoneyClient,
    storeId: string,
    orderId: string,
    status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered'
  ) {
    const db = await storeDb(storeId);
    const before = await db.order.findFirst({
      where: { id: orderId, storeId },
      select: {
        status: true,
        paymentStatus: true,
        payments: { select: { status: true } },
      },
    });
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const hadCapturedPayment = hasCapturedPayment(before);
    const r = await OrderService.translateDoStatus(() => money.orderStatus({ orderId, status }));
    void deferAfterTenantCommit('order.updateStatus.invalidateCustomersCache', () =>
      invalidateCustomersCache(storeId)
    ).catch(err =>
      logger.warn({ err, storeId, orderId }, '[order.updateStatus] cache invalidation failed')
    );
    if (r.codSettled) {
      // Same post-payment fan-out as "Mark paid" (journal posting); its notification half is deduped by orderCreatedNotifiedAt.
      void deferAfterTenantCommit('order.codCollectedOnDelivery', () =>
        inngest.send({
          name: 'order/created',
          data: { orderId, storeId, paymentMethod: 'cod', locale: undefined },
        })
      );
    }
    if (status === 'delivered') {
      inngest
        .send({ name: 'order/delivered', data: { orderId, storeId } })
        .catch((err: unknown) =>
          logger.error({ err, orderId }, 'Failed to enqueue order/delivered event')
        );
    }
    inngest
      .send({
        name: 'order/status-changed',
        data: {
          orderId,
          storeId,
          status,
          hadCapturedPayment,
          requestedAt: new Date(r.requestedAt).toISOString(),
        },
      })
      .catch((err: unknown) => {
        logger.error(
          { err, orderId, status },
          'Failed to enqueue order/status-changed - running fanout inline as fallback'
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
    try {
      if (r.customerId)
        socketService.orderStatusNotification(r.customerId, {
          orderNumber: r.orderNumber,
          status,
        });
    } catch (notifyError) {
      logger.error({ err: notifyError }, 'Failed to send order status notification');
    }
    const updated = await db.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: true },
    });
    // the customer lives in the directory database (a DO store has no join to it): attach it as the Postgres include does
    const customer = r.customerId
      ? await prisma.customer.findFirst({
          where: { id: r.customerId, storeId },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      : null;
    return { ...updated, customer } as never;
  }

  /** The engine's status refusals under the Postgres codes (the engine already speaks them; a missing order is the 404). */
  private static async translateDoStatus<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AppError && err.code === 'ORDER_NOT_FOUND')
        throw new AppError(404, 'NOT_FOUND', 'Order not found');
      throw err;
    }
  }

  private static async cancelOnDo(
    money: MoneyClient,
    storeId: string,
    orderId: string,
    opts: {
      restoreInventory?: boolean;
      unpaidOnly?: boolean;
      onlyFrom?: string[];
      exceptionNote?: string;
    }
  ) {
    const db = await storeDb(storeId);
    const before = await db.order.findFirst({
      where: { id: orderId, storeId },
      select: {
        status: true,
        paymentStatus: true,
        orderNumber: true,
        customerId: true,
        payments: { select: { status: true } },
      },
    });
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    // an `onlyFrom` cancel is decided by the DO in its own section (the state read here may already be stale, #614)
    if (!opts.onlyFrom) assertValidTransition(before.status, 'cancelled');
    const requestedAt = new Date();
    const r = await money.cancel({
      orderId,
      restoreInventory: opts.restoreInventory !== false,
      // the auto-cancel sweep: the DO refuses (ORDER_ALREADY_PAID) when a payment landed first, in the same section
      ...(opts.unpaidOnly ? { unpaidOnly: true } : {}),
      ...(opts.onlyFrom ? { onlyFrom: opts.onlyFrom, exceptionNote: opts.exceptionNote } : {}),
    });
    if (r.skipped === 'status_moved')
      throw new AppError(
        409,
        'ORDER_STATUS_MOVED',
        `The order is already ${r.status}; it was not cancelled`
      );
    if (!r.replayed) {
      // the same tail as the Postgres path: refund fanout, the status fanout, the customer push
      const hadCapturedPayment = hasCapturedPayment(before);
      await OrderService.applyRefundEffects(storeId, orderId, {
        fireRefundNotification: shouldApplyRefundEffects('cancelled', before),
        ...(opts.restoreInventory === false ? { restoreInventory: false } : {}),
      });
      void deferAfterTenantCommit('order.updateStatus.invalidateCustomersCache', () =>
        invalidateCustomersCache(storeId)
      ).catch(err =>
        logger.warn({ err, storeId, orderId }, '[order.updateStatus] cache invalidation failed')
      );
      inngest
        .send({
          name: 'order/status-changed',
          data: {
            orderId,
            storeId,
            status: 'cancelled',
            hadCapturedPayment,
            requestedAt: requestedAt.toISOString(),
          },
        })
        .catch((err: unknown) => {
          logger.error(
            { err, orderId },
            'Failed to enqueue order/status-changed - running fanout inline as fallback'
          );
          handleOrderStatusChanged(orderId, storeId, 'cancelled', hadCapturedPayment, {
            run: <T>(_id: string, fn: () => Promise<T>): Promise<T> => fn(),
          }).catch((e: unknown) =>
            logger.error({ err: e, orderId }, 'order/status-changed inline fallback also failed')
          );
        });
      try {
        if (before.customerId)
          socketService.orderStatusNotification(before.customerId, {
            orderNumber: before.orderNumber,
            status: 'cancelled',
          });
      } catch (notifyError) {
        logger.error({ err: notifyError }, 'Failed to send order status notification');
      }
    }
    return (await db.order.findFirst({
      where: { id: orderId, storeId },
      include: { items: true },
    })) as never;
  }

  /**
   * The fiscal step of the `order/refunded` fanout (ruling MONEYB-1) for a PARTIAL refund event on a store on its Durable
   * Object: the credit note keyed on the refund (the amount is the caller's). A WHOLE-order cancel or refund issues its
   * document inside the DO's reversal section (`settleFiscalOnReversal`), so it cannot be lost between the two.
   */
  private static async fiscalOnDo(
    money: MoneyClient,
    storeId: string,
    orderId: string,
    partial?: { items: unknown[]; refundKey: string; refundAmount?: number; amountOnly?: boolean }
  ): Promise<void> {
    const isPartial = !!partial && (partial.items.length > 0 || partial.amountOnly === true);
    if (!isPartial) return;
    const amount = partial?.refundAmount;
    if (typeof amount !== 'number' || amount <= 0) return;
    const pay = await (
      await storeDb(storeId)
    ).payment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const meta = pay?.metadata as Record<string, unknown> | null | undefined;
    const reason = typeof meta?.refundReason === 'string' ? meta.refundReason : null;
    await money.fiscalRefund({ orderId, refundRef: partial!.refundKey, amount, reason });
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
    // A store on its Durable Object: the credit note / refund receipt / cancelled sale document is issued here, through the
    // DO (the `order/refunded` fanout's `fiscal-document` step reads Postgres and is refused for a DO store, Ruling CF-JOBS-1).
    // A DO store's order is not in Postgres: its existence is read from the DO, and the arming stamps below (order and
    // return) were written inside the DO section that completed the money step (Ruling CF-RETURNS-1).
    const doMoney = await storeMoney(storeId);
    // The credit note / refund receipt / cancelled sale document is issued through the DO (the fanout step reads Postgres, refused for a DO store, Ruling CF-JOBS-1).
    if (doMoney) await OrderService.fiscalOnDo(doMoney, storeId, orderId, options.partial);
    const order = doMoney
      ? await (
          await storeDb(storeId)
        ).order.findFirst({
          where: { id: orderId, storeId },
          select: { id: true, currency: true },
        })
      : await prisma.order.findFirst({
          where: { id: orderId, storeId },
          select: { id: true, currency: true },
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
    // A DO store armed both claims in the SAME section as its refund (do/refund.ts reverseWholeOrder, do/returns.ts), so
    // only a Postgres store arms them here (Ruling NZ-MONEY-6: a POSTGRES_REMOVED 500 on every DO refund to `refunded`).
    if (!doMoney && restoreInventory && !options.partial) {
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
    if (!doMoney && restoreInventory && options.partial?.refundKey) {
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
          // the order's own currency (every amount in `partial` is in its minor units); consumers destructure what they use
          currency: order.currency,
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
    // A Durable Object store records it in one DO section, bounded by the order's one refundable balance (#624): the
    // Prisma path below cannot run in the Worker (no Postgres since NZ-D23) and had no cross-channel ceiling.
    const money = await storeMoney(storeId);
    if (money) {
      await money.manualRefundRecord({
        orderId,
        method: input.method,
        reference: input.reference,
        actorUserId: input.actorId,
      });
      return;
    }
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

  /**
   * `createAdminOrder` for a store on its Durable Object (Ruling CF-R4-2). The permission rules for the two overrides (coupon
   * rules, minimum order quantity) are decided HERE from the verified session, in the Postgres order's wording; the engine
   * (`do/admin-order.ts`) then prices the lines from the DO's own rows and writes the order, its items, the override events
   * and the fiscal sale document in one section, with no stock reserved (as on Postgres). The audit rows and the monthly cap
   * note follow the commit.
   */
  private static async createAdminOrderOnDo(
    money: MoneyClient,
    storeId: string,
    adminUserId: string,
    data: Parameters<typeof OrderService.createAdminOrder>[2],
    actor: { role?: string },
    pricingOpts: { buyer?: BuyerIdentity }
  ) {
    const moqOverride = data.overrideMoq === true;
    if (moqOverride) {
      if (!actor.role || !COUPON_OVERRIDE_ROLES.includes(actor.role))
        throw new AppError(
          403,
          'MOQ_OVERRIDE_FORBIDDEN',
          'Only a store admin can override the minimum order quantity'
        );
      if (!data.moqOverrideReason?.trim())
        throw new AppError(
          400,
          'MOQ_OVERRIDE_REASON_REQUIRED',
          'A reason is required to override the minimum order quantity'
        );
    }
    const overrideCoupon = !!data.couponCode && data.overrideCouponRules === true;
    const overrideReason = data.couponOverrideReason?.trim() ?? '';
    if (overrideCoupon) {
      if (!actor.role || !COUPON_OVERRIDE_ROLES.includes(actor.role))
        throw new AppError(
          403,
          'COUPON_OVERRIDE_FORBIDDEN',
          'Only a store admin can override coupon rules'
        );
      if (!overrideReason)
        throw new AppError(
          400,
          'COUPON_OVERRIDE_REASON_REQUIRED',
          'A reason is required to override coupon rules'
        );
    }
    // the engine already refuses under the Postgres codes (no `translateDoRefusal`: it would rename COUPON_EXPIRED to INVALID_COUPON)
    const placed = await money.createAdminOrder({
      lines: data.items.map(i => ({
        productId: i.productId,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        quantity: i.quantity,
      })),
      customerId: data.customerId,
      buyer: pricingOpts.buyer ?? ANONYMOUS_BUYER,
      wholesaleEntitled: await wholesaleEntitledUncached(storeId),
      shippingAddress: data.shippingAddress,
      billingAddress: data.billingAddress,
      currency: data.currency ?? REGION.currency,
      notes: data.notes,
      couponCode: data.couponCode,
      overrideCouponRules: overrideCoupon,
      couponOverrideReason: overrideReason,
      overrideMoq: moqOverride,
      moqOverrideReason: data.moqOverrideReason?.trim(),
      shippingOverride: data.shippingOverride,
      actorId: adminUserId,
      actorRole: actor.role ?? null,
    });
    const found = await (
      await storeDb(storeId)
    ).order.findFirst({ where: { id: placed.orderId, storeId }, include: { items: true } });
    const order = (
      await attachCustomers(storeId, [found!], {
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      })
    )[0];
    await auditLog({
      action: 'order.admin_created',
      userId: adminUserId,
      resourceType: 'order',
      resourceId: placed.orderId,
      details: {
        orderNumber: placed.orderNumber,
        itemsCount: data.items.length,
        total: placed.total,
      },
    });
    if (overrideCoupon && data.couponCode)
      await auditLog({
        action: COUPON_OVERRIDE_AUDIT_ACTION,
        userId: adminUserId,
        storeId,
        resourceType: 'order',
        resourceId: placed.orderId,
        details: {
          orderNumber: placed.orderNumber,
          couponCode: order.couponCode,
          description: overrideReason,
          discount: placed.discount,
        },
      });
    if (moqOverride)
      await auditLog({
        action: 'order.moq_override',
        userId: adminUserId,
        storeId,
        resourceType: 'order',
        resourceId: placed.orderId,
        details: {
          orderNumber: placed.orderNumber,
          description: data.moqOverrideReason?.trim() ?? '',
        },
      });
    void deferAfterTenantCommit('plan.noteOrderCreated', () => noteOrderCreated(storeId));
    return order;
  }

  /**
   * Mark a COD order as paid (the merchant collected the cash). Extracted from
   * POST /:orderId/mark-paid so the route and the merchant assistant share one path.
   * Throws AppError with the codes the route used to answer with.
   */
  static async markCodPaid(storeId: string, orderId: string, userId: string) {
    const db = await storeDb(storeId);
    const order = await db.order.findFirst({
      where: { id: orderId, storeId },
      include: { payments: true },
    });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    const codPayment = order.payments.find(p => p.provider === 'cod');
    if (!codPayment)
      throw new AppError(400, 'NOT_COD', 'This order is not a Cash on Delivery order');
    if (order.paymentStatus === 'paid')
      throw new AppError(400, 'ALREADY_PAID', 'Order is already marked as paid');
    // A cancelled / refunded order (incl. a returned-to-origin COD parcel) collected nothing:
    // marking it paid would book a sale that never happened (sense audit O8).
    if (order.status === 'cancelled' || order.status === 'refunded')
      throw new AppError(
        409,
        'ORDER_NOT_PAYABLE',
        'A cancelled or refunded order cannot be marked paid'
      );

    // Only advance a still-pending order to `confirmed`; COD cash is collected AT delivery, so a
    // further-along order keeps its fulfilment progress.
    const money = await storeMoney(storeId);
    let flipped = { paymentId: codPayment.id, fromStatus: codPayment.status as string };
    if (money) {
      // Durable Object store (Ruling NZ-A-2): the same writes in ONE section there.
      const done = await money.codMarkPaid({ orderIds: [orderId] });
      if (done.updated.length === 0)
        throw new AppError(409, 'ORDER_NOT_PAYABLE', 'The order can no longer be marked paid');
      flipped = { paymentId: done.updated[0].paymentId, fromStatus: done.updated[0].fromStatus };
    } else {
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: codPayment.id },
          data: { status: 'completed', paidAt: new Date() },
        }),
        prisma.order.update({
          where: { id: orderId, storeId },
          data: {
            paymentStatus: 'paid',
            ...(order.status === 'pending' ? { status: 'confirmed' } : {}),
          },
        }),
      ]);
    }

    // Append-only audit row for the COD completion.
    await (money ? recordPaymentEventForStore : recordPaymentEvent)({
      paymentId: flipped.paymentId,
      storeId: order.storeId,
      orderId,
      eventType: 'status_change',
      fromStatus: flipped.fromStatus as typeof codPayment.status,
      toStatus: 'completed',
      provider: 'cod',
      triggeredByUserId: userId,
      details: { reason: 'cod_marked_paid', orderNumber: order.orderNumber },
    });

    // Same post-payment fanout the webhook handler fires: the accounting journal relies on it.
    inngest
      .send({
        name: 'order/created',
        data: {
          orderId,
          storeId: order.storeId,
          paymentMethod: codPayment.provider,
          locale: undefined,
        },
      })
      .catch((err: unknown) =>
        logger.error({ err, orderId }, '[COD] Failed to enqueue order/created')
      );

    return { orderNumber: order.orderNumber, amount: codPayment.amount };
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

    const repo = await storeRepo(storeId);
    const [orders, total] = await Promise.all([
      repo.db.order.findMany({
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
      repo.db.order.count({ where }),
    ]);

    return {
      // Customer-facing by definition (a customer's own orders): never the merchant's cost or the gold margin (B5-23).
      orders: orders.map(redactOrderForCustomer),
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
      paymentProvider?: 'paymob' | 'kashier' | 'fawry' | 'geidea' | 'instapay' | 'cod';
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
      /**
       * Create the order below a product's minimum order quantity (B2B). Refused by default (422 BELOW_MOQ); honoured only
       * for COUPON_OVERRIDE_ROLES (store_admin / super_admin) and only with a reason; the actor and reason are written to
       * the order's event and audit log.
       */
      overrideMoq?: boolean;
      moqOverrideReason?: string;
    },
    actor: { role?: string } = {},
    /** Who the order is priced for (Ruling B2B-2d): the Customer the merchant selected; absent = retail. */
    pricingOpts: { buyer?: BuyerIdentity } = {}
  ) {
    // BE:S-23: a negotiated shipping fee replaces the computed one, so it is the owner's call (same roles as the coupon and MOQ
    // overrides); staff place the order at the computed fee. The route writes the audit row.
    if (
      typeof data.shippingOverride === 'number' &&
      (!actor.role || !COUPON_OVERRIDE_ROLES.includes(actor.role))
    )
      throw new AppError(
        403,
        'SHIPPING_OVERRIDE_FORBIDDEN',
        'Only a store admin can set a custom shipping fee on an order'
      );

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
      const doCustomer = await customerRow(storeId, data.customerId);
      const customer =
        doCustomer !== undefined
          ? doCustomer
          : await prisma.user.findFirst({
              where: { id: data.customerId, storeId, role: 'customer' },
              select: { id: true, status: true, deletedAt: true },
            });
      if (!customer) {
        throw new AppError(404, 'NOT_FOUND', 'Customer not found for this store');
      }
      // Design review M-5: the selected shopper also drives their group price, so a suspended or deleted account is refused
      // here (the price loader applies the same test) instead of silently pricing wholesale for a dead account.
      if (customer.deletedAt || customer.status !== 'active') {
        throw new AppError(
          409,
          'CUSTOMER_INACTIVE',
          'This customer account is suspended or deleted. Choose another customer or create the order as a guest.'
        );
      }
    }

    // A store on its Durable Object prices and writes the order in ONE StoreDO section (Ruling CF-R4-2); the Postgres code
    // below is untouched.
    const money = await storeMoney(storeId);
    if (money)
      return OrderService.createAdminOrderOnDo(
        money,
        storeId,
        adminUserId,
        data,
        actor,
        pricingOpts
      );

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

    const unpricedLines = data.items.map(it => {
      const product = productMap.get(it.productId);
      if (!product) {
        throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${it.productId} not found`);
      }
      let variantPrice: number | null = null;
      let variantSku: string | undefined;
      let variantTitle: string | undefined;
      let variantTitleAr: string | null = null;
      // C-01 on the merchant path: a product with variants is ordered as one
      // of them. Without this a phone order wrote a SIZELESS line the
      // warehouse cannot pick (W1a review, fix the class).
      if (!it.variantId && product.variants.length > 0) {
        throw variantRequiredError(product.id, product.name);
      }
      if (it.variantId) {
        const variant = product.variants.find(v => v.id === it.variantId);
        if (!variant) {
          throw new AppError(
            404,
            'VARIANT_NOT_FOUND',
            `Variant ${it.variantId} not found for product ${product.name}`
          );
        }
        // A disabled variant is not for sale on any path (inventory model):
        // checkout, the cart and payment links already refuse it; a manual
        // order wrote a line for it and decremented its stock (W1a re-review).
        if (variant.isActive === false) {
          throw new AppError(
            409,
            'VARIANT_INACTIVE',
            `Variant ${variant.title ?? it.variantId} of ${product.name} is disabled`,
            { productId: product.id, variantId: it.variantId, productName: product.name }
          );
        }
        variantPrice = typeof variant.price === 'number' ? variant.price : null;
        variantSku = variant.sku ?? undefined;
        variantTitle = variant.title ?? undefined;
        variantTitleAr = variant.titleAr || null;
      }
      const quantity = Math.max(1, Math.floor(it.quantity));
      return {
        productId: product.id,
        productName: product.name,
        productNameAr: product.nameAr ?? null,
        productPrice: product.price,
        productMoq: product.moq ?? null,
        variantPrice,
        sku: variantSku ?? product.sku ?? undefined,
        variantId: it.variantId,
        variantTitle,
        variantTitleAr,
        // Admin manual orders never snapshotted cost at all, so every line
        // they created had no COGS and no profit. Same rule as checkout.
        costPrice: lineUnitCost(product, it.variantId),
        quantity,
      };
    });

    // Price every line through the ONE resolver (Ruling B2B-2d): as the Customer the merchant selected, else retail + public
    // tiers. UNCACHED entitlement (review I2). The admin form submits no price, and the route's zod object strips any.
    // Ruling B5-17: the admin path runs the SAME gold gate as checkout (stale rate, price drift), with
    // no shopper quote to compare (requireQuote false). Gold lines get their snapshot below.
    const adminGoldGate = await assertGoldLinesPriceable(
      prisma as unknown as Prisma.TransactionClient,
      storeId,
      unpricedLines.map((r, i) => ({
        key: String(i),
        productId: r.productId,
        variantId: r.variantId ?? null,
        materialisedUnitPrice: r.variantPrice ?? r.productPrice,
        quotedUnitPrice: null,
      })),
      { requireQuote: false }
    );
    // Ruling SHARIA-GOLD-1: the manual-order path is held to the same prepaid-gold rule as checkout.
    if (adminGoldGate.snapshots.size > 0) {
      const adminStore = await withStore(storeId, tx =>
        tx.store.findUnique({ where: { id: storeId }, select: { settings: true } })
      );
      assertGoldPaymentAllowed({
        hasGold: true,
        storeSettings: adminStore?.settings,
        // BOTH fields: `{ paymentMethod: 'cod', paymentProvider: 'paymob' }` must not bypass the prepaid rule.
        provider: data.paymentProvider,
        method: data.paymentMethod,
      });
    }
    const adminResolver = await PriceResolver.forBuyer(
      storeId,
      pricingOpts.buyer ?? ANONYMOUS_BUYER,
      { uncachedEntitlement: wholesaleEntitledUncached }
    );
    const adminProductQty = new Map<string, number>();
    for (const r of unpricedLines) {
      adminProductQty.set(r.productId, (adminProductQty.get(r.productId) ?? 0) + r.quantity);
    }
    const adminPrices = await adminResolver.priceCart(
      unpricedLines.map((r, i) => ({
        key: String(i),
        product: { id: r.productId, price: r.productPrice, moq: r.productMoq },
        variant: r.variantId ? { id: r.variantId, price: r.variantPrice } : null,
        qty: r.quantity,
      }))
    );
    const resolved = unpricedLines.map((r, i) => {
      const pricing = adminPrices.get(String(i))!;
      return {
        ...r,
        unitPrice: pricing.unitMinor,
        lineTotal: pricing.unitMinor * r.quantity,
        pricing,
      };
    });

    // Review Focus 7: MOQ refuses an admin order too, unless store_admin / super_admin overrides it with a reason.
    const moqOverride = data.overrideMoq === true;
    const moqLines = resolved.map(r => ({
      productId: r.productId,
      name: r.productName,
      nameAr: r.productNameAr,
      current: adminProductQty.get(r.productId) ?? r.quantity,
      resolved: r.pricing,
    }));
    const belowMoqProducts = moqLines.filter(l => l.resolved.belowMoq).map(l => l.productId);
    if (moqOverride) {
      if (!actor.role || !COUPON_OVERRIDE_ROLES.includes(actor.role)) {
        throw new AppError(
          403,
          'MOQ_OVERRIDE_FORBIDDEN',
          'Only a store admin can override the minimum order quantity'
        );
      }
      if (!data.moqOverrideReason?.trim()) {
        throw new AppError(
          400,
          'MOQ_OVERRIDE_REASON_REQUIRED',
          'A reason is required to override the minimum order quantity'
        );
      }
    } else {
      assertMoqSatisfied(moqLines);
    }
    const adminGroupPriceApplied = resolved.some(r => r.pricing.groupApplied);

    const subtotal = resolved.reduce((sum, r) => sum + r.lineTotal, 0);
    // Coupons never discount a tier / group priced line (Ruling B2B-5).
    const couponBasisSubtotal = resolved.reduce(
      (sum, r) => (eligibleForCoupon(r.pricing) ? sum + r.lineTotal : sum),
      0
    );

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
      appliedCoupon = await (
        await storeDb(storeId)
      ).coupon.findFirst({
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
      // Group membership: the Customer the merchant selected (or none), never the typed shipping phone / email.
      const custCtx = await resolveCustomerContext(
        storeId,
        { phone: idPhone, email: idEmail, customerId: data.customerId ?? null },
        pricingOpts.buyer ?? ANONYMOUS_BUYER
      );
      // Ruling B2B-M2 (final review P2-3): a free-shipping code is judged on every line (it acts on the shipping line,
      // not the discount basis); every other type on the base-priced lines only (B2B-5). Same split as checkout.
      const freeShipping = appliedCoupon.type === 'free_shipping';
      const targetingCtx = {
        ...custCtx,
        cartItems: resolved
          .filter(r => freeShipping || eligibleForCoupon(r.pricing))
          .map(r => ({
            productId: r.productId,
            categoryIds: (productMap.get(r.productId)?.categories ?? []).map(c => c.categoryId),
            quantity: r.quantity,
            lineTotal: r.lineTotal,
          })),
      };
      couponViolations.push(
        ...CouponService.adminOrderCouponViolations(
          appliedCoupon,
          targetingCtx,
          freeShipping ? subtotal : couponBasisSubtotal
        )
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
          couponBasisSubtotal,
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
      // Ruling B5-17: the gold rates the lines were priced from must still be the current ones.
      await assertSameRates(tx, storeId, adminGoldGate);
      // Per-customer coupon usage limit (same money-integrity gap as
      // OrderService.create, 2026-07-02 audit: createAdminOrder resolved
      // coupons via CouponService.getByCode, which only enforces the
      // store-wide `usageLimit` — `usageLimitPerUser` was never checked on
      // this path, so an admin/phone order could bypass a customer's cap).
      // Identity resolution mirrors create(): registered customers by
      // `customerId`; guests by E.164 phone / lowercased email under an advisory lock
      // (lib/coupon-per-customer-limit.ts). An unidentifiable guest is refused (or
      // reported as a violation when the admin overrides the coupon rules).
      if (
        couponCode &&
        appliedCoupon &&
        appliedCoupon.usageLimitPerUser &&
        appliedCoupon.usageLimitPerUser > 0
      ) {
        let priorUsageCount: number | null = null;
        try {
          priorUsageCount = await countPriorCouponUses(
            tx as unknown as CouponLimitTx,
            storeId,
            couponCode,
            {
              customerId: data.customerId,
              email:
                typeof data.shippingAddress.email === 'string' ? data.shippingAddress.email : null,
              phone:
                typeof data.shippingAddress.phone === 'string' ? data.shippingAddress.phone : null,
            }
          );
        } catch (e) {
          if (!(e instanceof AppError) || e.code !== 'COUPON_NEEDS_CONTACT') throw e;
          if (!overrideCoupon) throw e;
          couponViolations.push({
            code: 'COUPON_NEEDS_CONTACT',
            message: 'Per-customer coupon with no phone or email',
          });
        }
        if (priorUsageCount !== null && priorUsageCount >= appliedCoupon.usageLimitPerUser) {
          if (!overrideCoupon) {
            throw new AppError(400, 'COUPON_LIMIT_REACHED', 'Coupon usage limit reached');
          }
          couponViolations.push({
            code: 'COUPON_LIMIT_REACHED',
            message: 'Per-customer coupon usage limit reached',
          });
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
          priceGroupName: adminGroupPriceApplied ? adminResolver.groupName : null,
          currency: data.currency ?? REGION.currency,
          couponCode: couponCode ?? null,
          shippingAddress: withStoredPhone(data.shippingAddress) as Prisma.InputJsonValue,
          billingAddress: withStoredPhone(
            data.billingAddress ?? data.shippingAddress
          ) as Prisma.InputJsonValue,
          notes: data.notes ?? null,
          items: {
            create: resolved.map((r, i) => ({
              productId: r.productId,
              productName: r.productName,
              sku: r.sku,
              variantId: r.variantId,
              ...(adminGoldGate.snapshots.has(String(i))
                ? { goldSnapshot: adminGoldGate.snapshots.get(String(i)) as Prisma.InputJsonValue }
                : {}),
              // OrderItem's column is `variantName`. Writing `variantTitle`
              // (no such field) made Prisma reject the whole create, so every
              // admin manual order with a variant line failed since the
              // phone-order MVP (2ba38332) — found by the cost-snapshot test.
              variantName: r.variantTitle,
              variantNameAr: r.variantTitleAr,
              price: r.unitPrice,
              ...priceSnapshot(r.pricing),
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
      // #633 (Ruling STOCK-SYMMETRY-1): this order took NO stock; the cancel / refund restock reads this marker and
      // puts back only what was taken. Same event as the DO's placeAdminOrder (repo-factory-orders-contract parity).
      await tx.orderEvent.create({
        data: {
          storeId,
          orderId: created.id,
          fromStatus: null,
          toStatus: STOCK_NOT_TAKEN_EVENT,
          actorId: adminUserId,
          metadata: {
            items: created.items.map(it => ({ orderItemId: it.id, quantity: it.quantity })),
          },
        },
      });
      // The durable record of a MOQ override, in the order transaction (the audit row below is best-effort).
      if (moqOverride && belowMoqProducts.length > 0) {
        await tx.orderEvent.create({
          data: {
            storeId,
            orderId: created.id,
            fromStatus: null,
            toStatus: 'moq_override',
            actorId: adminUserId,
            metadata: {
              reason: data.moqOverrideReason?.trim() ?? '',
              actorRole: actor.role ?? null,
              productIds: [...new Set(belowMoqProducts)],
            },
          },
        });
      }
      // Fiscal document + gap-free serial in the same transaction (MONEYB-1).
      await FiscalDocumentService.issueSaleDocument(tx, storeId, created.id);
      return created;
    });

    if (moqOverride && belowMoqProducts.length > 0) {
      await auditLog({
        action: 'order.moq_override',
        userId: adminUserId,
        storeId,
        resourceType: 'order',
        resourceId: order.id,
        details: {
          orderNumber: order.orderNumber,
          description: data.moqOverrideReason?.trim() ?? '',
          productIds: [...new Set(belowMoqProducts)],
        },
      });
    }

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
