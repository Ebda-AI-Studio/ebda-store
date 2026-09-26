import { Router, Request, Response, NextFunction } from 'express';
import ExcelJS from 'exceljs';
import { neutralizeRowObject, neutralizeRowArray } from '../lib/exports/xlsx';
import { prisma, Prisma } from '@force/database';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';
import { writeLimiter, auditLog } from '../middleware/security';
import { getCached, customersCacheKey, invalidateCustomersCache } from '../lib/public-cache';
import { AuthService } from '../services/auth.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

/**
 * Cache TTL for the aggregated-customers snapshot. Must stay >= the
 * project-wide 120s Redis TTL floor (ESLint `cacheTtlSelectors` rule) — a
 * shorter TTL would hammer Neon compute on every cache miss. 300s balances
 * freshness (a new order shows up in the customers list within 5 min) against
 * the cost of re-scanning up to `MAX_ORDERS_SCANNED` orders on every request.
 */
const CUSTOMERS_CACHE_TTL_SECONDS = 300;

// `customersCacheKey` / `invalidateCustomersCache` now live in
// `../lib/public-cache` so `OrderService` (which can't import from `routes/`)
// can call the invalidator directly from order-mutation paths. Re-exported
// here for any existing importer of this module.
export { invalidateCustomersCache };

// staff can read customer records (needed for order context lookups).
// writeLimiter caps the heavy aggregation endpoints (full order-table scan
// per call, esp. export.xlsx) the same way other heavy admin routes are
// limited — see writeLimiter usage in ai.routes.ts / bulk.routes.ts /
// order.routes.ts.
const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
];

interface AggregatedCustomer {
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
  /** Average order value = totalSpent / totalOrders, in fils. */
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

interface ShippingAddressShape {
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

function formatShippingAddress(addr: ShippingAddressShape | null): string {
  if (!addr) return '';
  return [addr.address1, addr.address2, addr.area, addr.city, addr.country]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(', ');
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
 * Hard cap on the number of orders returned for a SINGLE customer's profile
 * (`GET /customers/:customerKey`). Matches the `take: 100` convention used
 * elsewhere in the API as an "unbounded growth" guard (e.g.
 * `product.service.ts`, `stock-adjustment.service.ts`). Unlike
 * `MAX_ORDERS_SCANNED` above (which bounds a store-wide scan), this bounds a
 * single customer's order history — 100 orders for one customer covers the
 * overwhelming majority of cases; a truncated result carries `truncated: true`
 * so the UI can surface a notice, same pattern as the aggregation endpoints.
 */
const MAX_CUSTOMER_ORDERS = 100;

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
interface OrderWithItems {
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

async function aggregateCustomersUncached(storeId: string): Promise<{
  customers: AggregatedCustomer[];
  truncated: boolean;
  ordersScanned: number;
  orders: OrderWithItems[];
}> {
  const fetched = await prisma.order.findMany({
    where: { storeId, deletedAt: null },
    select: {
      id: true,
      orderNumber: true,
      total: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      shippingAddress: true,
      // Payment method lives on the Payment row(s), not the Order. Pull
      // the provider + method via the relation; first payment wins for the
      // summary string.
      payments: { select: { provider: true, method: true } },
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

  // Per-key transient tracking sets so we can emit comma-joined fields
  // after the loop without polluting the AggregatedCustomer shape.
  const statusSets = new Map<string, Set<string>>();
  const paymentMethodSets = new Map<string, Set<string>>();

  const map = new Map<string, AggregatedCustomer>();
  for (const order of orders) {
    const shipping = (order.shippingAddress ?? null) as ShippingAddressShape | null;
    const isGuest = !order.customer?.id;
    const key =
      order.customer?.id ||
      shipping?.email?.toLowerCase() ||
      shipping?.phone ||
      `guest:${order.id}`;

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

    let methodSet = paymentMethodSets.get(key);
    if (!methodSet) {
      methodSet = new Set();
      paymentMethodSets.set(key, methodSet);
    }
    if (paymentMethod) methodSet.add(paymentMethod);

    const existing = map.get(key);
    if (existing) {
      existing.totalOrders += 1;
      existing.totalSpent += order.total;
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
        totalSpent: order.total,
        avgOrderValue: order.total,
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
  const registeredIds = Array.from(map.keys());
  const zeroOrderUsers = await prisma.user.findMany({
    where: {
      storeId,
      role: 'customer',
      deletedAt: null,
      ...(registeredIds.length > 0 ? { id: { notIn: registeredIds } } : {}),
    },
    select: { id: true, email: true, firstName: true, lastName: true, phone: true },
  });
  for (const user of zeroOrderUsers) {
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
    row.avgOrderValue = row.totalOrders > 0 ? Math.round(row.totalSpent / row.totalOrders) : 0;
  }

  const customers = Array.from(map.values()).sort((a, b) => b.totalSpent - a.totalSpent);
  return { customers, truncated, ordersScanned: orders.length, orders: orders as OrderWithItems[] };
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
async function aggregateCustomers(storeId: string): Promise<{
  customers: AggregatedCustomer[];
  truncated: boolean;
  ordersScanned: number;
  orders: OrderWithItems[];
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
 * GET /stores/:storeId/customers/export.xlsx
 * Streams an .xlsx workbook of all customers aggregated from order history.
 * Used by the admin customers page's "Export" button.
 */
router.get(
  '/customers/export.xlsx',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { name: true, slug: true },
      });
      if (!store) {
        throw new AppError(404, 'NOT_FOUND', 'Store not found');
      }

      const { customers, truncated, ordersScanned, orders } = await aggregateCustomers(storeId);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Force Website Builder';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Customers');

      // Store Name is the first column so multi-store exports are immediately
      // filterable in Excel without moving columns.
      sheet.columns = [
        { header: 'Store Name', key: 'storeName', width: 20 },
        { header: 'First Name', key: 'firstName', width: 18 },
        { header: 'Last Name', key: 'lastName', width: 18 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Guest', key: 'isGuest', width: 8 },
        { header: 'Address', key: 'address', width: 42 },
        { header: 'Address Line 1', key: 'address1', width: 24 },
        { header: 'Address Line 2', key: 'address2', width: 24 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'City', key: 'city', width: 18 },
        { header: 'Country', key: 'country', width: 16 },
        { header: 'Postal Code', key: 'postalCode', width: 14 },
        { header: 'Total Orders', key: 'totalOrders', width: 14 },
        { header: 'Paid', key: 'paidCount', width: 8 },
        { header: 'Pending', key: 'pendingCount', width: 10 },
        { header: 'Cancelled', key: 'cancelledCount', width: 11 },
        { header: 'Failed', key: 'failedCount', width: 9 },
        { header: 'Total Spent (KWD)', key: 'totalSpent', width: 18 },
        { header: 'Avg Order Value (KWD)', key: 'avgOrderValue', width: 20 },
        { header: 'Last Order #', key: 'lastOrderNumber', width: 22 },
        { header: 'Last Order (KWD)', key: 'lastOrderTotal', width: 18 },
        { header: 'Last Order Status', key: 'lastOrderStatus', width: 18 },
        { header: 'Last Payment Status', key: 'lastOrderPaymentStatus', width: 20 },
        { header: 'Last Order Date', key: 'lastOrderDate', width: 18 },
        { header: 'First Order Date', key: 'firstOrderDate', width: 18 },
        { header: 'Order Statuses', key: 'statuses', width: 28 },
        { header: 'Payment Methods', key: 'paymentMethods', width: 24 },
      ];
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };

      for (const c of customers) {
        sheet.addRow(
          neutralizeRowObject({
            storeName: store.name,
            firstName: c.firstName,
            lastName: c.lastName,
            email: c.email,
            phone: c.phone,
            isGuest: c.isGuest ? 'Yes' : 'No',
            address: c.address,
            address1: c.address1,
            address2: c.address2,
            area: c.area,
            city: c.city,
            country: c.country,
            postalCode: c.postalCode,
            totalOrders: c.totalOrders,
            paidCount: c.paidCount,
            pendingCount: c.pendingCount,
            cancelledCount: c.cancelledCount,
            failedCount: c.failedCount,
            // Convert fils → KWD with 3 decimals so the cell is numeric and
            // sortable in Excel rather than a formatted string.
            totalSpent: Number((c.totalSpent / 1000).toFixed(3)),
            avgOrderValue: Number((c.avgOrderValue / 1000).toFixed(3)),
            lastOrderNumber: c.lastOrderNumber,
            lastOrderTotal: Number((c.lastOrderTotal / 1000).toFixed(3)),
            lastOrderStatus: c.lastOrderStatus,
            lastOrderPaymentStatus: c.lastOrderPaymentStatus,
            lastOrderDate: c.lastOrderDate,
            firstOrderDate: c.firstOrderDate,
            statuses: c.statuses,
            paymentMethods: c.paymentMethods,
          })
        );
      }

      // When the order scan hit the cap, append a visible notice row so the
      // merchant knows the export is partial (newest orders only) rather than
      // silently believing it's the complete customer history.
      if (truncated) {
        const noticeRow = sheet.addRow({
          storeName: `NOTE: export truncated — only the most recent ${ordersScanned.toLocaleString()} orders were aggregated. Contact support for a full export of larger stores.`,
        });
        noticeRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      // Format the date + currency columns. Excel's "kwd" doesn't have a
      // built-in symbol, so we use a numeric format with 3 decimals.
      sheet.getColumn('totalSpent').numFmt = '0.000';
      sheet.getColumn('avgOrderValue').numFmt = '0.000';
      sheet.getColumn('lastOrderTotal').numFmt = '0.000';
      sheet.getColumn('lastOrderDate').numFmt = 'yyyy-mm-dd';
      sheet.getColumn('firstOrderDate').numFmt = 'yyyy-mm-dd';

      // ----------------------------------------------------------------
      // "Purchases" worksheet — one row per order line-item.
      // Uses the same capped order set already fetched; zero extra queries.
      // ----------------------------------------------------------------
      const purchasesSheet = workbook.addWorksheet('Purchases');
      purchasesSheet.columns = [
        { header: 'Store Name', key: 'storeName', width: 20 },
        { header: 'Customer', key: 'customer', width: 24 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Order #', key: 'orderNumber', width: 22 },
        { header: 'Order Date', key: 'orderDate', width: 14 },
        { header: 'Order Status', key: 'orderStatus', width: 16 },
        { header: 'Payment Status', key: 'paymentStatus', width: 16 },
        { header: 'Pay Provider', key: 'payProvider', width: 14 },
        { header: 'Pay Method', key: 'payMethod', width: 14 },
        { header: 'Product', key: 'product', width: 32 },
        { header: 'SKU', key: 'sku', width: 16 },
        { header: 'Variant', key: 'variant', width: 20 },
        { header: 'Qty', key: 'qty', width: 8 },
        { header: 'Unit Price (KWD)', key: 'unitPrice', width: 18 },
        { header: 'Line Total (KWD)', key: 'lineTotal', width: 18 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'City', key: 'city', width: 18 },
        { header: 'Country', key: 'country', width: 16 },
        { header: 'Block', key: 'block', width: 10 },
        { header: 'Street', key: 'street', width: 18 },
      ];
      purchasesSheet.getRow(1).font = { bold: true };
      purchasesSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };

      // Sort orders newest-first (already that way from the query), then
      // within each order iterate items in insertion order.
      for (const order of orders) {
        const shipping = (order.shippingAddress ?? null) as ShippingAddressShape | null;
        const customerName = [
          order.customer?.firstName ?? shipping?.firstName ?? '',
          order.customer?.lastName ?? shipping?.lastName ?? '',
        ]
          .filter(Boolean)
          .join(' ');
        const email = order.customer?.email ?? shipping?.email ?? '';
        const phone = order.customer?.phone ?? shipping?.phone ?? '';
        const area = shipping?.area ?? shipping?.governorate ?? '';
        const city = shipping?.city ?? '';
        const country = shipping?.country ?? '';
        const block = shipping?.block ?? '';
        const street = shipping?.street ?? '';
        const payProvider = order.payments?.[0]?.provider ?? '';
        const payMethod = order.payments?.[0]?.method ?? '';

        for (const item of order.items) {
          purchasesSheet.addRow(
            neutralizeRowObject({
              storeName: store.name,
              customer: customerName,
              email,
              phone,
              orderNumber: order.orderNumber,
              orderDate: order.createdAt,
              orderStatus: order.status ?? '',
              paymentStatus: order.paymentStatus ?? '',
              payProvider,
              payMethod,
              product: item.productName,
              sku: item.sku ?? '',
              variant: item.variantName ?? '',
              qty: item.quantity,
              unitPrice: Number((item.price / 1000).toFixed(3)),
              lineTotal: Number((item.total / 1000).toFixed(3)),
              area,
              city,
              country,
              block,
              street,
            })
          );
        }
      }

      purchasesSheet.getColumn('unitPrice').numFmt = '0.000';
      purchasesSheet.getColumn('lineTotal').numFmt = '0.000';
      purchasesSheet.getColumn('orderDate').numFmt = 'yyyy-mm-dd';

      if (truncated) {
        const noticeRow = purchasesSheet.addRow({
          storeName: `NOTE: export truncated — only the most recent ${ordersScanned.toLocaleString()} orders were included.`,
        });
        noticeRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      // ----------------------------------------------------------------
      // "Summary" worksheet — top products + spend per customer.
      // Computed in-memory from the same line-items; no extra query.
      // ----------------------------------------------------------------
      const summarySheet = workbook.addWorksheet('Summary');

      // Aggregate products: sum qty + revenue (in fils, convert at write time).
      const productMap = new Map<string, { qty: number; revenue: number }>();
      for (const order of orders) {
        for (const item of order.items) {
          const existing = productMap.get(item.productName);
          if (existing) {
            existing.qty += item.quantity;
            existing.revenue += item.total;
          } else {
            productMap.set(item.productName, { qty: item.quantity, revenue: item.total });
          }
        }
      }
      const topProducts = Array.from(productMap.entries())
        .map(([product, { qty, revenue }]) => ({ product, qty, revenue }))
        .sort((a, b) => b.revenue - a.revenue);

      // Aggregate per-customer: distinct order count + total items + spend.
      interface CustomerSummary {
        name: string;
        email: string;
        orderIds: Set<string>;
        items: number;
        spend: number;
      }
      const customerSummaryMap = new Map<string, CustomerSummary>();
      for (const order of orders) {
        const shipping = (order.shippingAddress ?? null) as ShippingAddressShape | null;
        const customerName = [
          order.customer?.firstName ?? shipping?.firstName ?? '',
          order.customer?.lastName ?? shipping?.lastName ?? '',
        ]
          .filter(Boolean)
          .join(' ');
        const email = order.customer?.email ?? shipping?.email ?? '';
        const key =
          order.customer?.id || email.toLowerCase() || shipping?.phone || `guest:${order.id}`;
        const totalItemQty = order.items.reduce((s, i) => s + i.quantity, 0);
        const orderSpend = order.items.reduce((s, i) => s + i.total, 0);

        const existing = customerSummaryMap.get(key);
        if (existing) {
          existing.orderIds.add(order.id);
          existing.items += totalItemQty;
          existing.spend += orderSpend;
        } else {
          customerSummaryMap.set(key, {
            name: customerName,
            email,
            orderIds: new Set([order.id]),
            items: totalItemQty,
            spend: orderSpend,
          });
        }
      }
      const customerSpendRows = Array.from(customerSummaryMap.values())
        .map(({ name, email: customerEmail, orderIds, items, spend }) => ({
          name,
          email: customerEmail,
          orders: orderIds.size,
          items,
          spend,
        }))
        .sort((a, b) => b.spend - a.spend);

      // --- Write "TOP PRODUCTS" block ---
      const topProductsTitle = summarySheet.addRow(['TOP PRODUCTS']);
      topProductsTitle.getCell(1).font = { bold: true, size: 12 };
      summarySheet.addRow([]); // blank spacer
      const productsHeaderRow = summarySheet.addRow(['Product', 'Total Qty', 'Revenue (KWD)']);
      productsHeaderRow.font = { bold: true };
      productsHeaderRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };
      for (const p of topProducts) {
        summarySheet.addRow(
          neutralizeRowArray([p.product, p.qty, Number((p.revenue / 1000).toFixed(3))])
        );
      }

      summarySheet.addRow([]); // blank row between sections
      summarySheet.addRow([]); // extra spacer

      // --- Write "SPEND PER CUSTOMER" block ---
      const spendTitle = summarySheet.addRow(['SPEND PER CUSTOMER']);
      spendTitle.getCell(1).font = { bold: true, size: 12 };
      summarySheet.addRow([]); // blank spacer
      const spendHeaderRow = summarySheet.addRow([
        'Customer',
        'Email',
        'Orders',
        'Items',
        'Total Spent (KWD)',
      ]);
      spendHeaderRow.font = { bold: true };
      spendHeaderRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };
      for (const r of customerSpendRows) {
        summarySheet.addRow(
          neutralizeRowArray([
            r.name || r.email,
            r.email,
            r.orders,
            r.items,
            Number((r.spend / 1000).toFixed(3)),
          ])
        );
      }

      // Column widths for readability.
      summarySheet.getColumn(1).width = 36;
      summarySheet.getColumn(2).width = 30;
      summarySheet.getColumn(3).width = 10;
      summarySheet.getColumn(4).width = 10;
      summarySheet.getColumn(5).width = 18;

      if (truncated) {
        summarySheet.addRow([]);
        const noticeRow = summarySheet.addRow([
          `NOTE: export truncated — only the most recent ${ordersScanned.toLocaleString()} orders were included.`,
        ]);
        noticeRow.getCell(1).font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      const filenameSafe = (store.slug || store.name || 'customers').replace(/[^a-z0-9-]/gi, '-');
      const filename = `${filenameSafe}-customers-${new Date().toISOString().slice(0, 10)}.xlsx`;

      // Build the workbook into an in-memory buffer BEFORE touching the
      // response.  This bounds all DB work to the fast fetch+build window and
      // keeps the tenant tx off the slow client download that follows.
      // Using writeBuffer() here means the stream to the client carries no open
      // DB connection at all — a much safer pattern for large exports — and it
      // keeps this response on the BUFFERED lane of
      // middleware/request-transaction.ts (one `res.send`, no `res.write`), so
      // the tx COMMITS BEFORE the bytes go out rather than after.
      const xlsxBuffer = await workbook.xlsx.writeBuffer();

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', xlsxBuffer.byteLength);
      res.send(Buffer.from(xlsxBuffer));
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /stores/:storeId/customers?page=&perPage=&search=
 *
 * Server-side aggregated customers list. Replaces the admin page's previous
 * client-side "fetch page 1, then Promise.all over every remaining orders
 * page" fan-out (49+ concurrent requests on a large store). The aggregation
 * (incl. guest orders + cancelled/unpaid) happens here once, bounded by
 * `MAX_ORDERS_SCANNED`, and only the requested page of customers is returned.
 *
 * Response: { data, meta: { page, perPage, total, totalPages, truncated } }.
 */
router.get(
  '/customers',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      // Hard-cap perPage so a caller can't request an unbounded page.
      const perPage = Math.min(100, Math.max(1, Number(req.query.perPage ?? 20) || 20));
      const search = (req.query.search as string | undefined)?.trim().toLowerCase() ?? '';

      const { customers, truncated } = await aggregateCustomers(storeId);

      // Optional server-side filter so search is consistent across pages
      // (the old client-only search only matched the fetched page).
      const filtered = search
        ? customers.filter(
            c =>
              c.firstName.toLowerCase().includes(search) ||
              c.lastName.toLowerCase().includes(search) ||
              c.email.toLowerCase().includes(search) ||
              c.phone.toLowerCase().includes(search)
          )
        : customers;

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const start = (page - 1) * perPage;
      const pageItems = filtered.slice(start, start + perPage);

      // Double-wrapped on purpose: the admin `apiGet` helper unwraps one
      // `data` layer, so the inner `{ data, meta }` is what reaches the page.
      res.json({
        success: true,
        data: {
          data: pageItems,
          meta: { page, perPage, total, totalPages, truncated },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /stores/:storeId/customers/search?q=<query>
 *
 * Typeahead for the admin "New order" form. Matches both REGISTERED
 * customers (User rows with at least one order at this store) AND
 * GUEST customers (orders with customerId=null where the shipping
 * address JSON contains a matching firstName/lastName/email/phone).
 *
 * Returns up to 10 results merged + deduped. Ahmad 2026-05-16: the
 * customers PAGE shows both registered and guest — search must too,
 * so the admin can find phone-order customers from prior calls who
 * checked out as guests.
 */
router.get(
  '/customers/search',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const q = (req.query.q as string | undefined)?.trim();
      if (!q || q.length < 2) {
        res.json({ success: true, data: { customers: [] } });
        return;
      }

      // --- Registered customers (User table, joined via orders) ---
      const registeredOrders = await prisma.order.findMany({
        where: {
          storeId,
          customerId: { not: null },
          customer: {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
        select: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
            },
          },
        },
        distinct: ['customerId'],
        take: 10,
      });

      // Shape: { id (UUID), isGuest: false, firstName, lastName, email, phone }
      const registered = registeredOrders
        .map(o => o.customer)
        .filter((c): c is NonNullable<(typeof registeredOrders)[number]['customer']> => c !== null)
        .map(c => ({
          id: c.id,
          isGuest: false as const,
          firstName: c.firstName ?? '',
          lastName: c.lastName ?? '',
          email: c.email ?? '',
          phone: c.phone ?? '',
        }));

      // --- Guest customers (raw SQL: JSON ILIKE) ---
      // Prisma's JSON filter doesn't support partial-match (`contains`),
      // only exact `equals`. For guest typeahead we need ILIKE on
      // JSONB-extracted scalar fields, which is a `$queryRaw` job. The
      // result is deduped by lowercased email when present, falling
      // back to phone, then to order.id (each guest-order without
      // either becomes its own row — same as the customers list page).
      const like = `%${q}%`;
      const guestRows = await prisma.$queryRaw<
        Array<{
          first_name: string | null;
          last_name: string | null;
          email: string | null;
          phone: string | null;
          order_id: string;
        }>
      >`
        SELECT DISTINCT ON (
          COALESCE(LOWER(shipping_address->>'email'), shipping_address->>'phone', id::text)
        )
          shipping_address->>'firstName' AS first_name,
          shipping_address->>'lastName'  AS last_name,
          shipping_address->>'email'     AS email,
          shipping_address->>'phone'     AS phone,
          id::text AS order_id
        FROM public.orders
        WHERE store_id = ${storeId}::uuid
          AND customer_id IS NULL
          AND deleted_at IS NULL
          AND (
                shipping_address->>'firstName' ILIKE ${like}
             OR shipping_address->>'lastName'  ILIKE ${like}
             OR shipping_address->>'email'     ILIKE ${like}
             OR shipping_address->>'phone'     ILIKE ${like}
          )
        LIMIT 10
      `;

      const guests = guestRows.map(g => ({
        // Synthetic id — frontend treats this as guest (no customerId
        // sent on order create), pre-fills form fields from these
        // values. Matches the customer-detail polymorphic key pattern.
        id: g.email ? `guest:${g.email.toLowerCase()}` : `guest:${g.order_id}`,
        isGuest: true as const,
        firstName: g.first_name ?? '',
        lastName: g.last_name ?? '',
        email: g.email ?? '',
        phone: g.phone ?? '',
      }));

      // Merge + cap at 10. Registered customers ranked first because
      // they're more useful for repeat-order attribution.
      const customers = [...registered, ...guests].slice(0, 10);

      res.json({ success: true, data: { customers } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /stores/:storeId/customers/:customerKey
 * Returns a single customer's full profile + every order they've placed.
 *
 * `customerKey` is one of:
 *   - a User.id (UUID) for registered customers
 *   - a lowercased email for guest customers
 *   - a phone number for guest customers with no email
 *
 * The lookup mirrors the aggregation key logic in the page.tsx + the
 * XLSX export's aggregateCustomers() so a row clicked in the listing
 * always resolves cleanly.
 */
router.get(
  '/customers/:customerKey',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerKey } = req.params;
      const decodedKey = decodeURIComponent(customerKey);

      // UUID v4 detection — `Order.customerId` is a uuid string when
      // present. Guest keys are emails / phones / synthetic IDs.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        decodedKey
      );

      // Single query that handles both registered + guest in one OR.
      // For registered customers `customerId` matches directly; for
      // guests we fall back to the shipping address JSON path.
      // Avoiding a UUID-only first query keeps the type stable for
      // TypeScript's narrowing of the conditional include shape.
      const orConditions: Prisma.OrderWhereInput[] = [
        { shippingAddress: { path: ['email'], equals: decodedKey } },
        { shippingAddress: { path: ['phone'], equals: decodedKey } },
      ];
      if (isUuid) {
        orConditions.unshift({ customerId: decodedKey });
      }

      // Fetch one extra row (like `aggregateCustomers`' MAX_ORDERS_SCANNED
      // pattern above) to detect truncation without a separate count query.
      // Unlike the siblings, this query previously had NO `take` at all — a
      // customer with an unusually large order history could load its full
      // set of orders (each with items + payments) on every profile view.
      const fetchedOrders = await prisma.order.findMany({
        where: {
          storeId,
          deletedAt: null,
          OR: orConditions,
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
          const zeroOrderUser = await prisma.user.findFirst({
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
            res.json({
              success: true,
              data: {
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
                  groupId: null,
                  group: null,
                },
                orders: [],
                truncated: false,
              },
            });
            return;
          }
        }
        throw new AppError(404, 'NOT_FOUND', 'Customer not found');
      }

      const truncated = fetchedOrders.length > MAX_CUSTOMER_ORDERS;
      const orders = truncated ? fetchedOrders.slice(0, MAX_CUSTOMER_ORDERS) : fetchedOrders;

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

      for (const o of orders) {
        totalSpent += o.total;
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
        avgOrderValue: orders.length > 0 ? Math.round(totalSpent / orders.length) : 0,
        paidCount,
        pendingCount,
        cancelledCount,
        failedCount,
        refundedCount,
        totalRefunded,
        paymentMethods: Array.from(paymentMethodSet),
        statuses: Array.from(statusSet),
      };

      // Resolve the assigned group. Groups live on the `customers` table — a
      // separate, phone/email-keyed identity from the order's `users` row —
      // so we look it up by identifier (phone first, the primary GCC
      // identifier; email as fallback) rather than by the User id.
      const identityOr: Prisma.CustomerWhereInput[] = [];
      if (customer.phone) identityOr.push({ phone: customer.phone });
      if (customer.email)
        identityOr.push({ email: { equals: customer.email, mode: 'insensitive' } });
      let groupId: string | null = null;
      let group: { id: string; name: string; nameAr: string | null } | null = null;
      if (identityOr.length > 0) {
        const grouped = await prisma.customer.findFirst({
          where: { storeId, OR: identityOr },
          select: {
            groupId: true,
            group: { select: { id: true, name: true, nameAr: true } },
          },
        });
        if (grouped) {
          groupId = grouped.groupId;
          group = grouped.group;
        }
      }

      res.json({
        success: true,
        data: { customer: { ...customer, groupId, group }, orders, truncated },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Owner/admin-only — merchants act as data controllers and must be able to
// fulfil a shopper's erasure/export request themselves, not only the shopper.
// `staff` is deliberately excluded (destructive + full-PII-export action).
const privacyMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  rejectImpersonated,
  writeLimiter,
];

const CUSTOMER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `:customerId` to a User row that (a) exists, (b) is a `customer`
 * role account (never an admin/staff row — `eraseAccount`/`exportAccount`
 * refuse those anyway, but we want a clean 404 before calling them), and
 * (c) belongs to THIS store. Every one of those three failure modes
 * returns the SAME generic 404 — a merchant must never be able to
 * distinguish "no such id", "that id is staff", and "that id belongs to
 * another store" from the response, which would let them enumerate ids
 * across tenants by probing this endpoint. This is the single most
 * important property of both routes below: a merchant can only ever act
 * on a shopper that belongs to its own store.
 */
export async function resolveStoreCustomerOrThrow(storeId: string, customerId: string) {
  if (!CUSTOMER_ID_RE.test(customerId)) {
    throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  }
  const user = await prisma.user.findUnique({
    where: { id: customerId },
    select: { id: true, storeId: true, role: true },
  });
  if (!user || user.role !== 'customer' || user.storeId !== storeId) {
    throw new AppError(404, 'NOT_FOUND', 'Customer not found');
  }
  return user;
}

/**
 * POST /stores/:storeId/customers/:customerId/erase
 *
 * Merchant-initiated right-to-erasure. Merchants are the data controller
 * for their own shoppers and must be able to fulfil a data-subject erasure
 * request even when the shopper doesn't use the storefront self-service
 * flow themselves (`POST /auth/me/erase`). Reuses `AuthService.eraseAccount`
 * — the SAME anonymization used by the shopper self-service path and the
 * `soft-deleted-user-anonymize` retention cron — so there is exactly one
 * implementation of "what erasure means" in this codebase (see
 * docs/RETENTION.md). Idempotent (eraseAccount already is).
 */
router.post(
  '/customers/:customerId/erase',
  ...privacyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      await resolveStoreCustomerOrThrow(storeId, customerId);

      // A store deletes ONLY its own data (owner decision, Ruling W-7).
      await AuthService.eraseAccount(customerId, {
        scopeStoreId: storeId,
        actorId: req.user!.userId,
      });

      await auditLog({
        action: 'customer.account.erased_by_merchant',
        userId: req.user!.userId,
        storeId,
        resourceType: 'user',
        resourceId: customerId,
        details: { actorRole: req.user!.role },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Deferred (not a bare `invalidateCustomersCache(storeId)`): this route
      // runs inside the request's tenant transaction, which commits AFTER the
      // handler returns (request-transaction.ts). Busting the cache here would
      // let a GET /customers racing the still-open transaction re-cache the
      // pre-erasure PII for the full 300s TTL. `deferAfterTenantCommit` fires
      // it after COMMIT instead — same mechanism AuthService.eraseAccount
      // already uses for its Inngest send.
      void deferAfterTenantCommit('customers.erase.invalidateCache', () =>
        invalidateCustomersCache(storeId)
      ).catch(err =>
        logger.warn({ err, storeId, customerId }, '[customers.erase] cache invalidation failed')
      );

      res.json({ success: true, data: { message: 'Customer data erased' } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /stores/:storeId/customers/:customerId/export
 *
 * Merchant-initiated data export — the same JSON bundle shape as the
 * shopper self-service `GET /auth/me/export`, reusing
 * `AuthService.exportAccount` for the same "one implementation" reason as
 * erase above.
 */
router.get(
  '/customers/:customerId/export',
  ...privacyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, customerId } = req.params;
      await resolveStoreCustomerOrThrow(storeId, customerId);

      const bundle = await AuthService.exportAccount(customerId);

      await auditLog({
        action: 'customer.data.exported_by_merchant',
        userId: req.user!.userId,
        storeId,
        resourceType: 'user',
        resourceId: customerId,
        details: { actorRole: req.user!.role },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const today = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="customer-${customerId}-${today}.json"`
      );
      res.send(JSON.stringify(bundle, null, 2));
    } catch (error) {
      next(error);
    }
  }
);

export default router;
