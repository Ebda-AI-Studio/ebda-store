import { readAuditByResource } from '../lib/audit-read';
import { Router, Request, Response, NextFunction } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod/v3';
import { queryWithSearchHeader } from '../lib/search-term';
import type ExcelJS from 'exceljs';
import { loadExcelJS } from '../lib/lazy-modules';
import {
  neutralizeRowObject,
  addFiltersSheet,
  describeRange,
  summarizeExportFilters,
} from '../lib/exports/xlsx';
import { authenticate, authorize, customerUserId, rejectImpersonated } from '../middleware/auth';
import {
  ANONYMOUS_BUYER,
  buyerFromRequest,
  buyerFromMerchantShopperSelection,
} from '../lib/buyer-identity';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { requireCustomerStoreMatch } from '../middleware/customer-store-match';
import { requireFeature } from '../middleware/feature-gate';
import {
  OrderService,
  assertValidTransition,
  type OrderListWhere,
} from '../services/order.service';
import {
  parseOrderListFilters as parseSharedOrderFilters,
  exportFilename,
  dayInOffset,
  parseTzOffset,
  minorToDecimalString,
  excelMoneyFormat,
  BRAND,
  storefrontOrigin,
} from '@ebda/shared';
import { COUPON_OVERRIDE_AUDIT_ACTION } from '../lib/coupon-override';

const ORDER_SHIPPING_OVERRIDE_AUDIT_ACTION = 'order.shipping_override';
/** Audit actions that exist for the merchant only; the customer timeline skips them (BE:S-26). */
const CUSTOMER_HIDDEN_AUDIT_ACTIONS = new Set<string>([
  COUPON_OVERRIDE_AUDIT_ACTION,
  'order.moq_override',
  ORDER_SHIPPING_OVERRIDE_AUDIT_ACTION,
]);
import { InvoiceService } from '../services/invoice.service';
import { hasPermission, requirePermission, type Role } from '../middleware/rbac';
import { hasCapturedPayment } from '../services/order-refund-gating';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { prisma } from '@ebda/database';
import { inngest } from '../lib/inngest/client';
import { invoiceRecipient, queueInvoiceEmail } from '../services/order-invoice-email.service';
import logger from '../lib/logger';
import { PaymentService } from '../services/payment-providers/payment.factory';
import {
  settleRefundEvent,
  matchRefundToClaim,
  inSettlementTx,
} from '../services/payment-providers/refund-settle';
import { recordPaymentEvent, recordPaymentEventForStore } from '../services/payment-event.service';
import { storeDb, storeMoney } from '../lib/repo-factory';
import { listAuditWithActors } from '../lib/audit-actors';
import { InstapayService } from '../services/payment-providers/instapay.service';
import { InstapayReceiptService } from '../services/payment-providers/instapay-receipt.service';
import multer from 'multer';
import { INSTAPAY_RECEIPT_MAX_BYTES, instapayRefundRecordSchema } from '@ebda/shared';
import { confirmPaymentFromProviderStatus } from '../services/payment-confirm.service';

import { config } from '../config';
import type { Currency, PaymentProvider } from '../services/payment-providers/types';
import { AppError } from '../middleware/error-handler';
import { idempotencyKeyOf, withIdempotencyKey } from '../lib/money-idempotency';
import { ReturnService, REFUND_METHODS } from '../services/return.service';
import { refundMayHaveExecuted } from '../services/payment-providers/refund-outcome';
import {
  lookupRefundTarget,
  refundThroughProvider,
} from '../services/order-provider-refund.service';
import { buildPaymentLineItems } from '../lib/payment-line-items';
import {
  resolveRefundSettlement,
  readAccountedRefundEventIds,
  appendRefundEventId,
  recordRefundStatus,
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
} from '../services/payment-providers/refund-settlement';
import { rangeOrLegacyDays } from '../lib/report-range';
import { paymentWebhookUrl } from '../services/payment-providers/webhook-url';
import { redactOrderForCustomer } from '../services/gold-rate/public';
import { customersById, runInStoreCtx } from '../lib/jobs/store-db';

const router = Router({ mergeParams: true });

// ==========================================
// XLSX Export
// ==========================================

/**
 * Hard cap on the number of orders scanned for the export. Mirrors the
 * customers export cap so both endpoints share the same memory budget.
 * 20k orders × 2 sheets is well within a single request's limits for
 * the overwhelming majority of stores.
 */
const MAX_ORDERS_SCANNED = 20_000;

/**
 * Parses the order list's filters — the list AND its XLSX export read them
 * through here, so the export is what the list shows.
 *
 * Date range: the shared report-range contract (`startDate`/`endDate`, ISO
 * instants resolved in the viewer's timezone). The legacy date-only
 * `from`/`to` pair stays accepted for older callers; it is read as a whole
 * UTC day, which is why the admin no longer sends it (an Egypt
 * merchant's "today" started 3 hours late). Returns null after a 422.
 */
function parseOrderListFilters(
  req: Request,
  res: Response
): Pick<OrderListWhere, 'status' | 'paymentStatus' | 'from' | 'to' | 'search'> | null {
  const parsed = parseSharedOrderFilters(queryWithSearchHeader(req, res));
  if (!parsed.ok) {
    res.status(422).json({
      success: false,
      error: {
        code: 'validation_failed',
        message: 'Invalid order filters.',
        details: parsed.error.flatten(),
      },
    });
    return null;
  }
  const { status, paymentStatus, search } = parsed.filters;
  // Contract range first, legacy date-only pair second. `parseSharedOrderFilters`
  // already rejected a malformed contract range, so this cannot fail here.
  const { from, to } = rangeOrLegacyDays(req.query as Record<string, unknown>) as {
    from?: Date;
    to?: Date;
  };
  return {
    status,
    paymentStatus,
    from,
    to,
    search,
  };
}

/** Admin-only middleware chain for store-scoped read endpoints. */
const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
];

interface ShippingAddressShape {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  governorate?: string;
  governorateAr?: string;
  area?: string;
  areaAr?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  block?: string;
  street?: string;
}

/**
 * GET /stores/:storeId/orders/export.xlsx
 *
 * Streams a two-sheet .xlsx workbook:
 *   - "Orders"     — one row per order (newest first)
 *   - "Line Items" — one row per order item
 *
 * Scoped strictly to the store (tenant-safe). Capped at MAX_ORDERS_SCANNED
 * to protect against OOM on very large stores; a NOTE row is appended when
 * the cap is hit. Auth: same adminMiddleware chain as the rest of the order
 * routes (store_admin / super_admin / staff + requireStoreAccess).
 */
router.get(
  '/export.xlsx',
  ...adminMiddleware,
  requirePermission('orders:read'),
  // SEC-14: the order sheet carries every customer's name, phone and address.
  requirePermission('customers:export'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const db = await storeDb(storeId);

      const store = await db.store.findUnique({
        where: { id: storeId },
        select: { name: true, slug: true },
      });
      if (!store) {
        throw new AppError(404, 'NOT_FOUND', 'Store not found');
      }
      // Same filters as the list on screen (status, date range, search).
      const filters = parseOrderListFilters(req, res);
      if (!filters) return;

      // Fetch up to cap+1 to detect truncation. Include items + first payment
      // for the Line Items sheet and the payment provider/method columns.
      const fetched = await db.order.findMany({
        where: await OrderService.listWhere(storeId, filters),
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          subtotal: true,
          tax: true,
          shipping: true,
          discount: true,
          couponDiscount: true,
          promotionDiscount: true,
          loyaltyDiscount: true,
          taxIncludedInPrice: true,
          total: true,
          currency: true,
          couponCode: true,
          appliedPromotion: { select: { name: true } },
          customerNotes: true,
          shippingAddress: true,
          createdAt: true,
          customerId: true,
          payments: {
            select: { provider: true, method: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
          items: {
            select: {
              productName: true,
              sku: true,
              variantName: true,
              quantity: true,
              price: true,
              costPrice: true,
              total: true,
              // Arabic name is not snapshotted on the line item — pull it from
              // the (current) product. Null when the product was since deleted.
              product: { select: { nameAr: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_ORDERS_SCANNED + 1,
      });
      const truncated = fetched.length > MAX_ORDERS_SCANNED;
      const orders = truncated ? fetched.slice(0, MAX_ORDERS_SCANNED) : fetched;
      // `Order.customer` is a join into the platform database, which a Durable Object cannot do: attach the shoppers beside the rows.
      const shoppers = await customersById(
        storeId,
        orders.map(o => o.customerId)
      );

      // ---- Build workbook ----
      const workbook = new (await loadExcelJS()).Workbook();
      workbook.creator = BRAND.product.nameEn;
      workbook.created = new Date();

      const headerStyle: Partial<ExcelJS.Style> = {
        font: { bold: true },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } },
      };

      // ---- Sheet 1: Orders ----
      const ordersSheet = workbook.addWorksheet('Orders');
      ordersSheet.columns = [
        { header: 'Store Name', key: 'storeName', width: 22 },
        { header: 'Order #', key: 'orderNumber', width: 22 },
        { header: 'Order Date', key: 'orderDate', width: 18 },
        { header: 'Customer', key: 'customer', width: 24 },
        { header: 'Email', key: 'email', width: 28 },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Payment Status', key: 'paymentStatus', width: 16 },
        { header: 'Pay Provider', key: 'payProvider', width: 16 },
        { header: 'Pay Method', key: 'payMethod', width: 16 },
        { header: 'Items', key: 'itemCount', width: 8 },
        { header: 'Subtotal (EGP)', key: 'subtotal', width: 16 },
        { header: 'Discount (EGP)', key: 'discount', width: 16 },
        { header: 'Coupon', key: 'coupon', width: 14 },
        { header: 'Promotion', key: 'promotion', width: 18 },
        // Loyalty points' share of Discount (issue 2239) — invisible before.
        { header: 'Loyalty Discount (EGP)', key: 'loyaltyDiscount', width: 20 },
        { header: 'Shipping (EGP)', key: 'shipping', width: 16 },
        { header: 'Tax (EGP)', key: 'tax', width: 12 },
        // Issue 2168: for an inclusive order Tax is INSIDE Total, so
        // Subtotal − Discount + Shipping + Tax ≠ Total. This column says which
        // formula reconciles the row.
        { header: 'Tax Included In Price', key: 'taxIncluded', width: 20 },
        { header: 'Total (EGP)', key: 'total', width: 14 },
        { header: 'Area', key: 'area', width: 18 },
        { header: 'City', key: 'city', width: 16 },
        { header: 'Country', key: 'country', width: 14 },
        { header: 'Block', key: 'block', width: 10 },
        { header: 'Street', key: 'street', width: 16 },
        { header: 'Customer Notes', key: 'customerNotes', width: 30 },
      ];

      // Bold + shaded header row
      const ordersHeader = ordersSheet.getRow(1);
      ordersHeader.font = headerStyle.font as ExcelJS.Font;
      ordersHeader.fill = headerStyle.fill as ExcelJS.Fill;

      // ---- Sheet 2: Line Items ----
      const itemsSheet = workbook.addWorksheet('Line Items');
      itemsSheet.columns = [
        { header: 'Store Name', key: 'storeName', width: 22 },
        { header: 'Order #', key: 'orderNumber', width: 22 },
        { header: 'Order Date', key: 'orderDate', width: 18 },
        { header: 'Customer', key: 'customer', width: 24 },
        { header: 'Email', key: 'email', width: 28 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Payment Status', key: 'paymentStatus', width: 16 },
        { header: 'Product', key: 'product', width: 28 },
        { header: 'Product (AR)', key: 'productAr', width: 28 },
        { header: 'SKU', key: 'sku', width: 16 },
        { header: 'Variant', key: 'variant', width: 20 },
        { header: 'Qty', key: 'qty', width: 8 },
        { header: 'Unit Price (EGP)', key: 'unitPrice', width: 18 },
        { header: 'Cost Price (EGP)', key: 'costPrice', width: 18 },
        { header: 'Line Total (EGP)', key: 'lineTotal', width: 18 },
      ];

      const itemsHeader = itemsSheet.getRow(1);
      itemsHeader.font = headerStyle.font as ExcelJS.Font;
      itemsHeader.fill = headerStyle.fill as ExcelJS.Fill;

      const storeName = store.name ?? '';

      for (const order of orders) {
        const addr = (order.shippingAddress ?? null) as ShippingAddressShape | null;
        const buyer = shoppers.get(order.customerId ?? '');
        const firstName = buyer?.firstName ?? addr?.firstName ?? '';
        const lastName = buyer?.lastName ?? addr?.lastName ?? '';
        const customerName = `${firstName} ${lastName}`.trim();
        const email = buyer?.email ?? addr?.email ?? '';
        const phone = buyer?.phone ?? addr?.phone ?? '';
        const payment = order.payments?.[0];

        // Orders sheet row
        ordersSheet.addRow(
          neutralizeRowObject({
            storeName,
            orderNumber: order.orderNumber,
            orderDate: order.createdAt,
            customer: customerName,
            email,
            phone,
            status: order.status ?? '',
            paymentStatus: order.paymentStatus ?? '',
            payProvider: payment?.provider ?? '',
            payMethod: payment?.method ?? '',
            itemCount: order.items?.length ?? 0,
            subtotal: Number(minorToDecimalString(order.subtotal)),
            // `order.discount` is already the AUTHORITATIVE total (coupon/
            // promotion + loyalty combined) — adding couponDiscount on top
            // double-counted it. See order.service.ts's create() comment on
            // couponDiscount + promotionDiscount + loyaltyDiscount reconciling
            // to `discount`.
            discount: Number(minorToDecimalString(order.discount)),
            coupon: order.couponCode ?? '',
            promotion: order.appliedPromotion?.name ?? '',
            loyaltyDiscount: Number(minorToDecimalString(order.loyaltyDiscount)),
            shipping: Number(minorToDecimalString(order.shipping)),
            tax: Number(minorToDecimalString(order.tax)),
            taxIncluded: order.taxIncludedInPrice ? 'Yes' : 'No',
            total: Number(minorToDecimalString(order.total)),
            area: addr?.area ?? addr?.state ?? '',
            city: addr?.city ?? '',
            country: addr?.country ?? '',
            block: addr?.block ?? '',
            street: addr?.street ?? '',
            customerNotes: order.customerNotes ?? '',
          })
        );

        // Line Items sheet — one row per item
        for (const item of order.items ?? []) {
          itemsSheet.addRow(
            neutralizeRowObject({
              storeName,
              orderNumber: order.orderNumber,
              orderDate: order.createdAt,
              customer: customerName,
              email,
              status: order.status ?? '',
              paymentStatus: order.paymentStatus ?? '',
              product: item.productName,
              productAr: item.product?.nameAr ?? '',
              sku: item.sku ?? '',
              variant: item.variantName ?? '',
              qty: item.quantity,
              unitPrice: Number(minorToDecimalString(item.price)),
              // costPrice is snapshotted per line (piastres) but nullable — leave the
              // cell blank when unknown rather than showing a misleading 0.
              costPrice: item.costPrice != null ? Number(minorToDecimalString(item.costPrice)) : '',
              lineTotal: Number(minorToDecimalString(item.total)),
            })
          );
        }
      }

      // Append truncation notice row on the Orders sheet when cap was hit
      if (truncated) {
        const noteRow = ordersSheet.addRow({
          storeName: `NOTE: export truncated — only the most recent ${orders.length.toLocaleString('en-US')} orders were exported. Contact support for a full export of larger stores.`,
        });
        noteRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      // Apply numeric and date formats
      for (const col of ['subtotal', 'discount', 'shipping', 'tax', 'total']) {
        ordersSheet.getColumn(col).numFmt = excelMoneyFormat();
      }
      ordersSheet.getColumn('orderDate').numFmt = 'yyyy-mm-dd';

      for (const col of ['unitPrice', 'costPrice', 'lineTotal']) {
        itemsSheet.getColumn(col).numFmt = excelMoneyFormat();
      }
      itemsSheet.getColumn('orderDate').numFmt = 'yyyy-mm-dd';

      // Name the applied filters in the file itself and in its filename, in
      // the viewer's days (`tzOffset`, as the admin sends it).
      const dayOf = dayInOffset(parseTzOffset(req.query.tzOffset));
      const range =
        filters.from && filters.to ? { startDate: filters.from, endDate: filters.to } : undefined;
      addFiltersSheet(
        workbook,
        summarizeExportFilters([
          ['Date range', describeRange(range, dayOf)],
          ['Status', filters.status],
          ['Payment status', filters.paymentStatus],
          ['Search', filters.search],
        ])
      );
      const filenameSafe = (store.slug || store.name || 'orders').replace(/[^a-z0-9-]/gi, '-');
      const filename = exportFilename(`${filenameSafe}-orders`, range, 'xlsx', dayOf);

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
        action: 'orders.exported',
        userId: req.user!.userId,
        storeId,
        resourceType: 'order_export',
        details: {
          actorRole: req.user!.role,
          impersonatedBy: req.user!.impersonatedBy ?? null,
          rows: orders.length,
          filtered: Boolean(req.query.search || req.query.status),
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

// Validation schemas
//
// Egypt-friendly address validation: state and postalCode are not universally
// applicable (Egypt uses governorate names but no postal codes for delivery).
// The structured Egypt fields `area` (English governorate name) and `areaAr`
// (Arabic name) are preferred over the generic `state` field. The storefront
// checkout sends both since 2026-06-15; older orders only have `state`.
// Admin manual order form sends `area` directly.
const addressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  company: z.string().max(150).optional(),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().max(500).optional(),
  city: z.string().max(150).optional().default(''),
  // Governorate (محافظة) — top-level Egyptian administrative division.
  // Added 2026-06-18 alongside sub-area to support the cascade selector.
  governorate: z.string().max(60).optional().default(''),
  governorateAr: z.string().max(60).optional().default(''),
  // Structured Egypt sub-area / district, English name.
  // Preferred over generic `state`; both are accepted for backwards compat.
  area: z.string().max(150).optional().default(''),
  // Arabic name of the Egypt delivery sub-area — stored so the admin UI can
  // render the address in Arabic without a client-side lookup table.
  areaAr: z.string().max(150).optional().default(''),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
  // Structured Egyptian delivery details (also folded into address1 by the
  // storefront for display back-compat). Optional so older clients still pass.
  street: z.string().max(200).optional(),
  building: z.string().max(100).optional(),
  floor: z.string().max(50).optional(),
  apartment: z.string().max(50).optional(),
  country: z.string().trim().min(2).max(60),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional().or(z.literal('')),
});

const createOrderSchema = z.object({
  shippingAddress: addressSchema,
  billingAddress: addressSchema.optional(),
  paymentMethod: z.string(),
  notes: z.string().max(2000).optional(),
  couponCode: z.string().trim().min(1).max(50).optional(),
  // Loyalty points requested for redemption — re-resolved server-side
  // against the customer's balance + store caps (never a trusted discount).
  pointsToRedeem: z.number().int().min(0).max(100_000_000).optional(),
  // Pay from the customer wallet (D1) — a request, resolved server-side.
  useWallet: z.boolean().optional(),
  // The total the shopper last saw: compared to the server-resolved total, never used to charge (409 PRICE_CHANGED).
  expectedTotal: z.number().int().min(0).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum([
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'cancelled',
    'refunded',
  ]),
  /**
   * `refunded` only (ruling MONEYB-5): the merchant confirms they gave the
   * money back outside a payment provider (cash, InstaPay, bank transfer). The
   * server records that refund on the captured payment; without it — and with
   * no provider refund on record — `refunded` is refused, because it would
   * tell the customer "refund issued" for money that never moved.
   */
  refundRecorded: z.boolean().optional(),
  refundMethod: z.enum(['cash', 'instapay', 'bank_transfer', 'store_credit', 'other']).optional(),
  refundReference: z.string().trim().max(120).optional(),
});

// Helper to get session ID
const getSessionId = (req: Request): string => {
  const sessionId = req.headers['x-session-id'] as string;
  if (!sessionId) {
    throw new AppError(400, 'MISSING_SESSION', 'Session ID required');
  }
  return sessionId;
};

// GET /stores/:storeId/orders - List orders.
//
// Mixed-audience route: store viewers (super_admin / store_admin /
// staff) paginate every order in the store; customers see only their
// own. We can't blanket-apply `requireStoreAccess` because that rejects
// customers (they don't own the store). Instead, branch by role:
//   - store viewer → require store access via checkStoreAccess (which
//     validates super_admin / store_admin ownership AND store_staff
//     membership IDOR-safely)
//   - customer → constrain the query to their own customerId
// Without this branch, ANY store_admin token used to be able to read
// any other tenant's orders by changing :storeId in the URL. Staff must
// be in the viewer set or the Orders PWA (staff-only) shows zero orders.
router.get(
  '/',
  authenticate,
  requireCustomerStoreMatch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, confirmedOnly } = req.query;
      const role = req.user?.role;
      const isStoreViewer = role === 'store_admin' || role === 'super_admin' || role === 'staff';

      if (isStoreViewer) {
        const access = await checkStoreAccess(storeId, req.user!);
        if (!access.ok) {
          res
            .status(access.status)
            .json({ success: false, error: { code: access.code, message: access.message } });
          return;
        }
        // The store-wide order/customer search lookups answer for the whole store: only a role that
        // may read orders asks them (Ruling SEARCH-T14-7).
        if (!hasPermission(role as Role, 'orders:read')) {
          res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Missing required permission: orders:read' },
          });
          return;
        }
      }

      const filters = parseOrderListFilters(req, res);
      if (!filters) return;

      const result = await OrderService.list(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        ...filters,
        customerId: isStoreViewer ? undefined : req.user?.userId,
        // Orders PWA passes confirmedOnly=1 to show only confirmed/COD orders.
        // Only honoured for store viewers (staff / admins); customer queries
        // are already scoped to their own orders and never need this filter.
        confirmedOnly: isStoreViewer && confirmedOnly === '1',
      });

      res.json({
        success: true,
        // A customer's own list never carries the platform's CI columns (buyerKey, areaKey).
        data: isStoreViewer
          ? result
          : { ...result, orders: result.orders.map(redactOrderForCustomer) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/orders/:id - Get order. Mixed-audience like the
// list above: a store viewer (super_admin / store_admin / staff) needs
// store access; a customer needs to own the order. Without the
// store-access check, ANY store_admin token used to read any other
// tenant's individual orders. Staff must be in the viewer set or the
// Orders PWA returns 403 on every order detail.
router.get(
  '/:id',
  authenticate,
  requireCustomerStoreMatch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const role = req.user?.role;
      const isStoreViewer = role === 'store_admin' || role === 'super_admin' || role === 'staff';

      if (isStoreViewer) {
        const access = await checkStoreAccess(storeId, req.user!);
        if (!access.ok) {
          res
            .status(access.status)
            .json({ success: false, error: { code: access.code, message: access.message } });
          return;
        }
      }

      const order = await OrderService.getById(storeId, id);

      // Another customer's order answers exactly like a missing one: no existence oracle.
      if (!isStoreViewer && order.customerId !== req.user?.userId) {
        throw new AppError(404, 'NOT_FOUND', 'Order not found');
      }

      res.json({
        success: true,
        // A customer sees the order without the merchant's cost and the gold margin (Ruling B5-13).
        data: { order: isStoreViewer ? order : redactOrderForCustomer(order) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/orders - Create order (checkout, signed-in customers)
//
// AUTHZ: customer-only, mirroring every other customer-scoped route
// (returns, reviews, loyalty, /public/orders). `customerUserId()` rejects
// admin/staff tokens; previously this route passed `getAuthUser(req).userId`
// straight through, so an admin token created an order whose `customerId`
// pointed at a non-customer user row. Admin-created orders belong on
// POST /stores/:storeId/orders (createAdminOrder) below, which carries
// authorize() + requireStoreAccess and supports `shippingOverride`.
//
// `writeLimiter` matches the public twin at /public/orders — without it this
// path relied solely on the global 200-mutations/IP/15min cap.
router.post(
  '/',
  authenticate,
  requireCustomerStoreMatch,
  rejectImpersonated,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const sessionId = getSessionId(req);
      const data = createOrderSchema.parse(req.body);

      const customerId = customerUserId(req);
      if (!customerId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only customer accounts can place orders' },
        });
        return;
      }

      // Affiliate referral code from body or header
      const referralCode: string | undefined =
        (req.body.affiliateRef as string | undefined) ||
        (req.headers['x-affiliate-ref'] as string | undefined) ||
        undefined;

      const order = await OrderService.create(storeId, customerId, sessionId, data, referralCode, {
        checkoutIp: ipKeyGenerator(req.ip ?? '') || null,
        buyer: buyerFromRequest(req),
      });

      res.status(201).json({
        success: true,
        data: { order: redactOrderForCustomer(order) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/orders/:id/status - Update order status
router.put(
  '/:id/status',
  authenticate,
  // A store's order workflow (confirm/ship/cancel/refund) is the merchant's to run:
  // Ebda's super-admin approves subscriptions, never a store's own orders (ruling ORDER-MONEY-SUPERADMIN).
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:manage'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { status, refundRecorded, refundMethod, refundReference } = updateStatusSchema.parse(
        req.body
      );
      const actor = getAuthUser(req);

      const previousOrder = await OrderService.getById(storeId, id);
      // `refunded` is a money fact, not a workflow step (ruling MONEYB-5): the
      // same `orders:refund` permission as refund-via-provider (staff lack it),
      // a payment that was actually captured, and a refund on record — a
      // provider refund, or the merchant's own confirmation recorded below.
      let recordManualRefund = false;
      if (status === 'refunded' && previousOrder.status !== 'refunded') {
        if (!hasPermission(actor.role as Role, 'orders:refund')) {
          throw new AppError(
            403,
            'FORBIDDEN',
            'Recording a refund needs the orders:refund permission. Ask the store owner.'
          );
        }
        if (!hasCapturedPayment(previousOrder)) {
          throw new AppError(
            400,
            'ORDER_NOT_PAID',
            'This order has no captured payment, so it cannot be marked refunded'
          );
        }
        const providerRefundOnRecord = (previousOrder.payments ?? []).some(
          p => (p.refundedAmount ?? 0) > 0 || p.status === 'refunded'
        );
        if (!providerRefundOnRecord) {
          if (!refundRecorded) {
            throw new AppError(
              409,
              'REFUND_NOT_RECORDED',
              'Give the money back first, then confirm how you refunded it. Nothing was changed.'
            );
          }
          recordManualRefund = true;
        }
      }
      const order = await OrderService.updateStatus(storeId, id, status);
      if (recordManualRefund) {
        await OrderService.recordManualRefund(storeId, id, {
          method: refundMethod ?? 'other',
          reference: refundReference ?? null,
          actorId: actor.userId,
        });
      }

      // Audit log
      await auditLog({
        action: 'order.status.updated',
        userId: getAuthUser(req).userId,
        resourceType: 'order',
        resourceId: id,
        details: { previousStatus: previousOrder.status, newStatus: status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/orders/:orderId/invoice - Generate order invoice (admin only)
// Customers access their own invoices via the public routes which enforce ownership checks.
// This route is restricted to store admins to prevent IDOR — any authenticated user
// should not be able to retrieve another customer's invoice by guessing an orderId.
router.get(
  '/:orderId/invoice',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  // accounting.invoicing is a Professional-tier addon (Egypt-compliant tax
  // invoice + PDF). Previously ungated at every layer — every plan incl. free
  // could generate it. Gate the merchant-facing generation; the customer-facing
  // public receipt route is intentionally left open (don't 403 a paying buyer).
  requireFeature('accounting.invoicing'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      // ?locale=ar renders an Arabic RTL invoice; ?locale=en forces English.
      // Falls back to order.locale (captured at checkout) when omitted.
      const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;
      const html = await InvoiceService.generateInvoice(storeId, orderId, locale);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/invoice/email
 * Queue an invoice email send. Returns 202 immediately — the actual
 * SMTP send happens on the Inngest queue with retries.
 */
router.post(
  '/:orderId/invoice/email',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('accounting.invoicing'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const { to: customerEmail } = await invoiceRecipient(storeId, orderId);
      if (!customerEmail) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_EMAIL', message: 'Order has no customer email on file' },
        });
        return;
      }

      await queueInvoiceEmail(storeId, orderId, customerEmail);

      await auditLog({
        action: 'order.invoice.email-queued',
        userId: getAuthUser(req).userId,
        resourceType: 'order',
        resourceId: orderId,
        details: { to: customerEmail },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(202).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/orders/my - Get customer's own orders
router.get(
  '/my/list',
  authenticate,
  requireCustomerStoreMatch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const { page, limit } = req.query;
      const result = await OrderService.getCustomerOrders(storeId, getAuthUser(req).userId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        data: { ...result, orders: result.orders.map(redactOrderForCustomer) },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// COD Mark as Paid
// ==========================================

/**
 * POST /stores/:storeId/orders/:orderId/mark-paid
 * Mark a COD order as paid (admin only)
 */
router.post(
  '/:orderId/mark-paid',
  authenticate,
  // A store's order money is the merchant's to settle: Ebda's super-admin never marks it paid.
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      // The logic lives in OrderService.markCodPaid so the merchant assistant calls the same path.
      const { orderNumber, amount } = await OrderService.markCodPaid(storeId, orderId, user.userId);

      await auditLog({
        action: 'order.cod_marked_paid',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: { orderNumber, amount },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ orderId, orderNumber }, '[COD] Order marked as paid');

      res.json({
        success: true,
        data: { message: 'Order marked as paid', orderNumber },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// InstaPay: the merchant confirms the transfer arrived (SP6a)
// ==========================================

/**
 * POST /stores/:storeId/orders/:orderId/confirm-instapay
 *
 * The one manual step of the InstaPay flow: the merchant saw the money in their
 * InstaPay account. Confirms the order ONCE (awaiting_payment_confirmation ->
 * confirmed, payment recorded, post-payment fan-out). A repeat is an idempotent
 * 200 with `changed:false`; confirming an order whose window expired (and was
 * cancelled) is a 409. This IS the approval of the shopper's receipt.
 *
 * WHO (Ahmad, money batch A, Ruling EBDA-MONEYA-4): the store's own owner, or its
 * staff with `orders:manage` — scoped to their store. Ebda's super-admin may NOT
 * approve a store's order payment (the money went to the merchant, not to Ebda).
 */
router.post(
  '/:orderId/confirm-instapay',
  authenticate,
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:manage'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      const outcome = await InstapayService.confirm({
        storeId,
        orderId,
        actorUserId: user.userId,
      });
      await auditLog({
        action: outcome.changed ? 'order.instapay_confirmed' : 'order.instapay_confirm_repeated',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: { status: outcome.status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: outcome });
    } catch (error) {
      next(error);
    }
  }
);

// InstaPay receipts on a store order: the merchant reviews (never Ebda's super-admin).
const orderPaymentReviewer = [
  authenticate,
  authorize('store_admin', 'staff'),
  requireStoreAccess,
] as const;

/** GET /stores/:storeId/orders/:orderId/instapay-receipts — the shopper's submitted receipts. */
router.get(
  '/:orderId/instapay-receipts',
  ...orderPaymentReviewer,
  requirePermission('orders:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const orderId = z.string().uuid().parse(req.params.orderId);
      res.json({
        success: true,
        data: { receipts: await InstapayReceiptService.listForOrder(storeId, orderId) },
      });
    } catch (error) {
      next(error);
    }
  }
);

/** GET .../instapay-receipts/:receiptId/image — the screenshot bytes (private bucket, no URL). */
router.get(
  '/:orderId/instapay-receipts/:receiptId/image',
  ...orderPaymentReviewer,
  requirePermission('orders:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const orderId = z.string().uuid().parse(req.params.orderId);
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const img = await InstapayReceiptService.readImage(storeId, receiptId, {
        kind: 'order',
        orderId,
      });
      res.setHeader('Content-Type', img.mimeType);
      res.setHeader('Content-Disposition', 'inline; filename="instapay-receipt"');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(img.body);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST .../instapay-receipts/:receiptId/reject — the merchant rejects the shopper's
 * receipt with a reason. The order keeps waiting (hold restarts) so the shopper can
 * send the right one.
 */
router.post(
  '/:orderId/instapay-receipts/:receiptId/reject',
  ...orderPaymentReviewer,
  requirePermission('orders:manage'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const orderId = z.string().uuid().parse(req.params.orderId);
      const receiptId = z.string().uuid().parse(req.params.receiptId);
      const { note } = z
        .object({ note: z.string().trim().min(3).max(500) })
        .strict()
        .parse(req.body);
      const user = getAuthUser(req);
      const out = await InstapayService.rejectReceipt({
        storeId,
        orderId,
        receiptId,
        note,
        actorUserId: user.userId,
      });
      await auditLog({
        action: 'order.instapay_receipt_rejected',
        userId: user.userId,
        storeId,
        resourceType: 'order',
        resourceId: orderId,
        details: { receiptId, note },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: out });
    } catch (error) {
      next(error);
    }
  }
);

const refundShot = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: INSTAPAY_RECEIPT_MAX_BYTES, files: 1 },
});

/**
 * POST /stores/:storeId/orders/:orderId/instapay-refund — RECORD an InstaPay refund the
 * merchant already sent outside Ebda (reference, date, recipient AS SHOWN, amount,
 * optional screenshot `file`). Idempotent on the refund reference. Needs
 * `orders:refund` (owner; staff do not have it).
 */
router.post(
  '/:orderId/instapay-refund',
  ...orderPaymentReviewer,
  requirePermission('orders:refund'),
  writeLimiter,
  refundShot.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const orderId = z.string().uuid().parse(req.params.orderId);
      const body = { ...(req.body ?? {}) } as Record<string, unknown>;
      if (typeof body.amountMinor === 'string') body.amountMinor = Number(body.amountMinor);
      if (body.note === '') delete body.note;
      const input = instapayRefundRecordSchema.parse(body);
      const user = getAuthUser(req);
      const out = await InstapayService.recordRefund({
        storeId,
        orderId,
        input,
        screenshot: req.file?.buffer ?? null,
        actorUserId: user.userId,
      });
      await auditLog({
        action: out.duplicate ? 'order.instapay_refund_replayed' : 'order.instapay_refund_recorded',
        userId: user.userId,
        storeId,
        resourceType: 'order',
        resourceId: orderId,
        details: { amountMinor: input.amountMinor, reference: input.reference, status: out.status },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(out.duplicate ? 200 : 201).json({ success: true, data: out });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/bulk-mark-paid
 * Mark multiple COD orders as paid (admin only)
 */
router.post(
  '/bulk-mark-paid',
  authenticate,
  // A store's order money is the merchant's to settle: Ebda's super-admin never marks it paid.
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:manage'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const db = await storeDb(storeId);
      const user = getAuthUser(req);
      const { orderIds } = z
        .object({ orderIds: z.array(z.string().uuid()).min(1).max(50) })
        .parse(req.body);

      // Fetch all orders with their COD payments
      const orders = await db.order.findMany({
        where: {
          id: { in: orderIds },
          storeId,
          paymentStatus: { not: 'paid' },
        },
        include: { payments: { where: { provider: 'cod' } } },
      });

      // Filter to only COD orders with pending payments
      const codOrders = orders.filter(o => o.payments.length > 0);

      if (codOrders.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_COD_ORDERS', message: 'No eligible COD orders found' },
        });
        return;
      }

      // Build update operations. As in single mark-paid: only advance a
      // still-pending order to `confirmed`; never regress a further-along
      // (processing/shipped/delivered) order that's being paid after fulfilment.
      const money = await storeMoney(storeId);
      // The orders that were actually flipped, with the payment row and prior status that were flipped. On a Durable Object
      // store this is the section's answer (an order that was paid / cancelled in the meantime is skipped there); events,
      // fan-out and counts below come from it, never from the requested list.
      let flippedOrders = codOrders.map(o => ({
        order: o,
        paymentId: o.payments[0].id,
        fromStatus: o.payments[0].status as string,
      }));
      if (money) {
        // Durable Object store (Ruling NZ-A-2): the whole batch in ONE section there.
        const done = await money.codMarkPaid({ orderIds: codOrders.map(o => o.id) });
        const byOrder = new Map(done.updated.map(u => [u.orderId, u]));
        flippedOrders = codOrders.flatMap(o => {
          const u = byOrder.get(o.id);
          return u ? [{ order: o, paymentId: u.paymentId, fromStatus: u.fromStatus }] : [];
        });
      } else {
        const updates = codOrders.flatMap(order => [
          prisma.payment.update({
            where: { id: order.payments[0].id },
            data: { status: 'completed', paidAt: new Date() },
          }),
          prisma.order.update({
            where: { id: order.id, storeId },
            data: {
              paymentStatus: 'paid',
              ...(order.status === 'pending' ? { status: 'confirmed' } : {}),
            },
          }),
        ]);

        await prisma.$transaction(updates);
      }

      // Append-only audit rows — one per payment flipped. Fire-and-forget
      // (Promise.allSettled) so a transient log-write failure on one row
      // doesn't break the bulk action for the others.
      await Promise.allSettled(
        flippedOrders.map(({ order: o, paymentId, fromStatus }) =>
          (money ? recordPaymentEventForStore : recordPaymentEvent)({
            paymentId,
            storeId: o.storeId,
            orderId: o.id,
            eventType: 'status_change',
            fromStatus: fromStatus as (typeof o.payments)[0]['status'],
            toStatus: 'completed',
            provider: 'cod',
            triggeredByUserId: user.userId,
            details: { reason: 'cod_bulk_marked_paid', orderNumber: o.orderNumber },
          })
        )
      );

      // Fire one order/created event per updated order so the accounting journal
      // receives the paid notification. Promise.allSettled so
      // one failed enqueue doesn't block the response or the others.
      await Promise.allSettled(
        flippedOrders.map(({ order: o }) =>
          inngest
            .send({
              name: 'order/created',
              data: {
                orderId: o.id,
                storeId: o.storeId,
                paymentMethod: o.payments[0].provider,
                locale: undefined,
              },
            })
            .catch((err: unknown) =>
              logger.error({ err, orderId: o.id }, '[COD bulk] Failed to enqueue order/created')
            )
        )
      );

      await auditLog({
        action: 'order.cod_bulk_marked_paid',
        userId: user.userId,
        resourceType: 'order',
        details: {
          count: flippedOrders.length,
          orderNumbers: flippedOrders.map(f => f.order.orderNumber).join(', '),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ count: flippedOrders.length, storeId }, '[COD] Bulk orders marked as paid');

      res.json({
        success: true,
        data: {
          message: `${flippedOrders.length} order(s) marked as paid`,
          updated: flippedOrders.length,
          skipped: orderIds.length - flippedOrders.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refresh-payment-status
 *
 * Manual sync — admin clicks "refresh" on the order detail page to
 * re-check payment status with the provider (Paymob / Kashier /
 * etc.) and update our DB accordingly. Use when a webhook didn't
 * fire (provider portal misconfigured, signature mismatch, etc.)
 * but the customer says they paid.
 *
 * Mirrors the webhook handler's state-transition logic so manual
 * refresh produces the same Order + Payment + downstream side
 * effects (Inngest fanout, socket emit) as a regular webhook.
 */
router.post(
  '/:orderId/refresh-payment-status',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const db = await storeDb(storeId);
      const user = getAuthUser(req);

      const order = await db.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      const payment = order.payments[0];
      if (!payment || !payment.transactionId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_PAYMENT_RECORD',
            message:
              'No payment record found for this order. Issue a payment link first, then retry.',
          },
        });
        return;
      }

      // Hit the provider directly (PaymentService picks the right provider
      // from the stored payment row).
      const status = await PaymentService.getPaymentStatus(
        payment.transactionId,
        payment.provider as PaymentProvider,
        storeId
      );

      // Reconcile via the shared idempotent helper — the SAME routine the
      // guest verify-on-return endpoint uses, so manual refresh + webhook +
      // verify-on-return all transition state identically and only fan out
      // once. (single source of truth — `payment-confirm.service.ts`)
      const { statusChanged } = await confirmPaymentFromProviderStatus({
        payment: {
          id: payment.id,
          status: payment.status,
          provider: payment.provider,
          metadata: payment.metadata,
          amount: payment.amount,
          currency: payment.currency,
          transactionId: payment.transactionId,
        },
        order: {
          id: order.id,
          storeId: order.storeId,
          paymentStatus: order.paymentStatus,
          locale: order.locale,
        },
        providerStatus: status,
        source: 'admin_refresh',
        triggeredByUserId: user.userId,
      });

      await auditLog({
        action: 'order.payment_refreshed',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          providerStatus: status.status,
          statusChanged,
          previousPaymentStatus: order.paymentStatus,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          orderId,
          orderNumber: order.orderNumber,
          providerStatus: status.status,
          statusChanged,
        },
        '[Refresh] manual payment-status sync'
      );

      res.json({
        success: true,
        data: {
          providerStatus: status.status,
          paymentStatus: status.status === 'completed' ? 'paid' : status.status,
          statusChanged,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refund-match-claim   { claimId, providerRefundId }
 *
 * Operator action for a HELD refund webhook (Kashier: the id in the webhook may differ from the id the refund API
 * answered with, so an unknown id while our own refund is open is held, never auto-booked). "This provider refund IS
 * that refund of ours." Moves no money; consumes the claim, records the provider id as seen, audits the operator.
 */
router.post(
  '/:orderId/refund-match-claim',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requirePermission('orders:refund'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const db = await storeDb(storeId);
      const user = getAuthUser(req);
      const body = z
        .object({
          claimId: z.string().min(1).max(100),
          providerRefundId: z.string().min(1).max(200),
        })
        .strict()
        .parse(req.body);
      const payment = await db.payment.findFirst({
        where: { orderId, order: { storeId } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (!payment) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'No payment for this order' },
        });
        return;
      }
      // A store on its Durable Object (no Postgres): the DO op does the whole match in ONE section, scoped to this order
      // (Ruling NZ-MONEY-6); its refusals arrive as 409/404 AppErrors.
      const money = await storeMoney(storeId);
      const result = money
        ? (
            await money.refundMatchClaim({
              claimId: body.claimId,
              providerRefundId: body.providerRefundId,
              actorUserId: user.userId,
              orderId,
            })
          ).result
        : await inSettlementTx(storeId, () =>
            matchRefundToClaim({
              paymentId: payment.id,
              storeId,
              orderId,
              providerRefundId: body.providerRefundId,
              claimId: body.claimId,
              actorUserId: user.userId,
            })
          );
      await auditLog({
        action: 'refund.match_claim',
        userId: user.userId,
        storeId,
        resourceType: 'payment',
        resourceId: payment.id,
        details: { claimId: body.claimId, providerRefundId: body.providerRefundId, result },
      });
      res.json({ success: true, data: { result } });
    } catch (error) {
      // the settle module throws plain Errors for refusals (claim not executed, id not held, amount differs): 409, not 500
      if (
        error instanceof Error &&
        error.constructor === Error &&
        /claim|refund id|held webhook|amount/.test(error.message)
      )
        return next(new AppError(409, 'REFUND_MATCH_REFUSED', error.message));
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refresh-refund-status
 *
 * Manual sync — admin clicks "Refresh refund status" on the order detail
 * page to ask the payment provider whether a previously-submitted refund
 * has been executed yet. Safety net for when the refund webhook didn't
 * arrive (provider portal misconfigured, signature mismatch, the merchant
 * issued the refund out-of-band in the provider portal).
 *
 * Some gateways queue a refund as Pending → finance executes →
 * "Refunded" (or rejects → "Canceled"). The provider notifies us via
 * webhook, but this endpoint is the pull-side equivalent.
 */
router.post(
  '/:orderId/refresh-refund-status',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  // Refund flows flip Payment.status server-side (via provider status) — same
  // 'orders:refund' gate as refund-via-provider. staff lacks this permission.
  requirePermission('orders:refund'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const db = await storeDb(storeId);
      const user = getAuthUser(req);

      // Find the most-recent payment row that has a refundId (i.e. has
      // been refunded via the provider). Skips COD / status-button-only
      // refunds which have no provider refund record to ask about.
      const payment = await db.payment.findFirst({
        where: {
          orderId,
          order: { storeId },
          refundId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!payment || !payment.refundId) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_REFUND_RECORD',
            message:
              'No refund record found for this order. Issue a refund via provider first, then refresh.',
          },
        });
        return;
      }

      // Call the provider's GetRefundStatus. Optional on IPaymentProvider —
      // PaymentService.getRefundStatus refuses gracefully when the chosen
      // provider doesn't implement it.
      const status = await runInStoreCtx(storeId, () =>
        PaymentService.getRefundStatus(
          payment.refundId!,
          payment.provider as PaymentProvider,
          storeId
        )
      );

      const prevMeta = (payment.metadata as Record<string, unknown>) || {};
      const prevStatus = (prevMeta.refundStatus as string | undefined) || 'pending';
      const statusChanged = prevStatus !== status.status;

      // Durable Object store (Ruling NZ-A-4): the provider's answer settles through the refund-webhook section there
      // (arithmetic, payment row, whole-order reversal on a full refund), so none of the Postgres write below runs.
      if (await storeMoney(storeId)) {
        if (!payment.transactionId) {
          throw new AppError(400, 'NO_REFUND_RECORD', 'This payment has no provider reference');
        }
        const applied = await PaymentService.applyPolledRefundOnDo(
          storeId,
          { provider: payment.provider, transactionId: payment.transactionId },
          {
            refundId: status.refundId ?? payment.refundId,
            status: status.status,
            amount: status.refundedAmount ?? status.amount ?? null,
            refundReference: status.refundReference ?? null,
          }
        );
        // the section records its own event for what it applied; this one only notes an applied refresh
        if (applied.outcome === 'applied')
          await recordPaymentEventForStore({
            paymentId: payment.id,
            storeId,
            orderId,
            eventType: 'reconciliation',
            fromStatus: payment.status as typeof payment.status,
            toStatus: null,
            provider: payment.provider,
            triggeredByUserId: user.userId,
            details: {
              reason: 'manual_refund_status_refresh',
              providerStatus: status.status,
              refundId: payment.refundId,
              outcome: applied.outcome,
            },
          });
        await auditLog({
          action: 'order.refund_status_refreshed',
          userId: user.userId,
          resourceType: 'order',
          resourceId: orderId,
          details: { refundId: payment.refundId, providerStatus: status.status, statusChanged },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        res.json({
          success: true,
          data: {
            providerStatus: status.status,
            refundStatus: status.status,
            refundedAmount: status.refundedAmount,
            refundReference: status.refundReference,
            statusChanged,
          },
        });
        return;
      }

      // Update Payment.metadata with the fresh status. If the provider says the refund completed and our Payment row isn't
      // marked refunded yet (out-of-band path), promote it now.
      //
      // The whole read-decide-write runs in ONE transaction that holds the payment row lock (`inSettlementTx` joins the
      // ambient tenant transaction or opens one): every patch below is built from the LOCKED copy, never from the row read
      // before the lock, so a concurrent webhook cannot interleave and have its metadata overwritten by a stale spread.
      const updateData: Record<string, unknown> = {};
      // the LOCKED row: everything computed from the payment after the lock (raised amount, status) uses this, never the row read before it
      const lockedHolder: { v: { refundedAmount: number; status: string } | null } = { v: null };
      await inSettlementTx(storeId, async () => {
        const settleRes = await settleRefundEvent({
          paymentId: payment.id,
          storeId,
          orderId,
          provider: payment.provider,
          refund: {
            refundId: status.refundId ?? payment.refundId ?? '',
            status: status.status,
            amount: status.refundedAmount ?? status.amount ?? null,
          },
        });
        const locked = settleRes.payment;
        lockedHolder.v = { refundedAmount: locked.refundedAmount, status: locked.status };
        updateData.metadata = {
          ...locked.metadata,
          refundStatus: status.status,
          refundReference: status.refundReference ?? locked.metadata.refundReference,
          refundStatusCheckedAt: new Date().toISOString(),
        };
        // `partially_refunded` is admitted (#1432/#1472): excluding it locked a payment out of this route forever once any
        // partial refund landed. The settlement rule never lowers the total and refuses to re-count an accounted id.
        if (
          !settleRes.seen &&
          settleRes.decision &&
          status.status === 'completed' &&
          locked.status !== 'refunded'
        ) {
          // Derive the terminal status from the arithmetic, do not assert it.
          // `refundedAmount` is the cumulative budget PaymentService.refund
          // compare-and-swaps against, and `status` decides whether ReturnService
          // will accept the payment as a refund source at all. A PARTIAL
          // out-of-band refund reported here would otherwise be written as a full
          // one: the payment is marked settled while money remains refundable, so
          // every later partial return is rejected for having no refundable
          // payment. The guard above only skips rows already fully refunded.
          //
          // A missing, non-finite or non-positive provider amount is NOT
          // evidence of a partial refund — a status payload that carries no
          // amount would otherwise be recorded as a 0-piastre partial refund while
          // the gateway has already sent the WHOLE sum back: the order keeps its
          // pre-refund status, no reversal or GL entry runs, and the payment
          // still reads as refundable so a later return fires a second real
          // gateway refund. Same rule as the sibling webhook path in
          // payment.factory.ts — only an amount the provider actually REPORTED,
          // and that falls short of the total, downgrades to partial; unknown
          // means FULL.
          // Shared with the refund-webhook branch — see resolveRefundSettlement.
          const d = settleRes.decision;
          updateData.status = d.isFullRefund ? 'refunded' : 'partially_refunded';
          updateData.refundedAmount = d.settledTotal;
          if (d.accountedThisEvent) {
            updateData.metadata = {
              ...(updateData.metadata as Record<string, unknown>),
              [REFUND_EVENT_IDS_KEY]: appendRefundEventId(
                locked.metadata,
                status.refundId ?? payment.refundId
              ),
              [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
                locked.metadata,
                status.refundId,
                status.status
              ),
            };
          }
        }
        if (!settleRes.seen) await settleRes.commit({ data: updateData });
        else await prisma.payment.update({ where: { id: payment.id }, data: updateData });
      });

      // Append-only audit row. Records the refund-status refresh — fromStatus
      // is the pre-update payment status; toStatus is what we just wrote (or
      // null when only metadata changed without a status flip).
      await recordPaymentEvent({
        paymentId: payment.id,
        storeId,
        orderId,
        eventType: 'reconciliation',
        fromStatus: (lockedHolder.v?.status ?? payment.status) as typeof payment.status,
        toStatus: (updateData.status as typeof payment.status | undefined) ?? null,
        provider: payment.provider,
        triggeredByUserId: user.userId,
        details: {
          reason: 'manual_refund_status_refresh',
          providerStatus: status.status,
          refundId: payment.refundId,
          refundedAmount: updateData.refundedAmount ?? null,
        },
      });

      // If this is the first time we see the refund as executed AND no
      // applyRefundEffects ever ran (Payment.status was still completed),
      // fire it now — inventory restore + customer email + admin push.
      //
      // Both calls below used to be wrapped in a `.catch(logger.error)` that
      // swallowed the failure and let the route fall through to its normal
      // 200 response — the SAME money-integrity-audit-F2 pattern Task 5
      // fixed on `refund-via-provider`: a failed reversal-event dispatch (or
      // a failed order-status flip) was silent, and an admin refreshing the
      // refund status had no way to know the reversal chain never ran. Let
      // both propagate to the route's `catch (error) { next(error); }` below
      // instead. (Since Ruling AP-2 the `order/refunded` SEND itself runs after
      // COMMIT via deferAfterTenantCommit, so an enqueue failure there is
      // alerted, not propagated; the whole-order reversal it requested is
      // re-sent by refund-reversal-stuck-sweep off the stamp committed here.)
      // Whole-order side effects belong to a whole-order refund. The write
      // above now distinguishes a partial out-of-band refund from a full one,
      // so gating this on the same arithmetic keeps the two coherent: without
      // it a 2000-piastre refund on a 5000-piastre payment would record the payment as
      // partially refunded and then flip the ORDER to refunded and restore ALL
      // its inventory — the whole-order fanout the item-level path exists to
      // avoid. A partial refresh updates the payment and stops there; the
      // returns flow owns item-level effects and carries the line data this
      // route does not have.
      //
      // Keyed on the payment's own transition INTO `refunded` rather than on a
      // change of the metadata refundStatus: a payment first seen as a partial
      // refund already carries refundStatus 'completed', so the later refresh
      // that promotes it to fully refunded would otherwise never run the
      // whole-order reversal (#1432). The guard above excludes an
      // already-refunded payment, so a repeat refresh cannot re-fire it; the
      // fanout subtracts lines already restored by partial returns.
      const refundIsFull = updateData.status === 'refunded';
      // A partial out-of-band refund recorded here is booked as a revenue
      // refund for the amount this refresh added, with no stock movement,
      // keyed on the provider's refund id (owner decision 2026-10-01, #1455).
      //
      // Only when THIS refresh recorded new money. A partially_refunded
      // payment can now re-enter this route (#1432/#1472); a repeat refresh
      // that adds nothing books nothing, and the GL entry is idempotent on the
      // refund id if the refund's own webhook reports it too. The event is
      // sent after this request commits, with the payment write above.
      const raisedBy =
        typeof updateData.refundedAmount === 'number'
          ? updateData.refundedAmount -
            (lockedHolder.v?.refundedAmount ?? payment.refundedAmount ?? 0)
          : 0;
      const providerRefundId = status.refundId ?? payment.refundId;
      if (updateData.status === 'partially_refunded' && raisedBy > 0 && providerRefundId) {
        await OrderService.recordRefundOutsideReturn(storeId, orderId, {
          providerRefundId,
          amount: raisedBy,
        });
      }
      const needsSideEffects =
        status.status === 'completed' &&
        ((lockedHolder.v?.status ?? payment.status) === 'completed' ||
          (lockedHolder.v?.status ?? payment.status) === 'partially_refunded') &&
        refundIsFull;
      if (needsSideEffects) {
        // Guard the direct Order.status write with the state machine — this
        // was the last unguarded Order.status writer (adversarial audit P2).
        // Re-read the CURRENT status and assert BEFORE any side-effect,
        // mirroring payment-confirm.service.ts: a refresh racing another path
        // that already moved the order to a terminal state must not regress
        // it, and must not fire reversals it cannot commit.
        const currentOrder = await db.order.findFirst({
          where: { id: orderId, storeId },
          select: { status: true },
        });
        if (!currentOrder) {
          throw new AppError(404, 'NOT_FOUND', 'Order not found');
        }
        // An order already `refunded` (e.g. the merchant recorded the refund
        // by status) has had its whole-order reversal. Now that a partially
        // refunded payment can be promoted here (#1432), settling its payment
        // must not re-run that reversal or fail on refunded → refunded — the
        // same "has the ORDER been reversed" question the webhook asks.
        if (currentOrder.status !== 'refunded') {
          assertValidTransition(currentOrder.status, 'refunded');
          await OrderService.applyRefundEffects(storeId, orderId);
          await prisma.order.update({
            where: { id: orderId, storeId },
            data: { status: 'refunded', paymentStatus: 'refunded' },
          });
        }
      }

      await auditLog({
        action: 'order.refund_status_refreshed',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          refundId: payment.refundId,
          providerStatus: status.status,
          statusChanged,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          orderId,
          refundId: payment.refundId,
          providerStatus: status.status,
          statusChanged,
        },
        '[Refund] manual refund-status sync'
      );

      res.json({
        success: true,
        data: {
          providerStatus: status.status,
          refundStatus: status.status,
          refundedAmount: status.refundedAmount,
          refundReference: status.refundReference,
          statusChanged,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/refund-via-provider
 *
 * Admin-initiated refund. Calls the payment provider's refund API
 * (Paymob / Kashier / Fawry), then PaymentService.refund handles the
 * DB transaction (Payment.status -> refunded, Order.status -> refunded)
 * and OrderService.applyRefundEffects fans out side effects:
 *   - inventory restore (track_inventory products)
 *   - coupon usage decrement
 *   - affiliate commission reversal
 *   - loyalty points reversal (NEW — was missing before)
 *   - order/refunded Inngest event → customer refund email + admin push
 *
 * Defaults to full refund. Partial refunds: pass `amount` (in piastres).
 *
 * #628: an `Idempotency-Key` header is REQUIRED (the admin makes one per dialog open). The same key returns the first
 * answer; a retry while the first still runs, or after a failure that may have moved money (timeout / 5xx from the
 * provider), is refused 409 and the claim stays open for reconciliation; the key is also the DO claim's attempt key, so a
 * second claim under it is refused even if the key store lost it.
 */
const refundViaProviderSchema = z.object({
  amount: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});

router.post(
  '/:orderId/refund-via-provider',
  authenticate,
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  // Triggers a real provider refund + flips Payment.status — staff lacks
  // 'orders:refund' (see rolePermissions in middleware/rbac.ts), so only the
  // store's admin may call this. Ebda's super-admin never refunds a store's order.
  requirePermission('orders:refund'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      const data = refundViaProviderSchema.parse(req.body ?? {});
      // The lookup, the money-moving chain and their refusals live in services/order-provider-refund.service.ts (shared with the assistant's
      // `order_refund` tool). PaymentService.refund covers the provider call, the Payment/Order status flip and applyRefundEffects; a failure
      // ANYWHERE in that chain surfaces as a non-2xx (money-integrity audit F2).
      const target = await lookupRefundTarget(storeId, orderId);
      const idem = idempotencyKeyOf(req.header('idempotency-key'));
      if (!idem)
        throw new AppError(
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'This refund needs an Idempotency-Key header (one per refund attempt). Nothing was done.'
        );
      if (target.kind === 'not_found') {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }
      if (target.kind === 'no_payment') {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_COMPLETED_PAYMENT',
            message:
              'No refundable online payment found for this order. COD orders cannot be refunded via the provider — use the manual "Refunded" status instead.',
          },
        });
        return;
      }
      if (target.kind === 'already_refunded') {
        res.status(400).json({
          success: false,
          error: {
            code: 'ALREADY_REFUNDED',
            message: 'This order has already been fully refunded.',
          },
        });
        return;
      }
      const { order, payment } = target;
      const result = await refundThroughProvider({
        storeId,
        orderId,
        orderNumber: order.orderNumber,
        payment,
        amount: data.amount,
        reason: data.reason,
        idempotencyKey: idem,
      });

      await auditLog({
        action: 'order.refund_via_provider',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          refundId: result.refundId,
          refundAmount: result.amount,
          provider: payment.provider,
          reason: data.reason ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        {
          orderId,
          orderNumber: order.orderNumber,
          refundId: result.refundId,
          refundAmount: result.amount,
          provider: payment.provider,
        },
        '[Refund] admin-initiated provider refund'
      );

      res.json({
        success: true,
        data: {
          refundId: result.refundId,
          refundAmount: result.amount,
          provider: result.provider,
          status: result.status,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * STORE-QA-76 - partial refund from the admin order page.
 *
 * GET  /stores/:storeId/orders/:orderId/refund-quote[?items=<json [{orderItemId, quantity}]>]
 *      what the dialog shows: the ONE refundable balance, each line's remaining quantity, and (with `items`) what refunding those
 *      lines would pay back. Read-only; the same helpers the writer enforces with.
 * POST /stores/:storeId/orders/:orderId/partial-refund
 *      refund the chosen lines (per-line restock) by one method. An `Idempotency-Key` header is REQUIRED (one per dialog open): the
 *      same key answers the first result, a second one can never pay twice. The server refuses more than paid - already refunded
 *      (#624) whatever the client sent. `orders:refund` (store admin); staff open a return from /returns instead.
 */
const partialRefundItemSchema = z
  .object({
    orderItemId: z.string().uuid(),
    quantity: z.number().int().min(1).max(100_000),
    restock: z.boolean().optional(),
  })
  .strict();
const partialRefundItemsSchema = z
  .array(partialRefundItemSchema)
  .min(1)
  .max(100)
  .refine(a => new Set(a.map(i => i.orderItemId)).size === a.length, 'a line is listed twice');
const partialRefundSchema = z
  .object({
    items: partialRefundItemsSchema,
    reason: z.string().trim().min(1).max(500),
    refundMethod: z.enum(REFUND_METHODS),
  })
  .strict();

router.get(
  '/:orderId/refund-quote',
  authenticate,
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  requirePermission('returns:read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      let items: z.infer<typeof partialRefundItemsSchema> | undefined;
      if (typeof req.query.items === 'string' && req.query.items !== '') {
        try {
          items = partialRefundItemsSchema.parse(JSON.parse(req.query.items));
        } catch {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'items must be a JSON array of { orderItemId, quantity }'
          );
        }
      }
      const money = await storeMoney(storeId);
      if (!money)
        throw new AppError(409, 'RETURNS_NEED_DO_STORE', 'Refunds by line are not available here');
      const quote = await money.analyticsRefundQuote({ orderId, items });
      res.json({
        success: true,
        data: {
          quote: {
            ...quote,
            // the gateway leg is `orders:refund` only (staff lack it, like the return completion)
            canRefundToOriginal: hasPermission(req.user!.role as Role, 'orders:refund'),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:orderId/partial-refund',
  authenticate,
  authorize('store_admin', 'staff'),
  rejectImpersonated, // sends money back: an impersonated session is read-only here (Ruling FP-3)
  requireStoreAccess,
  // money goes back to the customer: `orders:refund` like every refund route (staff lack it and open returns from /returns instead)
  requirePermission('orders:refund'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      const data = partialRefundSchema.parse(req.body ?? {});
      const idem = idempotencyKeyOf(req.header('idempotency-key'));
      if (!idem)
        throw new AppError(
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'This refund needs an Idempotency-Key header (one per refund attempt). Nothing was done.'
        );
      const out = await withIdempotencyKey(
        `partial-refund:${user.userId}:${orderId}`,
        idem,
        () => ReturnService.adminPartialRefund(storeId, user.userId, { orderId, ...data }, idem),
        refundMayHaveExecuted,
        { required: true }
      );
      const ret = out.value as { id: string; returnNumber: string; refundAmount: number };
      await auditLog({
        action: 'order.partial_refund',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          returnId: ret.id,
          returnNumber: ret.returnNumber,
          refundMethod: data.refundMethod,
          refundAmount: ret.refundAmount,
          items: data.items,
          reason: data.reason,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({
        success: true,
        data: {
          returnId: ret.id,
          returnNumber: ret.returnNumber,
          refundAmount: ret.refundAmount,
          replayed: out.replayed,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/admin
 *
 * Admin-initiated order creation. Used for phone orders / merchant-
 * placed orders where the customer isn't checking out themselves.
 * Skips the cart entirely; admin submits line items directly.
 * After save, the merchant can issue a payment link via the
 * existing /payment-link endpoint.
 */
const adminOrderItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(999),
});
const adminOrderSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    shippingAddress: z.record(z.unknown()),
    billingAddress: z.record(z.unknown()).optional(),
    items: z.array(adminOrderItemSchema).min(1),
    paymentMethod: z.enum(['online', 'cod']).optional(),
    paymentProvider: z.enum(['paymob', 'kashier', 'fawry', 'geidea', 'instapay', 'cod']).optional(),
    notes: z.string().optional(),
    couponCode: z.string().optional(),
    currency: z.string().optional(),
    /**
     * Optional shipping fee override in integer piastres (EGP × 100).
     * When set, it replaces the ShippingService-computed fee for this order.
     * Intended for phone orders where the merchant negotiates a custom rate.
     * The admin UI collects EGP and converts to piastres before sending.
     */
    shippingOverride: z.number().int().min(0).optional(),
    /**
     * Apply `couponCode` outside its rules (owner decision 2026-09-25, #1370,
     * ruling M-OVR-1). Rules are ENFORCED by default. Honoured only for
     * store_admin/super_admin (403 for staff, in OrderService.createAdminOrder)
     * and only with a reason, which is recorded with the actor.
     */
    overrideCouponRules: z.boolean().optional(),
    couponOverrideReason: z.string().trim().min(3).max(500).optional(),
    /**
     * B2B minimum order quantity: refused by default (422 BELOW_MOQ). store_admin / super_admin may override with a
     * reason, which is recorded with the actor (order event + audit log). Rejected for staff in the service.
     */
    overrideMoq: z.boolean().optional(),
    moqOverrideReason: z.string().trim().min(3).max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.overrideMoq === true && !v.moqOverrideReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['moqOverrideReason'],
        message: 'A reason is required to override the minimum order quantity',
      });
    }
    if (v.overrideCouponRules !== true) return;
    if (!v.couponCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['couponCode'],
        message: 'couponCode is required to override coupon rules',
      });
    }
    if (!v.couponOverrideReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['couponOverrideReason'],
        message: 'A reason is required to override coupon rules',
      });
    }
  });

router.post(
  '/admin',
  authenticate,
  // BE:S-33: Ebda's super-admin never places or edits a store's orders (ruling ORDER-MONEY-SUPERADMIN), like status / mark-paid.
  authorize('store_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const data = adminOrderSchema.parse(req.body ?? {});

      // Ruling B2B-2d: an admin order is priced as the Customer the merchant explicitly SELECTED (the form's customerId),
      // never from a typed phone / email; with no selection it is retail.
      const buyer = data.customerId
        ? buyerFromMerchantShopperSelection(req, data.customerId)
        : ANONYMOUS_BUYER;
      const order = await OrderService.createAdminOrder(
        storeId,
        user.userId,
        data,
        { role: user.role },
        { buyer }
      );

      // BE:S-23: the custom shipping fee is recorded with who set it (the service already refused staff).
      if (typeof data.shippingOverride === 'number') {
        await auditLog({
          action: ORDER_SHIPPING_OVERRIDE_AUDIT_ACTION,
          userId: user.userId,
          storeId,
          resourceType: 'order',
          resourceId: order.id,
          details: { orderNumber: order.orderNumber, shippingOverride: data.shippingOverride },
        });
      }

      res.json({
        success: true,
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/orders/:orderId/payment-link
 *
 * Issue a payment link for an existing order, through one of the store's own gateways (Paymob,
 * Kashier, Fawry). Used by the merchant when a customer couldn't complete checkout on the
 * original payment flow (gateway blocked, customer abandoned and asked for the link).
 *
 * Body:
 *   - provider: 'paymob' | 'kashier' | 'fawry'   (default: the store's default online provider)
 *   - method:   which of the provider's methods to offer (default: all it has enabled)
 *   - notifyVia: 'link' (the only channel: the merchant copies and shares the link; none of the
 *     Egyptian gateways sends the customer a message for us)
 *
 * The endpoint reuses the same `PaymentService.createPayment` path as the public checkout:
 * same per-store credentials, same callback and webhook URLs, so a paid link still triggers the
 * webhook and order-status pipeline.
 *
 * NO REQUEST TRANSACTION: this route runs under store scope (`orderRouteContext`), so the
 * gateway call holds no transaction or connection. The order is read in a short scope, the
 * gateway is called, then one short transaction records the payment.
 */
const issuePaymentLinkSchema = z.object({
  notifyVia: z.enum(['link', 'email', 'all']).optional().default('link'),
  provider: z.enum(['paymob', 'kashier', 'fawry', 'geidea']).optional(),
  method: z.enum(['card', 'meeza', 'wallet', 'valu', 'payatfawry']).optional(),
});

router.post(
  '/:orderId/payment-link',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const db = await storeDb(storeId);
      const user = getAuthUser(req);
      const { notifyVia, provider, method } = issuePaymentLinkSchema.parse(req.body ?? {});

      if (notifyVia !== 'link') {
        res.status(400).json({
          success: false,
          error: {
            code: 'NOTIFY_NOT_SUPPORTED',
            message:
              'The payment gateways do not send the link to the customer. Copy the link and share it.',
          },
        });
        return;
      }

      const order = await db.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: { items: true },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }
      const orderCustomer = order.customerId
        ? ((await customersById(storeId, [order.customerId])).get(order.customerId) ?? null)
        : null;
      // `Store` is a platform row a Durable Object order cannot join: read it beside the order (NEON-ZERO-1, Ruling NZ-A-3).
      const orderStore = await db.store.findUnique({
        where: { id: storeId },
        select: { id: true, slug: true, domain: true, name: true, nameAr: true },
      });

      if (order.paymentStatus === 'paid') {
        res.status(400).json({
          success: false,
          error: {
            code: 'ALREADY_PAID',
            message: 'Order is already paid — no need to issue a new link',
          },
        });
        return;
      }

      // The gateway to use: the merchant's choice, else the store's default online provider.
      const providerName = provider ?? (await PaymentService.getDefaultProvider(storeId));
      if (!providerName) {
        res.status(400).json({
          success: false,
          error: {
            code: 'PAYMENT_NOT_CONFIGURED',
            message: 'Set up a payment gateway in Settings → Payments before issuing a link.',
          },
        });
        return;
      }

      // Same storefront URL resolution the public checkout uses, so the
      // payment-success / payment-error callbacks land on the correct
      // tenant domain whether they have a custom domain or platform slug.
      const storefrontBaseUrl = orderStore ? storefrontOrigin(orderStore) : config.webUrl;

      const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
      const customerName =
        `${orderCustomer?.firstName ?? shipping.firstName ?? ''} ${
          orderCustomer?.lastName ?? shipping.lastName ?? ''
        }`.trim() || 'Customer';
      const customerEmail = orderCustomer?.email || shipping.email || '';
      const customerPhone = orderCustomer?.phone || shipping.phone || undefined;

      const result = await PaymentService.createPayment(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          // Amount due: the order value less any customer-wallet spend (D1) —
          // a link for an order the customer part-paid from their wallet must
          // not charge that part again. === order.total when no wallet was used.
          amount: order.total - order.walletAmount,
          currency: order.currency as Currency,
          customer: {
            id: orderCustomer?.id ?? `guest-${order.id}`,
            name: customerName,
            email: customerEmail,
            phone: customerPhone,
          },
          items: buildPaymentLineItems(order.items),
          callbackUrl: `${storefrontBaseUrl}/checkout/success`,
          errorUrl: `${storefrontBaseUrl}/checkout/error`,
          webhookUrl: paymentWebhookUrl(providerName, storeId),
          notifyVia,
          ...(method ? { metadata: { method } } : {}),
        },
        providerName,
        storeId
      );

      await auditLog({
        action: 'order.payment_link_issued',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          provider: providerName,
          invoiceId: result.invoiceId ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        { orderId, orderNumber: order.orderNumber, provider: providerName },
        '[Payment-Link] issued by merchant'
      );

      res.json({
        success: true,
        data: {
          paymentUrl: result.paymentUrl,
          // Fawry: the reference code the customer pays with at an outlet.
          instruction: result.instruction,
          invoiceId: result.invoiceId,
          provider: providerName,
          notifyVia,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// GET /stores/:storeId/orders/:orderId/timeline
// ==========================================

interface TimelineRow {
  at: string;
  source: 'audit' | 'shipment' | 'order';
  kind: string;
  fromStatus?: string;
  toStatus?: string;
  details?: string;
  actorName?: string;
  location?: string;
}

interface ShipmentHistoryEntry {
  status: string;
  timestamp: string;
  location?: string;
  description?: string;
}

/**
 * GET /stores/:storeId/orders/:orderId/timeline
 *
 * Mixed-audience: admins authenticated via checkStoreAccess; customers
 * verified by matching their own customerId on the order. actorName is
 * redacted for non-admin callers.
 */
router.get(
  '/:orderId/timeline',
  authenticate,
  requireCustomerStoreMatch,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const db = await storeDb(storeId);
      const user = req.user;

      // Resolve caller role — a store viewer (super_admin / store_admin /
      // staff) is verified via checkStoreAccess (ownership for admins,
      // store_staff membership for staff, IDOR-safe); customers fall
      // through to the ownership check below. Staff must be a viewer or
      // the Orders PWA timeline 403s.
      let isStoreViewer = false;
      if (
        user &&
        (user.role === 'super_admin' || user.role === 'store_admin' || user.role === 'staff')
      ) {
        const access = await checkStoreAccess(storeId, user);
        if (access.ok) isStoreViewer = true;
      }

      // Fetch the order to get customerId + synthetic event dates
      const order = await db.order.findFirst({
        where: { id: orderId, storeId },
        select: {
          id: true,
          customerId: true,
          shippedAt: true,
          deliveredAt: true,
          createdAt: true,
          // Order has a single optional Shipment relation (not an array).
          shipment: {
            select: { statusHistory: true },
          },
        },
      });

      if (!order) {
        res.status(404).json({ success: false, error: { message: 'Order not found' } });
        return;
      }

      // For non-viewer callers verify ownership
      if (!isStoreViewer) {
        if (!user || order.customerId !== user.userId) {
          res.status(404).json({ success: false, error: { message: 'Order not found' } });
          return;
        }
      }

      const rows: TimelineRow[] = [];

      // 1. Audit log entries for this order
      const audits = await listAuditWithActors(
        storeId,
        { resourceType: 'order', resourceId: orderId },
        200
      );

      const auditKinds = new Set<string>();
      for (const a of audits) {
        // A coupon-rule override (#1370) is the merchant's internal record —
        // who waived which rule and why — never shown to the customer.
        // BE:S-26: the merchant's internal override records (coupon waiver, MOQ waiver, custom shipping fee) are never shown to the customer.
        if (!isStoreViewer && CUSTOMER_HIDDEN_AUDIT_ACTIONS.has(a.action)) continue;
        auditKinds.add(a.action);
        const d = a.details as Record<string, any>;
        rows.push({
          at: a.createdAt.toISOString(),
          source: 'audit',
          kind: a.action,
          fromStatus: d?.fromStatus ?? d?.from,
          toStatus: d?.toStatus ?? d?.to,
          details: d?.notes ?? d?.description,
          actorName:
            isStoreViewer && a.user
              ? `${a.user.firstName ?? ''} ${a.user.lastName ?? ''}`.trim()
              : undefined,
        });
      }

      // 2. Shipment status history entries
      const shipment = order.shipment;
      if (shipment) {
        const history = (shipment.statusHistory as unknown as ShipmentHistoryEntry[]) ?? [];
        for (const entry of history) {
          rows.push({
            at: entry.timestamp,
            source: 'shipment',
            kind: `shipment.${entry.status}`,
            details: entry.description,
            location: entry.location,
          });
        }
      }

      // 3. Synthetic order-level events for shippedAt/deliveredAt when no
      //    matching audit log entry exists (avoids duplication)
      if (order.shippedAt && !auditKinds.has('order.shipped')) {
        rows.push({ at: order.shippedAt.toISOString(), source: 'order', kind: 'order.shipped' });
      }
      if (order.deliveredAt && !auditKinds.has('order.delivered')) {
        rows.push({
          at: order.deliveredAt.toISOString(),
          source: 'order',
          kind: 'order.delivered',
        });
      }
      // Order creation event
      if (!auditKinds.has('order.created')) {
        rows.push({ at: order.createdAt.toISOString(), source: 'order', kind: 'order.created' });
      }

      // Sort newest first
      rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

      res.json({ success: true, data: { timeline: rows.slice(0, 200) } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
