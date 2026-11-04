import { Router, Request, Response, NextFunction } from 'express';
import { customerAuthRoute } from '../lib/customer-auth';
import type ExcelJS from 'exceljs';
import { loadExcelJS } from '../lib/lazy-modules';
import {
  neutralizeRowObject,
  neutralizeRowArray,
  addFiltersSheet,
  summarizeExportFilters,
} from '../lib/exports/xlsx';
import { prisma, type RfmSegment } from '@ebda/database';
import { storeDb } from '../lib/repo-factory';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requirePermission } from '../middleware/rbac';
import { AppError } from '../middleware/error-handler';
import { writeLimiter, auditLog } from '../middleware/security';
import { invalidateCustomersCache } from '../lib/public-cache';
import { customerKeyOf } from '../lib/customer-key';
import { searchTermOf } from '../lib/search-term';
import { SmsConsentService } from '../services/sms-consent.service';
import {
  aggregateCustomers,
  aggregateCustomersMatching,
  MAX_ZERO_ORDER_CUSTOMERS,
  getCustomerProfile,
  filterCustomersBySegment,
  parseSegmentFilter,
  presentRfmSegments,
  segmentsForCustomers,
  type ShippingAddressShape,
} from '../services/customer-aggregate.service';
import { AuthService, eraseNeedsCrmReview } from '../services/auth.service';
import { searchOrderCustomers } from '../services/customer-search.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import logger from '../lib/logger';
import { BRAND } from '@ebda/shared';

import { minorToDecimalString, excelMoneyFormat } from '@ebda/shared';
const router = Router({ mergeParams: true });

// The aggregation itself (grouping, KPI summary, segment parsing, the detail
// profile) lives in `services/customer-aggregate.service.ts`, shared with the
// merchant MCP tools. `summarizeCustomers` / `parseSegmentFilter` are
// re-exported for existing importers of this module.
export { summarizeCustomers, parseSegmentFilter } from '../services/customer-aggregate.service';
export type { CustomersSummary } from '../services/customer-aggregate.service';

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
/** BE:S-30: how deep a staff member can page the customer list (the owner is not capped). */
export const STAFF_LIST_MAX_ROWS = 500;

const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
];

/**
 * The search term: the `X-Search-Query` header (clients send it there so a typed phone/email stays
 * out of the URL, Ruling SEARCH-P2-9), else the deprecated `?search=`. Trimmed, bounded (it reaches
 * a SECURITY DEFINER lookup), '' when absent.
 */
function searchTerm(req: Request, res: Response): string {
  return searchTermOf(req, res, 'search') ?? '';
}

/**
 * The list's segment filter (the text search is resolved in SQL by `aggregateCustomersMatching`), applied the SAME way by the list and
 * by the export (owner report 2026-09-30: the export button ignored the
 * filters on screen and always downloaded every customer). Segment filtering
 * is admin-only — staff get a 403, matching `rfm-batch`.
 */
async function applyCustomerListFilters(
  req: Request,
  storeId: string,
  customers: Awaited<ReturnType<typeof aggregateCustomers>>['customers']
) {
  const segment = parseSegmentFilter(req.query.segment);

  // RFM segments are analytics that `rfm-batch` serves to store_admin /
  // super_admin only. Filtering by one here would let `staff` (who can
  // read this list) enumerate segment membership, so keep the same line.
  if (segment && segment !== 'guest' && req.user?.role === 'staff') {
    throw new AppError(403, 'FORBIDDEN', 'Segment filtering requires a store admin');
  }

  // Segment filter runs server-side, over the whole aggregated set, so the
  // total + pagination reflect the segment rather than one page of it.
  // It reads only that segment's members (issue 2243).
  const bySegment =
    segment === 'guest'
      ? customers.filter(c => c.isGuest)
      : segment
        ? await filterCustomersBySegment(storeId, customers, segment)
        : customers;

  // The text search is NOT applied here: it is resolved in SQL (`aggregateCustomersMatching`,
  // Arabic-normalised names, any phone form, email), so it also finds customers beyond the
  // aggregate's order-scan cap. This only narrows by segment.
  return bySegment;
}

/**
 * GET /stores/:storeId/customers/export.xlsx
 * Streams an .xlsx workbook of the customers aggregated from order history,
 * narrowed by the same `search` / `segment` query the list takes — the admin
 * customers page's "Export" button sends whatever filters are on screen.
 */
router.get(
  '/customers/export.xlsx',
  ...adminMiddleware,
  // SEC-14: a bulk dump of every customer's PII is an owner action, not a staff one.
  requirePermission('customers:export'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { name: true, slug: true },
      });
      if (!store) {
        throw new AppError(404, 'NOT_FOUND', 'Store not found');
      }

      const aggregated = searchTerm(req, res)
        ? await aggregateCustomersMatching(storeId, searchTerm(req, res))
        : await aggregateCustomers(storeId);
      const { ordersTruncated, zeroOrderTruncated, ordersScanned } = aggregated;
      const customers = await applyCustomerListFilters(req, storeId, aggregated.customers);
      // The Purchases / Summary sheets follow the same filter: only the orders
      // of the customers exported. A row's id IS its `customerKeyOf` key
      // (customer-aggregate.service), so the same key selects its orders.
      const exportedIds = new Set(customers.map(c => c.id));
      const orders =
        customers.length === aggregated.customers.length
          ? aggregated.orders
          : aggregated.orders.filter(o => exportedIds.has(customerKeyOf(o) ?? `guest:${o.id}`));

      const workbook = new (await loadExcelJS()).Workbook();
      workbook.creator = BRAND.product.nameEn;
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
        { header: 'Total Spent (EGP)', key: 'totalSpent', width: 18 },
        { header: 'Avg Order Value (EGP)', key: 'avgOrderValue', width: 20 },
        { header: 'Last Order #', key: 'lastOrderNumber', width: 22 },
        { header: 'Last Order (EGP)', key: 'lastOrderTotal', width: 18 },
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
            // Convert piastres → EGP with 2 decimals so the cell is numeric and
            // sortable in Excel rather than a formatted string.
            totalSpent: Number(minorToDecimalString(c.totalSpent)),
            avgOrderValue: Number(minorToDecimalString(c.avgOrderValue)),
            lastOrderNumber: c.lastOrderNumber,
            lastOrderTotal: Number(minorToDecimalString(c.lastOrderTotal)),
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
      if (ordersTruncated) {
        const noticeRow = sheet.addRow({
          storeName: `NOTE: export truncated — only the most recent ${ordersScanned.toLocaleString('en-US')} orders were aggregated. Contact support for a full export of larger stores.`,
        });
        noticeRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }
      if (zeroOrderTruncated) {
        const noticeRow = sheet.addRow({
          storeName: `NOTE: export truncated — only the newest ${MAX_ZERO_ORDER_CUSTOMERS.toLocaleString('en-US')} registered customers who have not ordered yet are included.`,
        });
        noticeRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      // Format the date + currency columns. Excel's "major" doesn't have a
      // built-in symbol, so we use a numeric format with 2 decimals.
      sheet.getColumn('totalSpent').numFmt = excelMoneyFormat();
      sheet.getColumn('avgOrderValue').numFmt = excelMoneyFormat();
      sheet.getColumn('lastOrderTotal').numFmt = excelMoneyFormat();
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
        { header: 'Unit Price (EGP)', key: 'unitPrice', width: 18 },
        { header: 'Line Total (EGP)', key: 'lineTotal', width: 18 },
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
              unitPrice: Number(minorToDecimalString(item.price)),
              lineTotal: Number(minorToDecimalString(item.total)),
              area,
              city,
              country,
              block,
              street,
            })
          );
        }
      }

      purchasesSheet.getColumn('unitPrice').numFmt = excelMoneyFormat();
      purchasesSheet.getColumn('lineTotal').numFmt = excelMoneyFormat();
      purchasesSheet.getColumn('orderDate').numFmt = 'yyyy-mm-dd';

      if (ordersTruncated) {
        const noticeRow = purchasesSheet.addRow({
          storeName: `NOTE: export truncated — only the most recent ${ordersScanned.toLocaleString('en-US')} orders were included.`,
        });
        noticeRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      // ----------------------------------------------------------------
      // "Summary" worksheet — top products + spend per customer.
      // Computed in-memory from the same line-items; no extra query.
      // ----------------------------------------------------------------
      const summarySheet = workbook.addWorksheet('Summary');

      // Aggregate products: sum qty + revenue (in piastres, convert at write time).
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
        // Same grouping as the Customers sheet and the RFM rollup.
        const key = customerKeyOf(order) ?? `guest:${order.id}`;
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
      const productsHeaderRow = summarySheet.addRow(['Product', 'Total Qty', 'Revenue (EGP)']);
      productsHeaderRow.font = { bold: true };
      productsHeaderRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };
      for (const p of topProducts) {
        summarySheet.addRow(
          neutralizeRowArray([p.product, p.qty, Number(minorToDecimalString(p.revenue))])
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
        'Total Spent (EGP)',
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
            Number(minorToDecimalString(r.spend)),
          ])
        );
      }

      // Column widths for readability.
      summarySheet.getColumn(1).width = 36;
      summarySheet.getColumn(2).width = 30;
      summarySheet.getColumn(3).width = 10;
      summarySheet.getColumn(4).width = 10;
      summarySheet.getColumn(5).width = 18;

      if (ordersTruncated || zeroOrderTruncated) {
        summarySheet.addRow([]);
        const noticeRow = summarySheet.addRow([
          ordersTruncated
            ? `NOTE: export truncated — only the most recent ${ordersScanned.toLocaleString('en-US')} orders were included.`
            : `NOTE: export truncated — only the newest ${MAX_ZERO_ORDER_CUSTOMERS.toLocaleString('en-US')} registered customers who have not ordered yet are included.`,
        ]);
        noticeRow.getCell(1).font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      const appliedSearch = searchTerm(req, res) || undefined;
      const appliedSegment = parseSegmentFilter(req.query.segment) ?? undefined;
      addFiltersSheet(
        workbook,
        summarizeExportFilters([
          ['Segment', appliedSegment],
          ['Search', appliedSearch],
        ])
      );

      const filenameSafe = (store.slug || store.name || 'customers').replace(/[^a-z0-9-]/gi, '-');
      const filename = `${filenameSafe}-customers${appliedSegment ? `-${appliedSegment}` : ''}${
        appliedSearch ? '-search' : ''
      }-${new Date().toISOString().slice(0, 10)}.xlsx`;

      // Build the workbook into an in-memory buffer BEFORE touching the
      // response.  This bounds all DB work to the fast fetch+build window and
      // keeps the tenant tx off the slow client download that follows.
      // Using writeBuffer() here means the stream to the client carries no open
      // DB connection at all — a much safer pattern for large exports — and it
      // keeps this response on the BUFFERED lane of
      // middleware/request-transaction.ts (one `res.send`, no `res.write`), so
      // the tx COMMITS BEFORE the bytes go out rather than after.
      const xlsxBuffer = await workbook.xlsx.writeBuffer();

      await auditLog({
        action: 'customers.exported',
        userId: req.user!.userId,
        storeId,
        resourceType: 'customer_export',
        details: {
          actorRole: req.user!.role,
          impersonatedBy: req.user!.impersonatedBy ?? null,
          rows: customers.length,
          filtered: Boolean(req.query.search || req.query.segment),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

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
 * GET /stores/:storeId/customers?page=&perPage=&search=&segment=
 *
 * Server-side aggregated customers list. Replaces the admin page's previous
 * client-side "fetch page 1, then Promise.all over every remaining orders
 * page" fan-out (49+ concurrent requests on a large store). The aggregation
 * (incl. guest orders + cancelled/unpaid) happens here once, bounded by
 * `MAX_ORDERS_SCANNED`, and only the requested page of customers is returned.
 *
 * `segment` (optional): an RFM segment (`vip`, `loyal`, `potential`,
 * `new_customer`, `at_risk`, `hibernating`, `lost`) or `guest`. An unknown
 * value is ignored (the unfiltered list), never a 400, so an old bookmark
 * with a retired segment still loads.
 *
 * Response: { data, meta: { page, perPage, total, totalPages, truncated, searchTruncated,
 * summary, segments } } — `summary` is the store-wide KPI strip
 * (`CustomersSummary`); `segments` lists the RFM segments present in the
 * store, and each row carries `segment` (null = no snapshot). Both are
 * omitted for `staff`.
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
      // BE:S-30 / D9: staff keep read access (order context), but cannot page through the whole PII list: they reach at most the
      // first STAFF_LIST_MAX_ROWS rows of a view and must search to find anyone beyond it. Every staff list read leaves an audit row.
      if (req.user?.role === 'staff') {
        if (page * perPage > STAFF_LIST_MAX_ROWS)
          throw new AppError(
            400,
            'PAGE_LIMIT_EXCEEDED',
            `Staff can browse the first ${STAFF_LIST_MAX_ROWS} customers; search to find a specific one`
          );
        await auditLog({
          action: 'customers.list_viewed',
          userId: req.user.userId,
          storeId,
          resourceType: 'store',
          resourceId: storeId,
          details: { page, perPage, searched: Boolean(searchTerm(req, res)) },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      // The KPI strip and the truncation notice describe the whole store (cached aggregate); a
      // search replaces only the rows (SQL match, see `aggregateCustomersMatching`).
      const { customers: allCustomers, truncated, summary } = await aggregateCustomers(storeId);
      const term = searchTerm(req, res);
      const matched = term ? await aggregateCustomersMatching(storeId, term) : null;
      const customers = matched ? matched.customers : allCustomers;
      // The match itself hit its cap (1,000 registered / 20,000 guest orders): the rows are the
      // first of more, and the page says so (Task 16 review M5).
      const searchTruncated = matched?.searchTruncated ?? false;

      // A guest's snapshot is keyed by the HASH of the same key this list
      // groups by (`lib/customer-key.ts`), so guests resolve too — before,
      // RFM keyed guests by hash(email:phone) and this filter could only
      // ever match registered shoppers (analytics audit §4). Staff never
      // receive segments (applyCustomerListFilters 403s them).
      const canSeeSegments = req.user?.role !== 'staff';
      const filtered = await applyCustomerListFilters(req, storeId, customers);

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const start = (page - 1) * perPage;
      const pageSlice = filtered.slice(start, start + perPage);
      // Segment per row — for this page's rows only.
      const segmentOf = canSeeSegments
        ? await segmentsForCustomers(storeId, pageSlice)
        : new Map<string, RfmSegment>();
      // SMS-marketing consent per row (issue 206) — this page's rows only,
      // read live (never from the cached aggregate) so a withdrawal shows at once.
      // Each row's key AND phone, the same rows the send gate matches (issue 2423).
      const smsConsentOf = await SmsConsentService.statusForKeys(
        storeId,
        pageSlice.map(c => ({ key: c.id, phone: c.phone }))
      );
      const pageItems = pageSlice.map(c => {
        const smsMarketingConsent = smsConsentOf.get(c.id) ?? 'none';
        return canSeeSegments
          ? { ...c, segment: segmentOf.get(c.id) ?? null, smsMarketingConsent }
          : { ...c, smsMarketingConsent };
      });
      // Segments present anywhere in the store (not just this page) — the
      // page's filter pills. Canonical order; omitted for staff.
      const segments = canSeeSegments ? await presentRfmSegments(storeId) : undefined;

      // Double-wrapped on purpose: the admin `apiGet` helper unwraps one
      // `data` layer, so the inner `{ data, meta }` is what reaches the page.
      res.json({
        success: true,
        data: {
          data: pageItems,
          // `summary` is store-wide (unaffected by page/search/segment).
          meta: {
            page,
            perPage,
            total,
            totalPages,
            truncated,
            searchTruncated,
            summary,
            segments,
          },
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
  requirePermission('orders:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Bounded like the storefront suggest route: an unbounded ILIKE pattern would reach the
      // SECURITY DEFINER lookup (review M-4).
      const q = searchTermOf(req, res, 'q');
      if (!q || q.length < 2) {
        res.json({ success: true, data: { customers: [] } });
        return;
      }

      const customers = await searchOrderCustomers(storeId, q);

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
      const profile = await getCustomerProfile(storeId, decodeURIComponent(customerKey));
      res.json({ success: true, data: profile });
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
  // N-9: a customer of a store served by its StoreDO is that DO's.
  const route = await customerAuthRoute(storeId, { write: false });
  if (route.kind === 'do') {
    const u = await route.client.call<unknown | null>('getProfile', { userId: customerId });
    if (!u) throw new AppError(404, 'NOT_FOUND', 'Customer not found');
    return { id: customerId, storeId, role: 'customer' as const };
  }
  const user = await prisma.user.findUnique({
    where: { id: customerId, storeId },
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
      const outcome = await AuthService.eraseAccount(customerId, {
        scopeStoreId: storeId,
        actorId: req.user!.userId,
        storeHint: storeId,
      });
      // #1880: the CRM copy is matched by email/phone and can be missed or
      // refused as ambiguous. Record what happened so a partial erasure is
      // queryable in the audit log, and tell the admin UI so it does not show
      // an unqualified success.
      const crmReviewNeeded = eraseNeedsCrmReview(outcome);

      await auditLog({
        action: 'customer.account.erased_by_merchant',
        userId: req.user!.userId,
        storeId,
        resourceType: 'user',
        resourceId: customerId,
        details: { actorRole: req.user!.role, ...outcome, crmReviewNeeded },
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

      res.json({
        success: true,
        data: { message: 'Customer data erased', ...outcome, crmReviewNeeded },
      });
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

      const bundle = await AuthService.exportAccount(customerId, storeId);

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
