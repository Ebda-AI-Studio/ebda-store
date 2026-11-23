import { currentStoreId, prisma, Prisma, type RfmSegment } from '@ebda/database';
import { customerRow, customerRows, pickSelected } from '../lib/customer-directory';
import { customerAuthRoute } from '../lib/customer-auth';
import { storeDb, storeRepo } from '../lib/repo-factory';
import { getCached, customersCacheKey } from '../lib/public-cache';
import { customerKeyOf, rfmKeyFor } from '../lib/customer-key';
import { SmsConsentService } from './sms-consent.service';
import { AppError } from '../middleware/error-handler';
import { NON_REVENUE_ORDER_STATUSES } from '@ebda/shared';
import {
  latestPaymentIsOnline,
  NON_REVENUE_PAYMENT_STATUSES,
  netOrderRevenueMinor,
} from '../lib/revenue-sql';
import { refundedMinorByOrder } from '../lib/order-refunds';
import { matchingCustomers } from './admin-search.service';

/**
 * Customer aggregation — the Customers page's definition of "a customer"
 * (registered buyers, guest checkouts keyed by contact, and zero-order
 * registered shoppers), extracted from `customers.routes.ts` so the merchant
 * MCP tools (`admin_list_customers` / `admin_get_customer`) read the SAME rows
 * the dashboard renders instead of a second, drifting copy of the query.
 *
 * Grouping is `customerKeyOf` (`lib/customer-key.ts`) — the helper the RFM
 * rollup also keys on, so a segment's members resolve to these rows.
 */
/**
 * Cache TTL for the aggregated-customers snapshot. Must stay >= the
 * project-wide 120s Redis TTL floor (ESLint `cacheTtlSelectors` rule) — a
 * shorter TTL would hammer Neon compute on every cache miss. 300s balances
 * freshness (a new order shows up in the customers list within 5 min) against
 * the cost of re-scanning up to `MAX_ORDERS_SCANNED` orders on every request.
 */
const CUSTOMERS_CACHE_TTL_SECONDS = 300;

export interface AggregatedCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  /** Sub-fields of the latest shipping address, useful in spreadsheet. */
  address1: string;
  address2: string;
  city: string;
  area: string;
  country: string;
  postalCode: string;
  totalOrders: number;
  totalSpent: number;
  /** Average order value = totalSpent / totalOrders, in piastres. */
  avgOrderValue: number;
  lastOrderTotal: number;
  // Null for a registered shopper with zero orders (#1882) — everything
  // else in this shape is order-derived, so there is no order to date.
  lastOrderDate: Date | null;
  lastOrderNumber: string;
  lastOrderStatus: string;
  lastOrderPaymentStatus: string;
  /** Oldest order's createdAt — "customer since" date. Null, see lastOrderDate. */
  firstOrderDate: Date | null;
  /** Comma-joined list of order statuses the customer has touched. */
  statuses: string;
  /** Counts: paid + pending + cancelled + failed. */
  paidCount: number;
  pendingCount: number;
  cancelledCount: number;
  failedCount: number;
  /** Comma-joined list of payment methods ever used. */
  paymentMethods: string;
  isGuest: boolean;
}

export interface ShippingAddressShape {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  area?: string;
  governorate?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  block?: string;
  street?: string;
}

export function formatShippingAddress(addr: ShippingAddressShape | null): string {
  if (!addr) return '';
  return [addr.address1, addr.address2, addr.area, addr.city, addr.governorate, addr.country]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .filter((p, i, all) => all.indexOf(p) === i)
    .join(', ');
}

/**
 * Order statuses that do NOT count toward customer spend in the KPI strip.
 * The same set as the revenue definition (`lib/revenue-sql.ts`, Ruling REVENUE-DEF-1), so the Customers page and Analytics never
 * disagree about what "spent" means.
 */
const KPI_EXCLUDED_STATUSES = new Set<string>(NON_REVENUE_ORDER_STATUSES);

/**
 * Whether an order is a sale for customer spend: the revenue definition's POPULATION (Ruling REVENUE-DEF-1). It does not count when
 * its status is cancelled / refunded / awaiting confirmation, when its payment FAILED or was REFUNDED (STORE-QA-7: a delivered
 * order whose payment was refunded is not spend), or when it is UNPAID with an online payment attempt (an abandoned card / wallet
 * checkout). An unpaid cash-on-delivery order, or one with no online attempt (phone/admin), still counts. This only decides
 * membership; the AMOUNT added for a member is `netOrderRevenueMinor` (total minus refunds already given, partial included), so
 * the strip nets partial refunds too.
 */
export function countsTowardSpend(
  status: string,
  paymentStatus: string,
  payments: ReadonlyArray<{
    provider?: string | null;
    createdAt?: Date | number | string | null;
    id?: string;
  }> = []
): boolean {
  if (KPI_EXCLUDED_STATUSES.has(status)) return false;
  if ((NON_REVENUE_PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) return false;
  if (paymentStatus === 'unpaid' && latestPaymentIsOnline(payments)) return false;
  return true;
}

/**
 * Store-wide KPI strip for the Customers page. Computed over the WHOLE
 * aggregated set (never the current page, search or segment), so it
 * describes the store. A rate/average with no denominator is `null` —
 * unknown, rendered as unknown — never a fabricated 0.
 */
export interface CustomersSummary {
  /** Every row the list can show: buyers, zero-order registered, guests. */
  customers: number;
  /** Rows keyed as guests (no customer account). */
  guests: number;
  /** Customers with at least one counted (non-cancelled/refunded) order. */
  buyers: number;
  /** Customers with two or more counted orders. */
  repeatBuyers: number;
  /** repeatBuyers / buyers, 0..1. Null when there are no buyers. */
  repeatRate: number | null;
  /** Counted orders across all customers. */
  orders: number;
  /** Sum of counted order totals, in piastres. */
  totalSpent: number;
  /** totalSpent / orders, in piastres. Null when there are no counted orders. */
  avgOrderValue: number | null;
}

// A literal list, not `Object.values(RfmSegment)`: reading the enum VALUE at
// module load breaks every unit test that mocks '@ebda/database' wholesale.
// The type assertion below still fails the build if the enum gains a member.
export const RFM_SEGMENT_VALUES = [
  'vip',
  'loyal',
  'potential',
  'new_customer',
  'at_risk',
  'hibernating',
  'lost',
] as const satisfies readonly RfmSegment[];
const RFM_SEGMENTS_COMPLETE: [Exclude<RfmSegment, (typeof RFM_SEGMENT_VALUES)[number]>] extends [
  never,
]
  ? true
  : false = true;
void RFM_SEGMENTS_COMPLETE;
const RFM_SEGMENTS: ReadonlySet<string> = new Set(RFM_SEGMENT_VALUES);

/** Parse `?segment=` into an RFM segment or `'guest'`; anything else → null. */
export function parseSegmentFilter(raw: unknown): RfmSegment | 'guest' | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'guest') return 'guest';
  return RFM_SEGMENTS.has(raw) ? (raw as RfmSegment) : null;
}

export function summarizeCustomers(
  rows: Array<{ isGuest: boolean }>,
  counted: Map<string, { orders: number; spent: number }>
): CustomersSummary {
  let buyers = 0;
  let repeatBuyers = 0;
  let orders = 0;
  let totalSpent = 0;
  for (const c of counted.values()) {
    if (c.orders >= 1) buyers += 1;
    if (c.orders >= 2) repeatBuyers += 1;
    orders += c.orders;
    totalSpent += c.spent;
  }
  return {
    customers: rows.length,
    guests: rows.filter(r => r.isGuest).length,
    buyers,
    repeatBuyers,
    repeatRate: buyers > 0 ? repeatBuyers / buyers : null,
    orders,
    totalSpent,
    avgOrderValue: orders > 0 ? Math.round(totalSpent / orders) : null,
  };
}

/**
 * Hard cap on the number of orders scanned to build the aggregated customer
 * list / export. Protects the API from an OOM/timeout on stores with tens of
 * thousands of orders (the previous `findMany` had NO `take`). When the cap is
 * hit, the result carries `truncated: true` so the UI can surface a notice.
 *
 * 20k orders × the small projected row is well within a single request's
 * memory budget and covers the overwhelming majority of stores in full.
 */
const MAX_ORDERS_SCANNED = 20000;

/**
 * Cap on registered customers with NO order unioned into the list (issue
 * 2045). The zero-order query used to have no `take` at all, so a store with a
 * large sign-up base (a loyalty or newsletter campaign) materialised every
 * such user into the aggregation — and the whole result into one Redis value —
 * on each cache miss. Overflow sets `truncated`.
 */
export const MAX_ZERO_ORDER_CUSTOMERS = 5000;

/**
 * Hard cap on the number of orders returned for a SINGLE customer's profile
 * (`GET /customers/:customerKey`). Matches the `take: 100` convention used
 * elsewhere in the API as an "unbounded growth" guard (e.g.
 * `product.service.ts`, `stock-adjustment.service.ts`). Unlike
 * `MAX_ORDERS_SCANNED` above (which bounds a store-wide scan), this bounds a
 * single customer's order history — 100 orders for one customer covers the
 * overwhelming majority of cases; a truncated result carries `truncated: true`
 * so the UI can surface a notice, same pattern as the aggregation endpoints.
 */
export const MAX_CUSTOMER_ORDERS = 100;

/**
 * Aggregate customers from order history. Now includes:
 * - guest orders (no User row) keyed by shipping email/phone
 * - cancelled / unpaid orders (no status filter — Ahmad 2026-05-16:
 *   'get the info even if cancelled or unpaid')
 * - latest shipping address + per-order payment amount so the export
 *   surfaces what the merchant needs to ship + reconcile
 *
 * Bounded by `MAX_ORDERS_SCANNED`: we fetch up to the cap + 1 to detect
 * truncation, then aggregate only the capped slice. Orders are newest-first,
 * so a truncated result keeps the most recent activity.
 */
/** Shape of each order returned by aggregateCustomers (includes items for the Purchases sheet). */
export interface OrderWithItems {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  shippingAddress: unknown;
  payments: Array<{ provider: string; method: string | null }>;
  customer: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  items: Array<{
    id: string;
    productName: string;
    sku: string | null;
    variantName: string | null;
    quantity: number;
    price: number;
    total: number;
  }>;
}

/**
 * Narrows the aggregation to the rows a search matched (see `aggregateCustomersMatching`): the order
 * scan is ANDed with `orderWhere` and the zero-order union is limited to `zeroOrderUserIds`.
 */
export interface CustomerAggregateScope {
  orderWhere: Prisma.OrderWhereInput;
  zeroOrderUserIds: string[];
}

/**
 * `order.findMany` for a query that selects the `customer` (a `users` row). On a store served by its Durable Object the
 * `customer` relation lives in another database (prisma-lite refuses it), so the orders are read flat with `customerId`
 * and joined in memory to the DO's customer directory. Postgres stores run the unchanged relation query.
 */
async function findOrdersWithCustomer(storeId: string, args: any): Promise<any[]> {
  const odb = await storeDb(storeId);
  if ((await storeRepo(storeId)).backend !== 'do') return (odb.order as any).findMany(args);
  const useSelect = !!args.select;
  const { customer: customerArgs, ...others } = (useSelect ? args.select : args.include) as Record<
    string,
    any
  >;
  const { select: _s, include: _i, ...base } = args;
  const rows: any[] = await (odb.order as any).findMany({
    ...base,
    ...(useSelect ? { select: { ...others, customerId: true } } : { include: others }),
  });
  const ids = rows.map(r => r.customerId as string | null);
  const found =
    (await customerRows(storeId, ids)) ??
    (ids.some(Boolean)
      ? await prisma.user.findMany({
          where: { storeId, id: { in: ids.filter((x): x is string => !!x) } },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            createdAt: true,
          },
        })
      : []);
  const byId = new Map<string, any>(found.map((u: any) => [u.id, u]));
  const sel = customerArgs && typeof customerArgs === 'object' ? (customerArgs.select ?? {}) : {};
  return rows.map(r => {
    const u = r.customerId ? byId.get(r.customerId) : undefined;
    const { customerId, ...rest } = r;
    return {
      ...(useSelect && !args.select.customerId ? rest : r),
      customer: u ? pickSelected(u, sel) : null,
    };
  });
}

async function aggregateCustomersUncached(
  storeId: string,
  scope?: CustomerAggregateScope
): Promise<{
  customers: AggregatedCustomer[];
  /** The list is partial: the order scan OR the zero-order union hit its cap. */
  truncated: boolean;
  /** The order scan hit `MAX_ORDERS_SCANNED` (newest orders only). */
  ordersTruncated: boolean;
  /** More than `MAX_ZERO_ORDER_CUSTOMERS` registered customers have no order. */
  zeroOrderTruncated: boolean;
  ordersScanned: number;
  orders: OrderWithItems[];
  summary: CustomersSummary;
}> {
  const fetched: OrderWithItems[] = await findOrdersWithCustomer(storeId, {
    where: { storeId, deletedAt: null, ...(scope ? scope.orderWhere : {}) },
    select: {
      id: true,
      // kept on the row: a DO store joins the customer from the directory, and an order whose customer is not found there (erased
      // account, directory lag) must still read as a CUSTOMER order, not a guest one (STORE-QA-22).
      customerId: true,
      orderNumber: true,
      total: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      shippingAddress: true,
      // Payment method lives on the Payment row(s), not the Order. Pull
      // the provider + method via the relation; first payment wins for the
      // summary string.
      payments: { select: { id: true, provider: true, method: true, createdAt: true } },
      customer: {
        select: { id: true, email: true, firstName: true, lastName: true, phone: true },
      },
      // Include line items for the Purchases sheet.
      items: {
        select: {
          id: true,
          productName: true,
          sku: true,
          variantName: true,
          quantity: true,
          price: true,
          total: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    // Fetch one extra row to detect whether more orders exist beyond the cap.
    take: MAX_ORDERS_SCANNED + 1,
  });

  const truncated = fetched.length > MAX_ORDERS_SCANNED;
  const orders = truncated ? fetched.slice(0, MAX_ORDERS_SCANNED) : fetched;
  // REVENUE-DEF-1: spend is net of refunds already given on an order (completed returns / payment refunds), not just the
  // whole-order exclusions.
  const refundedByOrder = await refundedMinorByOrder(
    await storeDb(storeId),
    storeId,
    orders.map(o => o.id)
  );
  const netOf = (o: {
    id: string;
    total: number;
    status: string | null;
    paymentStatus: string | null;
  }) =>
    netOrderRevenueMinor({
      total: o.total,
      status: o.status ?? '',
      paymentStatus: o.paymentStatus ?? '',
      refundedMinor: refundedByOrder.get(o.id) ?? 0,
    });

  // Per-key transient tracking sets so we can emit comma-joined fields
  // after the loop without polluting the AggregatedCustomer shape.
  const statusSets = new Map<string, Set<string>>();
  const paymentMethodSets = new Map<string, Set<string>>();
  // KPI accumulator: counted (non-cancelled/refunded) orders + spend per key.
  const countedByKey = new Map<string, { orders: number; spent: number }>();

  const map = new Map<string, AggregatedCustomer>();
  for (const order of orders) {
    const shipping = (order.shippingAddress ?? null) as ShippingAddressShape | null;
    // A guest is an order with no customer ACCOUNT on it (customerId null), not one whose account row failed to join.
    const isGuest = !order.customer?.id && !(order as { customerId?: string | null }).customerId;
    // `customerKeyOf` is the grouping the RFM rollup also uses, so a segment's
    // members resolve to these rows. A guest order with no contact is its own
    // row, keyed by the order.
    const key = customerKeyOf(order) ?? `guest:${order.id}`;

    const firstName = order.customer?.firstName ?? shipping?.firstName ?? '';
    const lastName = order.customer?.lastName ?? shipping?.lastName ?? '';
    const email = order.customer?.email ?? shipping?.email ?? '';
    const phone = order.customer?.phone ?? shipping?.phone ?? '';
    const address = formatShippingAddress(shipping);
    const status = order.status ?? '';
    const paymentStatus = order.paymentStatus ?? '';
    // First payment provider on the order — multi-payment orders pick
    // the first record (matching the merchant-facing "this order paid
    // by X" expectation).
    const paymentMethod = order.payments?.[0]?.provider ?? '';

    let statusSet = statusSets.get(key);
    if (!statusSet) {
      statusSet = new Set();
      statusSets.set(key, statusSet);
    }
    if (status) statusSet.add(status);

    const counts = countsTowardSpend(status, paymentStatus, order.payments ?? []);
    if (counts) {
      const counted = countedByKey.get(key) ?? { orders: 0, spent: 0 };
      counted.orders += 1;
      counted.spent += netOf(order);
      countedByKey.set(key, counted);
    }

    let methodSet = paymentMethodSets.get(key);
    if (!methodSet) {
      methodSet = new Set();
      paymentMethodSets.set(key, methodSet);
    }
    if (paymentMethod) methodSet.add(paymentMethod);

    const existing = map.get(key);
    if (existing) {
      existing.totalOrders += 1;
      // Spend counts only orders that count as revenue (STORE-QA-22): a refunded/cancelled/failed order adds nothing.
      if (counts) existing.totalSpent += netOf(order);
      // `existing.firstOrderDate` is `Date | null` on the type (#1882's
      // zero-order-customer rows have no order to date), but every row this
      // order-aggregation loop ever creates or touches sets a real Date —
      // the null case is only ever added AFTER this loop finishes. Guard
      // anyway rather than a non-null assertion, so a future change to that
      // invariant fails loudly here instead of miscomparing against null.
      existing.firstOrderDate =
        !existing.firstOrderDate || order.createdAt < existing.firstOrderDate
          ? order.createdAt
          : existing.firstOrderDate;
      // findMany is ordered by createdAt desc, so the first row we see
      // for this key is the most recent. Subsequent rows are older —
      // only top up missing fields, never overwrite the newest snapshot.
      if (!existing.phone && phone) existing.phone = phone;
      if (!existing.address && address) {
        existing.address = address;
        existing.address1 = shipping?.address1 ?? '';
        existing.address2 = shipping?.address2 ?? '';
        existing.city = shipping?.city ?? '';
        existing.area = shipping?.area ?? '';
        existing.country = shipping?.country ?? '';
        existing.postalCode = shipping?.postalCode ?? '';
      }
      if (paymentStatus === 'paid') existing.paidCount += 1;
      else if (status === 'cancelled') existing.cancelledCount += 1;
      else if (paymentStatus === 'failed') existing.failedCount += 1;
      else existing.pendingCount += 1;
    } else {
      const newRow: AggregatedCustomer = {
        id: order.customer?.id ?? key,
        firstName,
        lastName,
        email,
        phone,
        address,
        address1: shipping?.address1 ?? '',
        address2: shipping?.address2 ?? '',
        city: shipping?.city ?? '',
        area: shipping?.area ?? '',
        country: shipping?.country ?? '',
        postalCode: shipping?.postalCode ?? '',
        totalOrders: 1,
        totalSpent: counts ? netOf(order) : 0,
        avgOrderValue: counts ? netOf(order) : 0,
        lastOrderTotal: order.total,
        lastOrderDate: order.createdAt,
        lastOrderNumber: order.orderNumber,
        lastOrderStatus: status,
        lastOrderPaymentStatus: paymentStatus,
        firstOrderDate: order.createdAt,
        statuses: '',
        paidCount: paymentStatus === 'paid' ? 1 : 0,
        pendingCount: 0,
        cancelledCount: status === 'cancelled' ? 1 : 0,
        failedCount: paymentStatus === 'failed' ? 1 : 0,
        paymentMethods: '',
        isGuest,
      };
      if (paymentStatus !== 'paid' && status !== 'cancelled' && paymentStatus !== 'failed') {
        newRow.pendingCount = 1;
      }
      map.set(key, newRow);
    }
  }

  // #1882: the aggregation above is entirely order-derived, so a registered
  // shopper who has never placed an order has no row and is invisible to
  // both this list and the detail route — which makes the erase/export
  // routes (PR #1852) unreachable through the admin UI for that population.
  // Union in customer-role Users this store has that own no order yet.
  // `deletedAt: null` also excludes erased accounts (eraseAccount sets it).
  //
  // Issue 2051: skip a user whose email/phone already keys a guest row — that
  // is the same human, who checked out without signing in, and already has a
  // row with real history.
  //
  // Issue 2045: the set is selected EXACTLY — `orders: { none: ... }` is a
  // NOT EXISTS, correct whatever the order scan's cap, so there is no
  // up-to-20k-element `notIn` of seen user ids and no need to skip the union
  // when the order scan was truncated (a user with orders past the cap still
  // HAS orders, and is excluded by the database, not by what we happened to
  // scan). It is bounded: `MAX_ZERO_ORDER_CUSTOMERS` newest sign-ups, with
  // the overflow reported through the same `truncated` flag the page's notice
  // reads, never silently dropped.
  // N-9: a DO-served store's registered customers are its DO's. "Never ordered" is decided against the store's own orders
  // (also the DO's), in bounded batches over the newest sign-ups, so the cap and the truncation flag keep their meaning.
  const zeroOrderViaDo = async () => {
    const route = await customerAuthRoute(storeId, { write: false });
    if (route.kind !== 'do') return null;
    const out: Array<{
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      phone: string | null;
    }> = [];
    const batch = await route.client.call<
      Array<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
        phone: string | null;
      }>
    >('newest', { limit: 5000, ...(scope ? { ids: scope.zeroOrderUserIds.slice(0, 500) } : {}) });
    const odb = await storeDb(storeId);
    for (let i = 0; i < batch.length && out.length <= MAX_ZERO_ORDER_CUSTOMERS; i += 200) {
      const chunk = batch.slice(i, i + 200);
      const ordered = new Set(
        (
          await odb.order.findMany({
            where: { storeId, deletedAt: null, customerId: { in: chunk.map(u => u.id) } },
            select: { customerId: true },
          })
        ).map(o => o.customerId)
      );
      for (const u of chunk) if (!ordered.has(u.id)) out.push(u);
    }
    return out.slice(0, MAX_ZERO_ORDER_CUSTOMERS + 1);
  };
  const zeroOrderFetched =
    (await zeroOrderViaDo()) ??
    (await prisma.user.findMany({
      where: {
        storeId,
        role: 'customer',
        deletedAt: null,
        orders: { none: { storeId, deletedAt: null } },
        ...(scope ? { id: { in: scope.zeroOrderUserIds } } : {}),
      },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_ZERO_ORDER_CUSTOMERS + 1,
    }));
  const zeroOrderTruncated = zeroOrderFetched.length > MAX_ZERO_ORDER_CUSTOMERS;
  const zeroOrderUsers = zeroOrderTruncated
    ? zeroOrderFetched.slice(0, MAX_ZERO_ORDER_CUSTOMERS)
    : zeroOrderFetched;
  for (const user of zeroOrderUsers) {
    if ((user.email && map.has(user.email.toLowerCase())) || (user.phone && map.has(user.phone))) {
      continue;
    }
    map.set(user.id, {
      id: user.id,
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      email: user.email ?? '',
      phone: user.phone ?? '',
      address: '',
      address1: '',
      address2: '',
      city: '',
      area: '',
      country: '',
      postalCode: '',
      totalOrders: 0,
      totalSpent: 0,
      avgOrderValue: 0,
      lastOrderTotal: 0,
      lastOrderDate: null,
      lastOrderNumber: '',
      lastOrderStatus: '',
      lastOrderPaymentStatus: '',
      firstOrderDate: null,
      statuses: '',
      paidCount: 0,
      pendingCount: 0,
      cancelledCount: 0,
      failedCount: 0,
      paymentMethods: '',
      isGuest: false,
    });
  }

  // Materialize comma-joined sets + recompute avgOrderValue after the
  // full aggregation pass.
  for (const [key, row] of map.entries()) {
    row.statuses = Array.from(statusSets.get(key) ?? []).join(', ');
    row.paymentMethods = Array.from(paymentMethodSets.get(key) ?? []).join(', ');
    const countedOrders = countedByKey.get(key)?.orders ?? 0;
    row.avgOrderValue = countedOrders > 0 ? Math.round(row.totalSpent / countedOrders) : 0;
  }

  const customers = Array.from(map.values()).sort((a, b) => b.totalSpent - a.totalSpent);
  return {
    customers,
    truncated: truncated || zeroOrderTruncated,
    ordersTruncated: truncated,
    zeroOrderTruncated,
    ordersScanned: orders.length,
    orders: orders as OrderWithItems[],
    summary: summarizeCustomers(customers, countedByKey),
  };
}

/**
 * Cached wrapper around `aggregateCustomersUncached`. Called on EVERY
 * `GET /customers` and `/customers/export.xlsx` request — without a cache
 * this re-scans up to `MAX_ORDERS_SCANNED` orders (with items + payments +
 * customer) on every page load, unlike the public product-list path which
 * already caches via `lib/public-cache.ts`. Keyed per store (both endpoints
 * call this with no other filter params, so a single key per store is
 * correct — search/pagination are applied AFTER aggregation, in memory).
 *
 * TTL floor: the ESLint `cacheTtlSelectors` rule blocks `getCached()` calls
 * under 120s (see `CACHE_TTL_FLOOR` in `apps/api/eslint.config.mjs`) —
 * `CUSTOMERS_CACHE_TTL_SECONDS` (300s) respects that floor.
 */
export async function aggregateCustomers(storeId: string): Promise<{
  customers: AggregatedCustomer[];
  /** The list is partial: the order scan OR the zero-order union hit its cap. */
  truncated: boolean;
  /** The order scan hit `MAX_ORDERS_SCANNED` (newest orders only). */
  ordersTruncated: boolean;
  /** More than `MAX_ZERO_ORDER_CUSTOMERS` registered customers have no order. */
  zeroOrderTruncated: boolean;
  ordersScanned: number;
  orders: OrderWithItems[];
  summary: CustomersSummary;
}> {
  const result = await getCached(customersCacheKey(storeId), CUSTOMERS_CACHE_TTL_SECONDS, () =>
    aggregateCustomersUncached(storeId)
  );

  // getCached() round-trips through JSON.stringify/parse when served from
  // Redis, which turns Date fields into ISO strings. Re-hydrate them
  // unconditionally (cheap, and a no-op on values that are already real Date
  // instances on a cache miss) so every caller — especially the .xlsx export,
  // which needs real Date objects for ExcelJS's `numFmt` date formatting —
  // sees identical types whether this was a cache hit or a fresh computation.
  for (const c of result.customers) {
    // #1882: a zero-order customer's dates are `null`, not a JSON-string
    // timestamp — `new Date(null)` would silently coerce to the 1970 epoch.
    c.lastOrderDate = c.lastOrderDate ? new Date(c.lastOrderDate) : null;
    c.firstOrderDate = c.firstOrderDate ? new Date(c.firstOrderDate) : null;
  }
  for (const o of result.orders) {
    o.createdAt = new Date(o.createdAt);
  }

  return result;
}

/**
 * One customer's profile + order history, by Customers-page key (a User.id
 * UUID, a guest's lowercased email, or a guest's phone — `customerKeyOf`).
 * Throws `AppError(404)` when nothing in THIS store matches. Extracted from
 * `GET /customers/:customerKey` so `admin_get_customer` returns the same
 * profile the dashboard renders. Pass the DECODED key.
 */
/**
 * The guest orders (no customer_id) whose lowercased shipping email is `key`, or, when the order has no email, whose phone is
 * `key`: newest first, at most MAX_CUSTOMER_ORDERS + 1. Postgres answers with its JSON operators; a Durable Object store has
 * no JSON-path filter, so its guest orders are scanned newest-first in bounded pages (the same 20k cap as the list's scan).
 */
async function guestOrderIdsForKey(storeId: string, key: string): Promise<Array<{ id: string }>> {
  if ((await storeRepo(storeId)).backend === 'do') {
    const odb = await storeDb(storeId);
    const out: Array<{ id: string }> = [];
    const PAGE = 500;
    for (
      let skip = 0;
      skip < MAX_ORDERS_SCANNED && out.length <= MAX_CUSTOMER_ORDERS;
      skip += PAGE
    ) {
      const page = await odb.order.findMany({
        where: { storeId, deletedAt: null, customerId: null },
        select: { id: true, shippingAddress: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE,
        skip,
      });
      for (const o of page) {
        const a = (o.shippingAddress ?? {}) as Record<string, unknown>;
        const email = typeof a.email === 'string' ? a.email : '';
        const phone = typeof a.phone === 'string' ? a.phone : '';
        if (email.toLowerCase() === key || (email === '' && phone === key)) out.push({ id: o.id });
      }
      if (page.length < PAGE) break;
    }
    return out.slice(0, MAX_CUSTOMER_ORDERS + 1);
  }
  return prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM public.orders
      WHERE store_id = ${storeId}
        AND deleted_at IS NULL
        AND customer_id IS NULL
        AND (
              LOWER(shipping_address->>'email') = ${key}
           OR (COALESCE(shipping_address->>'email', '') = ''
               AND shipping_address->>'phone' = ${key})
        )
      ORDER BY created_at DESC
      LIMIT ${MAX_CUSTOMER_ORDERS + 1}
    `;
}

export async function getCustomerProfile(storeId: string, customerKey: string) {
  const decodedKey = customerKey;

  // UUID v4 detection — `Order.customerId` is a uuid string when
  // present. Guest keys are emails / phones / synthetic IDs.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decodedKey);

  // A guest key resolves to exactly the orders `customerKeyOf` groups under
  // it: guest checkouts (no customer_id) whose LOWERCASED shipping email is
  // the key, or — when the order has no email — whose phone is the key. The
  // previous exact-case JSON match 404'd any guest who typed a capital letter
  // in their email (the list key is lowercased), and also pulled a signed-in
  // shopper's orders into a guest profile, so the detail disagreed with the
  // row the merchant clicked. Resolved by id first (a JSON-path equality in
  // Prisma cannot lowercase), then loaded through the one typed query below.
  let orderScope: Prisma.OrderWhereInput;
  if (isUuid) {
    orderScope = { customerId: decodedKey };
  } else {
    const guestOrderIds = await guestOrderIdsForKey(storeId, decodedKey);
    orderScope = { id: { in: guestOrderIds.map(r => r.id) } };
  }

  // Fetch one extra row (like `aggregateCustomers`' MAX_ORDERS_SCANNED
  // pattern above) to detect truncation without a separate count query.
  // Unlike the siblings, this query previously had NO `take` at all — a
  // customer with an unusually large order history could load its full
  // set of orders (each with items + payments) on every profile view.
  const fetchedOrders = await findOrdersWithCustomer(storeId, {
    where: {
      storeId,
      deletedAt: null,
      ...orderScope,
    },
    include: {
      customer: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          createdAt: true,
        },
      },
      items: {
        select: {
          id: true,
          productName: true,
          quantity: true,
          price: true,
          total: true,
        },
      },
      payments: {
        select: {
          id: true,
          createdAt: true,
          provider: true,
          status: true,
          amount: true,
          refundedAmount: true,
          metadata: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CUSTOMER_ORDERS + 1,
  });

  if (fetchedOrders.length === 0) {
    // No orders at all — could still be a registered shopper who has
    // never checked out. Guest keys (email/phone) have no order-less
    // identity to resolve to, so only a UUID key gets this fallback.
    // #1882: without it, a zero-order customer-role User is invisible
    // to both this route and the list aggregation below, which makes
    // the erase/export routes (PR #1852) unreachable through the admin
    // UI for that population even though the routes themselves work.
    if (isUuid) {
      const doZero = await customerRow(storeId, decodedKey);
      const zeroOrderUser =
        doZero !== undefined
          ? doZero && doZero.deletedAt === null
            ? doZero
            : null
          : await prisma.user.findFirst({
              where: { id: decodedKey, storeId, role: 'customer', deletedAt: null },
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                phone: true,
                createdAt: true,
              },
            });
      if (zeroOrderUser) {
        return {
          customer: {
            id: zeroOrderUser.id,
            isGuest: false,
            firstName: zeroOrderUser.firstName ?? '',
            lastName: zeroOrderUser.lastName ?? '',
            email: zeroOrderUser.email ?? '',
            phone: zeroOrderUser.phone ?? '',
            address: '',
            address1: '',
            address2: '',
            city: '',
            area: '',
            country: '',
            postalCode: '',
            accountCreatedAt: zeroOrderUser.createdAt,
            firstOrderDate: null,
            lastOrderDate: null,
            totalOrders: 0,
            totalSpent: 0,
            avgOrderValue: 0,
            paidCount: 0,
            pendingCount: 0,
            cancelledCount: 0,
            failedCount: 0,
            refundedCount: 0,
            totalRefunded: 0,
            paymentMethods: [],
            statuses: [],
            ...(await (async () => {
              const linked = await (
                await storeDb(storeId)
              ).customer.findFirst({
                where: { storeId, userId: zeroOrderUser.id },
                select: {
                  groupId: true,
                  group: { select: { id: true, name: true, nameAr: true } },
                },
              });
              return { groupId: linked?.groupId ?? null, group: linked?.group ?? null };
            })()),
          },
          orders: [],
          truncated: false,
          smsMarketingConsent: await SmsConsentService.getForCustomerKey(
            storeId,
            zeroOrderUser.id,
            zeroOrderUser.phone
          ),
        };
      }
    }
    throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  }

  const truncated = fetchedOrders.length > MAX_CUSTOMER_ORDERS;
  const orders = truncated ? fetchedOrders.slice(0, MAX_CUSTOMER_ORDERS) : fetchedOrders;
  const refundedByOrder = await refundedMinorByOrder(
    await storeDb(storeId),
    storeId,
    orders.map(o => o.id)
  );

  // Aggregate stats from the order list (capped at MAX_CUSTOMER_ORDERS —
  // see `truncated` above). The first order (newest) wins for
  // current-snapshot fields (latest address, phone, etc.). Mirror the
  // listing-page logic exactly so the detail view's totals match what
  // the merchant saw in the list.
  const newest = orders[0];
  const oldest = orders[orders.length - 1];
  const newestShipping = (newest.shippingAddress ?? null) as ShippingAddressShape | null;

  let totalSpent = 0;
  let totalRefunded = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;
  let refundedCount = 0;
  const paymentMethodSet = new Set<string>();
  const statusSet = new Set<string>();

  let countedOrders = 0;
  for (const o of orders) {
    // Same population as the list/KPI (STORE-QA-22): refunded/cancelled/failed orders add no spend.
    if (countsTowardSpend(o.status, o.paymentStatus, o.payments ?? [])) {
      totalSpent += netOrderRevenueMinor({
        total: o.total,
        status: o.status,
        paymentStatus: o.paymentStatus,
        refundedMinor: refundedByOrder.get(o.id) ?? 0,
      });
      countedOrders += 1;
    }
    statusSet.add(o.status);
    const ps = o.paymentStatus;
    // Refund takes precedence — a refunded order shouldn't double-count
    // as paid + refunded in the customer header.
    if (ps === 'refunded' || o.status === 'refunded') {
      refundedCount += 1;
      for (const p of o.payments ?? []) totalRefunded += p.refundedAmount ?? 0;
    } else if (ps === 'paid') paidCount += 1;
    else if (o.status === 'cancelled') cancelledCount += 1;
    else if (ps === 'failed') failedCount += 1;
    else pendingCount += 1;

    const method = o.payments?.[0]?.provider;
    if (method) paymentMethodSet.add(method);
  }

  const customer = {
    id: newest.customer?.id ?? decodedKey,
    isGuest: !newest.customer?.id,
    firstName: newest.customer?.firstName ?? newestShipping?.firstName ?? '',
    lastName: newest.customer?.lastName ?? newestShipping?.lastName ?? '',
    email: newest.customer?.email ?? newestShipping?.email ?? '',
    phone: newest.customer?.phone ?? newestShipping?.phone ?? '',
    address: formatShippingAddress(newestShipping),
    address1: newestShipping?.address1 ?? '',
    address2: newestShipping?.address2 ?? '',
    city: newestShipping?.city ?? '',
    area: newestShipping?.area ?? '',
    country: newestShipping?.country ?? '',
    postalCode: newestShipping?.postalCode ?? '',
    accountCreatedAt: newest.customer?.createdAt ?? null,
    firstOrderDate: oldest.createdAt,
    lastOrderDate: newest.createdAt,
    totalOrders: orders.length,
    totalSpent,
    avgOrderValue: countedOrders > 0 ? Math.round(totalSpent / countedOrders) : 0,
    paidCount,
    pendingCount,
    cancelledCount,
    failedCount,
    refundedCount,
    totalRefunded,
    paymentMethods: Array.from(paymentMethodSet),
    statuses: Array.from(statusSet),
  };

  // Resolve the assigned group. Groups live on the `customers` table. A REGISTERED shopper (customer.isGuest false; the id
  // is the users.id) is looked up by the `customers.user_id` link ONLY: matching on phone / email showed another person's
  // group on the wrong profile (a shopper can set any phone on their profile, Ruling B2B-2c). A GUEST key has no account, so
  // its display falls back to the typed contact, restricted to rows that are NOT linked to a registered user.
  let groupId: string | null = null;
  let group: { id: string; name: string; nameAr: string | null } | null = null;
  const groupSelect = {
    groupId: true,
    group: { select: { id: true, name: true, nameAr: true } },
  } as const;
  let grouped: {
    groupId: string | null;
    group: { id: string; name: string; nameAr: string | null } | null;
  } | null = null;
  if (!customer.isGuest) {
    grouped = await (
      await storeDb(storeId)
    ).customer.findFirst({
      where: { storeId, userId: customer.id },
      select: groupSelect,
    });
  } else {
    const identityOr: Prisma.CustomerWhereInput[] = [];
    if (customer.phone) identityOr.push({ phone: customer.phone });
    if (customer.email) identityOr.push({ email: { equals: customer.email, mode: 'insensitive' } });
    if (identityOr.length > 0) {
      grouped = await (
        await storeDb(storeId)
      ).customer.findFirst({
        where: { storeId, userId: null, OR: identityOr },
        select: groupSelect,
      });
    }
  }
  if (grouped) {
    groupId = grouped.groupId;
    group = grouped.group;
  }

  // SMS-marketing consent (issue 206): this profile's own key (the user id
  // for a registered shopper, else the guest key clicked) plus its phone, the
  // same rows the send gate matches (issue 2423).
  const smsMarketingConsent = await SmsConsentService.getForCustomerKey(
    storeId,
    newest.customer?.id ?? decodedKey,
    customer.phone
  );

  return { customer: { ...customer, groupId, group }, orders, truncated, smsMarketingConsent };
}

/**
 * RFM segment per Customers-page row, keyed by the row's `id`.
 *
 * A snapshot's `customerId` is `rfmKeyFor(customerKeyOf(order))` — the user
 * id for a registered buyer, `GUEST:sha256(key)` for a guest — so each row is
 * resolved by hashing its own id the same way. Rows with no snapshot (no paid
 * order yet, a contact-less guest, or not yet rolled up) are absent from the
 * map: unknown, never a fabricated segment.
 *
 * Reads ONLY the snapshots of the rows passed (issue 2243) — call it with the
 * one page being rendered, never the whole aggregated list: it used to load
 * the store's entire snapshot table (every customer it ever had, guests
 * included) on every Customers request and every MCP lookup. Filtering and
 * the filter pills have their own indexed reads below.
 */
export async function segmentsForCustomers(
  storeId: string,
  rows: ReadonlyArray<{ id: string; isGuest: boolean }>
): Promise<Map<string, RfmSegment>> {
  const out = new Map<string, RfmSegment>();
  if (rows.length === 0) return out;
  const keyOf = new Map(rows.map(r => [r.id, rfmKeyFor(r.id, r.isGuest)]));
  const snapshots = await (
    await storeDb(currentStoreId())
  ).customerRfmSnapshot.findMany({
    where: { storeId, customerId: { in: Array.from(new Set(keyOf.values())) } },
    select: { customerId: true, segment: true },
  });
  const byKey = new Map(snapshots.map(s => [s.customerId, s.segment]));
  for (const row of rows) {
    const seg = byKey.get(keyOf.get(row.id)!);
    if (seg) out.set(row.id, seg);
  }
  return out;
}

/**
 * The rows of `rows` whose RFM snapshot is in `segment` — the server-side
 * segment filter. One `(storeId, segment)` index read of the member keys
 * instead of every snapshot in the store (issue 2243).
 */
export async function filterCustomersBySegment<T extends { id: string; isGuest: boolean }>(
  storeId: string,
  rows: ReadonlyArray<T>,
  segment: RfmSegment
): Promise<T[]> {
  const members = await (
    await storeDb(currentStoreId())
  ).customerRfmSnapshot.findMany({
    where: { storeId, segment },
    select: { customerId: true },
  });
  if (members.length === 0) return [];
  const keys = new Set(members.map(m => m.customerId));
  return rows.filter(r => keys.has(rfmKeyFor(r.id, r.isGuest)));
}

/**
 * The RFM segments present in the store, canonical order — the Customers
 * page's filter pills. A `groupBy` over the `(storeId, segment)` index, not
 * a read of every snapshot (issue 2243).
 */
export async function presentRfmSegments(storeId: string): Promise<RfmSegment[]> {
  const groups = await (
    await storeDb(currentStoreId())
  ).customerRfmSnapshot.groupBy({
    by: ['segment'],
    where: { storeId },
  });
  const present = new Set(groups.map(g => g.segment));
  return RFM_SEGMENT_VALUES.filter(s => present.has(s));
}

/**
 * The customers a search matched, aggregated the same way as `aggregateCustomers` (same row shape,
 * all of each matched customer's orders). Uncached: the result is small and query-specific. The
 * match itself is SQL (`matchingCustomers`: Arabic-normalised names, any phone form, email), so a
 * customer older than the 20k-order scan of the cached aggregate is still found, which the old
 * in-memory filter could not do. `summary` describes the matched rows only; the store-wide KPI strip
 * must keep reading the cached `aggregateCustomers`.
 *
 * Ruling SEARCH-P2-1: a GUEST row is built from the guest orders that matched, so when one contact
 * placed orders under different names, a name search aggregates only the orders carrying that name
 * (its totals can undercount). Matching on the contact key instead would need a second round trip
 * per guest. Cost if wrong: a guest's order count/total shown under a name search is partial; the
 * customer detail page (keyed by email/phone) is complete.
 */
export async function aggregateCustomersMatching(storeId: string, search: string) {
  const m = await matchingCustomers(storeId, search);
  const r = await aggregateCustomersUncached(storeId, {
    orderWhere: { OR: [{ customerId: { in: m.userIds } }, { id: { in: m.guestOrderIds } }] },
    zeroOrderUserIds: m.userIds,
  });
  return { ...r, truncated: r.truncated || m.truncated, searchTruncated: m.truncated };
}
