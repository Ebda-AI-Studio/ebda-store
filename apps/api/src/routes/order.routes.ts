import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { neutralizeRowObject } from '../lib/exports/xlsx';
import { authenticate, authorize, customerUserId } from '../middleware/auth';
import { requireStoreAccess, checkStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { OrderService, assertValidTransition } from '../services/order.service';
import { InvoiceService } from '../services/invoice.service';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { prisma } from '@force/database';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { PaymentService } from '../services/payment-providers/payment.factory';
import { recordPaymentEvent } from '../services/payment-event.service';
import { alertUnbookedRefund } from '../services/payment-providers/unbooked-refund-alert';
import { confirmPaymentFromProviderStatus } from '../services/payment-confirm.service';
import { runInTenantContext } from '@force/database';
import { config } from '../config';
import type { Currency } from '../services/payment-providers/types';
import { AppError } from '../middleware/error-handler';
import { buildPaymentLineItems } from '../lib/payment-line-items';
import {
  resolveRefundSettlement,
  readAccountedRefundEventIds,
  appendRefundEventId,
  recordRefundStatus,
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
} from '../services/payment-providers/refund-settlement';

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

      // Fetch up to cap+1 to detect truncation. Include items + first payment
      // for the Line Items sheet and the payment provider/method columns.
      const fetched = await prisma.order.findMany({
        where: { storeId, deletedAt: null },
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
          customer: {
            select: { firstName: true, lastName: true, email: true, phone: true },
          },
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

      // ---- Build workbook ----
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Force Website Builder';
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
        { header: 'Subtotal (KWD)', key: 'subtotal', width: 16 },
        { header: 'Discount (KWD)', key: 'discount', width: 16 },
        { header: 'Coupon', key: 'coupon', width: 14 },
        { header: 'Promotion', key: 'promotion', width: 18 },
        // Loyalty points' share of Discount (issue 2239) — invisible before.
        { header: 'Loyalty Discount (KWD)', key: 'loyaltyDiscount', width: 20 },
        { header: 'Shipping (KWD)', key: 'shipping', width: 16 },
        { header: 'Tax (KWD)', key: 'tax', width: 12 },
        // Issue 2168: for an inclusive order Tax is INSIDE Total, so
        // Subtotal − Discount + Shipping + Tax ≠ Total. This column says which
        // formula reconciles the row.
        { header: 'Tax Included In Price', key: 'taxIncluded', width: 20 },
        { header: 'Total (KWD)', key: 'total', width: 14 },
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
        { header: 'Unit Price (KWD)', key: 'unitPrice', width: 18 },
        { header: 'Cost Price (KWD)', key: 'costPrice', width: 18 },
        { header: 'Line Total (KWD)', key: 'lineTotal', width: 18 },
      ];

      const itemsHeader = itemsSheet.getRow(1);
      itemsHeader.font = headerStyle.font as ExcelJS.Font;
      itemsHeader.fill = headerStyle.fill as ExcelJS.Fill;

      const storeName = store.name ?? '';

      for (const order of orders) {
        const addr = (order.shippingAddress ?? null) as ShippingAddressShape | null;
        const firstName = order.customer?.firstName ?? addr?.firstName ?? '';
        const lastName = order.customer?.lastName ?? addr?.lastName ?? '';
        const customerName = `${firstName} ${lastName}`.trim();
        const email = order.customer?.email ?? addr?.email ?? '';
        const phone = order.customer?.phone ?? addr?.phone ?? '';
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
            subtotal: Number((order.subtotal / 1000).toFixed(3)),
            // `order.discount` is already the AUTHORITATIVE total (coupon/
            // promotion + loyalty combined) — adding couponDiscount on top
            // double-counted it. See order.service.ts's create() comment on
            // couponDiscount + promotionDiscount + loyaltyDiscount reconciling
            // to `discount`.
            discount: Number((order.discount / 1000).toFixed(3)),
            coupon: order.couponCode ?? '',
            promotion: order.appliedPromotion?.name ?? '',
            loyaltyDiscount: Number((order.loyaltyDiscount / 1000).toFixed(3)),
            shipping: Number((order.shipping / 1000).toFixed(3)),
            tax: Number((order.tax / 1000).toFixed(3)),
            taxIncluded: order.taxIncludedInPrice ? 'Yes' : 'No',
            total: Number((order.total / 1000).toFixed(3)),
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
              unitPrice: Number((item.price / 1000).toFixed(3)),
              // costPrice is snapshotted per line (fils) but nullable — leave the
              // cell blank when unknown rather than showing a misleading 0.
              costPrice: item.costPrice != null ? Number((item.costPrice / 1000).toFixed(3)) : '',
              lineTotal: Number((item.total / 1000).toFixed(3)),
            })
          );
        }
      }

      // Append truncation notice row on the Orders sheet when cap was hit
      if (truncated) {
        const noteRow = ordersSheet.addRow({
          storeName: `NOTE: export truncated — only the most recent ${orders.length.toLocaleString()} orders were exported. Contact support for a full export of larger stores.`,
        });
        noteRow.font = { bold: true, color: { argb: 'FFB91C1C' } };
      }

      // Apply numeric and date formats
      for (const col of ['subtotal', 'discount', 'shipping', 'tax', 'total']) {
        ordersSheet.getColumn(col).numFmt = '0.000';
      }
      ordersSheet.getColumn('orderDate').numFmt = 'yyyy-mm-dd';

      for (const col of ['unitPrice', 'costPrice', 'lineTotal']) {
        itemsSheet.getColumn(col).numFmt = '0.000';
      }
      itemsSheet.getColumn('orderDate').numFmt = 'yyyy-mm-dd';

      const filenameSafe = (store.slug || store.name || 'orders').replace(/[^a-z0-9-]/gi, '-');
      const filename = `${filenameSafe}-orders-${new Date().toISOString().slice(0, 10)}.xlsx`;

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

// Validation schemas
//
// Kuwait-friendly address validation: state and postalCode are not universally
// applicable (Kuwait uses governorate names but no postal codes for delivery).
// The structured Kuwait fields `area` (English governorate name) and `areaAr`
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
  // Governorate (محافظة) — top-level KW administrative division.
  // Added 2026-06-18 alongside sub-area to support the cascade selector.
  governorate: z.string().max(60).optional().default(''),
  governorateAr: z.string().max(60).optional().default(''),
  // Structured Kuwait sub-area / district, English name.
  // Preferred over generic `state`; both are accepted for backwards compat.
  area: z.string().max(150).optional().default(''),
  // Arabic name of the Kuwait delivery sub-area — stored so the admin UI can
  // render the address in Arabic without a client-side lookup table.
  areaAr: z.string().max(150).optional().default(''),
  state: z.string().max(150).optional().default(''),
  postalCode: z.string().max(30).optional().default(''),
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
});

// Helper to get session ID
const getSessionId = (req: Request): string => {
  const sessionId = req.headers['x-session-id'] as string;
  if (!sessionId) {
    throw Object.assign(new Error('Session ID required'), { statusCode: 400 });
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
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { page, limit, status, from, to, confirmedOnly } = req.query;
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

    const result = await OrderService.list(storeId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      status: status as string,
      customerId: isStoreViewer ? undefined : req.user?.userId,
      from: from ? new Date(String(from) + 'T00:00:00') : undefined,
      to: to ? new Date(String(to) + 'T23:59:59') : undefined,
      // Orders PWA passes confirmedOnly=1 to show only confirmed/COD orders.
      // Only honoured for store viewers (staff / admins); customer queries
      // are already scoped to their own orders and never need this filter.
      confirmedOnly: isStoreViewer && confirmedOnly === '1',
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:storeId/orders/:id - Get order. Mixed-audience like the
// list above: a store viewer (super_admin / store_admin / staff) needs
// store access; a customer needs to own the order. Without the
// store-access check, ANY store_admin token used to read any other
// tenant's individual orders. Staff must be in the viewer set or the
// Orders PWA returns 403 on every order detail.
router.get('/:id', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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

    if (!isStoreViewer && order.customerId !== req.user?.userId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to view this order' },
      });
      return;
    }

    res.json({
      success: true,
      data: { order },
    });
  } catch (error) {
    next(error);
  }
});

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

      const order = await OrderService.create(storeId, customerId, sessionId, data, referralCode);

      res.status(201).json({
        success: true,
        data: { order },
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requirePermission('orders:manage'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const { status } = updateStatusSchema.parse(req.body);

      const previousOrder = await OrderService.getById(storeId, id);
      const order = await OrderService.updateStatus(storeId, id, status);

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
  // accounting.invoicing is a Professional-tier addon (Kuwait-compliant tax
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
      const order = await OrderService.getById(storeId, orderId);
      const customerEmail =
        order.customer?.email ?? (order.shippingAddress as Record<string, string> | null)?.email;
      if (!customerEmail) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_EMAIL', message: 'Order has no customer email on file' },
        });
        return;
      }

      await inngest.send({
        name: 'order/invoice.email-requested',
        data: { orderId, storeId, to: customerEmail },
      });

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
router.get('/my/list', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    const { page, limit } = req.query;
    const result = await OrderService.getCustomerOrders(storeId, getAuthUser(req).userId, {
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId },
        include: { payments: true },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

      // Verify this is a COD order
      const codPayment = order.payments.find(p => p.provider === 'cod');
      if (!codPayment) {
        res.status(400).json({
          success: false,
          error: { code: 'NOT_COD', message: 'This order is not a Cash on Delivery order' },
        });
        return;
      }

      if (order.paymentStatus === 'paid') {
        res.status(400).json({
          success: false,
          error: { code: 'ALREADY_PAID', message: 'Order is already marked as paid' },
        });
        return;
      }

      // Update payment and order status atomically. Only advance a still-pending
      // order to `confirmed`; leave a further-along order (processing/shipped/
      // delivered) untouched. COD cash is collected AT delivery, so marking paid
      // typically happens after fulfilment — forcing `confirmed` there regressed
      // the order's status and lost fulfilment progress.
      await prisma.$transaction([
        prisma.payment.update({
          where: { id: codPayment.id },
          data: { status: 'completed', paidAt: new Date() },
        }),
        prisma.order.update({
          where: { id: orderId },
          data: {
            paymentStatus: 'paid',
            ...(order.status === 'pending' ? { status: 'confirmed' } : {}),
          },
        }),
      ]);

      // Append-only audit row for the COD completion.
      await recordPaymentEvent({
        paymentId: codPayment.id,
        storeId: order.storeId,
        orderId,
        eventType: 'status_change',
        fromStatus: codPayment.status,
        toStatus: 'completed',
        provider: 'cod',
        triggeredByUserId: user.userId,
        details: { reason: 'cod_marked_paid', orderNumber: order.orderNumber },
      });

      // Fire the same post-payment fanout the webhook handler does —
      // accounting journal + WhatsApp WBS notification both rely on this event.
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

      await auditLog({
        action: 'order.cod_marked_paid',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: { orderNumber: order.orderNumber, amount: codPayment.amount },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ orderId, orderNumber: order.orderNumber }, '[COD] Order marked as paid');

      res.json({
        success: true,
        data: { message: 'Order marked as paid', orderNumber: order.orderNumber },
      });
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
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const { orderIds } = z
        .object({ orderIds: z.array(z.string().uuid()).min(1).max(50) })
        .parse(req.body);

      // Fetch all orders with their COD payments
      const orders = await prisma.order.findMany({
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
      const updates = codOrders.flatMap(order => [
        prisma.payment.update({
          where: { id: order.payments[0].id },
          data: { status: 'completed', paidAt: new Date() },
        }),
        prisma.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: 'paid',
            ...(order.status === 'pending' ? { status: 'confirmed' } : {}),
          },
        }),
      ]);

      await prisma.$transaction(updates);

      // Append-only audit rows — one per payment flipped. Fire-and-forget
      // (Promise.allSettled) so a transient log-write failure on one row
      // doesn't break the bulk action for the others.
      await Promise.allSettled(
        codOrders.map(o =>
          recordPaymentEvent({
            paymentId: o.payments[0].id,
            storeId: o.storeId,
            orderId: o.id,
            eventType: 'status_change',
            fromStatus: o.payments[0].status,
            toStatus: 'completed',
            provider: 'cod',
            triggeredByUserId: user.userId,
            details: { reason: 'cod_bulk_marked_paid', orderNumber: o.orderNumber },
          })
        )
      );

      // Fire one order/created event per updated order so accounting journal +
      // WBS WhatsApp both receive the paid notification. Promise.allSettled so
      // one failed enqueue doesn't block the response or the others.
      await Promise.allSettled(
        codOrders.map(o =>
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
          count: codOrders.length,
          orderNumbers: codOrders.map(o => o.orderNumber).join(', '),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ count: codOrders.length, storeId }, '[COD] Bulk orders marked as paid');

      res.json({
        success: true,
        data: {
          message: `${codOrders.length} order(s) marked as paid`,
          updated: codOrders.length,
          skipped: orderIds.length - codOrders.length,
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
 * re-check payment status with the provider (MyFatoorah / Tap /
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
      const user = getAuthUser(req);

      const order = await prisma.order.findFirst({
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
        payment.provider as 'tap' | 'myfatoorah' | 'hesabe' | 'upayments',
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
 * POST /stores/:storeId/orders/:orderId/refresh-refund-status
 *
 * Manual sync — admin clicks "Refresh refund status" on the order detail
 * page to ask the payment provider whether a previously-submitted refund
 * has been executed yet. Safety net for when the refund webhook didn't
 * arrive (provider portal misconfigured, signature mismatch, the merchant
 * issued the refund out-of-band in the provider portal).
 *
 * MyFatoorah refunds start as Pending → finance team executes →
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
      const user = getAuthUser(req);

      // Find the most-recent payment row that has a refundId (i.e. has
      // been refunded via the provider). Skips COD / status-button-only
      // refunds which have no provider refund record to ask about.
      const payment = await prisma.payment.findFirst({
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
      const status = await runInTenantContext(storeId, () =>
        PaymentService.getRefundStatus(
          payment.refundId!,
          payment.provider as 'tap' | 'myfatoorah' | 'hesabe' | 'upayments',
          storeId
        )
      );

      const prevMeta = (payment.metadata as Record<string, unknown>) || {};
      const prevStatus = (prevMeta.refundStatus as string | undefined) || 'pending';
      const statusChanged = prevStatus !== status.status;

      // Update Payment.metadata with the fresh status. If the provider
      // says the refund completed and our Payment row isn't marked
      // refunded yet (out-of-band path), promote it now.
      const updateData: Record<string, unknown> = {
        metadata: {
          ...prevMeta,
          refundStatus: status.status,
          refundReference: status.refundReference ?? prevMeta.refundReference,
          refundStatusCheckedAt: new Date().toISOString(),
        },
      };
      // `partially_refunded` is admitted (#1432/#1472): excluding it locked a
      // payment out of this route forever once any partial refund landed, so
      // the balance refunded later in the provider portal was never recorded
      // and the whole-order reversal never ran. resolveRefundSettlement never
      // lowers the total and refuses to re-count an already-accounted refund
      // id, so re-entering is safe.
      if (status.status === 'completed' && payment.status !== 'refunded') {
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
        // amount would otherwise be recorded as a 0-fil partial refund while
        // the gateway has already sent the WHOLE sum back: the order keeps its
        // pre-refund status, no reversal or GL entry runs, and the payment
        // still reads as refundable so a later return fires a second real
        // gateway refund. Same rule as the sibling webhook path in
        // payment.factory.ts — only an amount the provider actually REPORTED,
        // and that falls short of the total, downgrades to partial; unknown
        // means FULL.
        // Shared with the refund-webhook branch — see resolveRefundSettlement.
        const {
          settledTotal,
          isFullRefund: refundIsFullRefund,
          accountedThisEvent,
        } = resolveRefundSettlement({
          paymentAmount: payment.amount ?? 0,
          alreadyRefunded: payment.refundedAmount,
          reported: [status.refundedAmount, status.amount],
          // This route raised the total but recorded nothing, so the refund it
          // counted could be counted a SECOND time by the webhook that arrives
          // for the same refund afterwards. The ledger is shared; every path
          // that adds to the total has to maintain it.
          reportedEventId: status.refundId,
          accountedEventIds: readAccountedRefundEventIds(payment.metadata),
        });
        updateData.status = refundIsFullRefund ? 'refunded' : 'partially_refunded';
        updateData.refundedAmount = settledTotal;
        if (accountedThisEvent) {
          updateData.metadata = {
            ...(updateData.metadata as Record<string, unknown>),
            [REFUND_EVENT_IDS_KEY]: appendRefundEventId(payment.metadata, status.refundId),
            [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(
              payment.metadata,
              status.refundId,
              status.status
            ),
          };
        }
      }
      await prisma.payment.update({
        where: { id: payment.id },
        data: updateData,
      });

      // Append-only audit row. Records the refund-status refresh — fromStatus
      // is the pre-update payment status; toStatus is what we just wrote (or
      // null when only metadata changed without a status flip).
      await recordPaymentEvent({
        paymentId: payment.id,
        storeId,
        orderId,
        eventType: 'reconciliation',
        fromStatus: payment.status,
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
      // it a 2000-fil refund on a 5000-fil payment would record the payment as
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
      // A partial out-of-band refund recorded here reaches no GL poster — the
      // partial journal needs line data only the returns flow has (#1455).
      // Nothing books it, so say so instead of leaving it to a log line.
      //
      // Only when THIS refresh recorded new money. A partially_refunded
      // payment can now re-enter this route (#1432/#1472); a repeat refresh
      // that adds nothing must not re-page for a refund already alerted.
      const raisedRefundTotal =
        typeof updateData.refundedAmount === 'number' &&
        updateData.refundedAmount > (payment.refundedAmount ?? 0);
      if (updateData.status === 'partially_refunded' && raisedRefundTotal) {
        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { name: true },
        });
        await alertUnbookedRefund({
          kind: 'partial_no_gl',
          store: { id: storeId, name: store?.name ?? storeId },
          orderRef: orderId,
          body: `Order ${orderId}: a partial refund (${status.refundId ?? payment.refundId}) made outside a return was recorded by a refund-status refresh. Nothing posts it to the general ledger — book it by hand.`,
          context: { paymentId: payment.id, refundId: status.refundId ?? payment.refundId },
        });
      }
      const needsSideEffects =
        status.status === 'completed' &&
        (payment.status === 'completed' || payment.status === 'partially_refunded') &&
        refundIsFull;
      if (needsSideEffects) {
        // Guard the direct Order.status write with the state machine — this
        // was the last unguarded Order.status writer (adversarial audit P2).
        // Re-read the CURRENT status and assert BEFORE any side-effect,
        // mirroring payment-confirm.service.ts: a refresh racing another path
        // that already moved the order to a terminal state must not regress
        // it, and must not fire reversals it cannot commit.
        const currentOrder = await prisma.order.findFirst({
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
            where: { id: orderId },
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
 * (MyFatoorah / Tap / etc.), then PaymentService.refund handles the
 * DB transaction (Payment.status -> refunded, Order.status -> refunded)
 * and OrderService.applyRefundEffects fans out side effects:
 *   - inventory restore (track_inventory products)
 *   - coupon usage decrement
 *   - affiliate commission reversal
 *   - loyalty points reversal (NEW — was missing before)
 *   - order/refunded Inngest event → customer refund email + admin push
 *
 * Defaults to full refund. Partial refunds: pass `amount` (in fils).
 */
const refundViaProviderSchema = z.object({
  amount: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});

router.post(
  '/:orderId/refund-via-provider',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  // Triggers a real provider refund + flips Payment.status — staff lacks
  // 'orders:refund' (see rolePermissions in middleware/rbac.ts), so only
  // store_admin/super_admin may call this despite passing authorize() above.
  requirePermission('orders:refund'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = getAuthUser(req);
      const data = refundViaProviderSchema.parse(req.body ?? {});

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: {
          payments: {
            // A partially refunded payment still has a refundable balance
            // (#1360) — PaymentService.refund budgets against
            // `amount - refundedAmount` and accepts it as a starting state, as
            // ReturnService does. Filtering to 'completed' alone left this
            // button dead after the first partial return.
            where: { status: { in: ['completed', 'partially_refunded'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
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
            code: 'NO_COMPLETED_PAYMENT',
            message:
              'No refundable online payment found for this order. COD orders cannot be refunded via the provider — use the manual "Refunded" status instead.',
          },
        });
        return;
      }

      if (order.paymentStatus === 'refunded') {
        res.status(400).json({
          success: false,
          error: {
            code: 'ALREADY_REFUNDED',
            message: 'This order has already been fully refunded.',
          },
        });
        return;
      }

      // `PaymentService.refund` covers the whole money-moving chain: the
      // provider refund call, the Payment/Order status flip, and firing
      // `applyRefundEffects` (which enqueues `order/refunded` — the sole
      // trigger for inventory/coupon/affiliate/loyalty reversal + the
      // customer refund email/admin push). A failure ANYWHERE in that
      // chain must surface as a non-2xx — this used to catch only the
      // provider-call error and swallow everything else into an HTTP 200
      // (money-integrity audit F2: operator gets no signal a refund
      // broke). We still enrich the message with a MyFatoorah-specific
      // hint (the #1 first-time failure mode is the "Refund" API
      // permission not being enabled on the merchant account) and forward
      // to `next(err)` instead of writing the response ourselves, so every
      // failure mode in the chain — not just the provider call — reaches
      // the client as a real error.
      let result;
      try {
        result = await runInTenantContext(storeId, async () =>
          PaymentService.refund({
            transactionId: payment.transactionId!,
            amount: data.amount,
            reason: data.reason,
          })
        );
      } catch (refundError) {
        const refundMessage =
          refundError instanceof Error ? refundError.message : 'Unknown refund error';
        logger.error(
          {
            err: refundError,
            orderId,
            orderNumber: order.orderNumber,
            transactionId: payment.transactionId,
            provider: payment.provider,
            amount: data.amount,
          },
          '[Refund] admin-initiated provider refund failed'
        );
        const hint =
          payment.provider === 'myfatoorah'
            ? ' (verify Refund permission is enabled on this account in the MyFatoorah portal: Settings → API Permissions → MakeRefund)'
            : '';
        next(new AppError(502, 'REFUND_FAILED', `${refundMessage}${hint}`));
        return;
      }

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
const adminOrderSchema = z.object({
  customerId: z.string().uuid().optional(),
  shippingAddress: z.record(z.unknown()),
  billingAddress: z.record(z.unknown()).optional(),
  items: z.array(adminOrderItemSchema).min(1),
  paymentMethod: z.enum(['online', 'cod']).optional(),
  paymentProvider: z.enum(['tap', 'myfatoorah', 'hesabe', 'upayments', 'cod']).optional(),
  notes: z.string().optional(),
  couponCode: z.string().optional(),
  currency: z.string().optional(),
  /**
   * Optional shipping fee override in integer fils (KWD × 1000).
   * When set, it replaces the ShippingService-computed fee for this order.
   * Intended for phone orders where the merchant negotiates a custom rate.
   * The admin UI collects KWD and converts to fils before sending.
   */
  shippingOverride: z.number().int().min(0).optional(),
});

router.post(
  '/admin',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const user = getAuthUser(req);
      const data = adminOrderSchema.parse(req.body ?? {});

      const order = await OrderService.createAdminOrder(storeId, user.userId, data);

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
 * Issue a MyFatoorah payment link for an existing order. Used by the
 * merchant when a customer couldn't complete checkout on the original
 * payment flow (e.g. KNET timeout, gateway blocked, customer abandoned
 * and asked for the link via WhatsApp).
 *
 * Body:
 *   - notifyVia: 'link' | 'email' | 'all'  (default 'link')
 *     'link'  → return URL only, merchant copies + sends manually
 *     'email' → MyFatoorah sends email to the customer
 *     'all'   → MyFatoorah sends SMS + email (NB: SMS not surfaced in
 *               UI yet, but the provider supports it natively)
 *
 * The endpoint reuses the same `PaymentService.createPayment` path as
 * the public checkout — same per-store credentials, same callback +
 * webhook URLs — so a paid link still triggers the existing webhook +
 * order-status pipeline.
 */
const issuePaymentLinkSchema = z.object({
  notifyVia: z.enum(['link', 'email', 'all']).optional().default('link'),
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
      const user = getAuthUser(req);
      const { notifyVia } = issuePaymentLinkSchema.parse(req.body ?? {});

      const order = await prisma.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        include: {
          items: true,
          customer: {
            select: { id: true, email: true, firstName: true, lastName: true, phone: true },
          },
          store: {
            select: { id: true, slug: true, domain: true, name: true, nameAr: true },
          },
        },
      });

      if (!order) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Order not found' },
        });
        return;
      }

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

      // Same storefront URL resolution the public checkout uses, so the
      // payment-success / payment-error callbacks land on the correct
      // tenant domain whether they have a custom domain or platform slug.
      const storefrontBaseUrl = order.store?.domain
        ? `https://${order.store.domain}`
        : order.store?.slug
          ? `${config.webUrl}/${order.store.slug}`
          : config.webUrl;

      const shipping = (order.shippingAddress ?? {}) as Record<string, string | undefined>;
      const customerName =
        `${order.customer?.firstName ?? shipping.firstName ?? ''} ${
          order.customer?.lastName ?? shipping.lastName ?? ''
        }`.trim() || 'Customer';
      const customerEmail = order.customer?.email || shipping.email || '';
      const customerPhone = order.customer?.phone || shipping.phone || undefined;

      // MyFatoorah rejects empty email with 400 — bail early with a
      // friendly error so the merchant knows they need an email on the
      // order before they can issue a link.
      if (notifyVia !== 'link' && !customerEmail) {
        res.status(400).json({
          success: false,
          error: {
            code: 'NO_CUSTOMER_EMAIL',
            message:
              'Cannot send the link via email — this order has no customer email on file. Pick "Copy link" and share it manually.',
          },
        });
        return;
      }

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
            id: order.customer?.id ?? `guest-${order.id}`,
            name: customerName,
            email: customerEmail,
            phone: customerPhone,
          },
          items: buildPaymentLineItems(order.items),
          callbackUrl: `${storefrontBaseUrl}/checkout/success`,
          errorUrl: `${storefrontBaseUrl}/checkout/error`,
          webhookUrl: `${config.apiUrl}/api/v1/webhooks/payment/myfatoorah`,
          notifyVia,
        },
        'myfatoorah',
        storeId
      );

      await auditLog({
        action: 'order.payment_link_issued',
        userId: user.userId,
        resourceType: 'order',
        resourceId: orderId,
        details: {
          orderNumber: order.orderNumber,
          notifyVia,
          invoiceId: result.invoiceId ?? null,
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info(
        { orderId, orderNumber: order.orderNumber, notifyVia, invoiceId: result.invoiceId },
        '[Payment-Link] issued by merchant'
      );

      res.json({
        success: true,
        data: {
          paymentUrl: result.paymentUrl,
          invoiceId: result.invoiceId,
          notifyVia,
          customerEmail: notifyVia !== 'link' ? customerEmail : undefined,
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, orderId } = req.params;
      const user = (req as any).user;

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
      const order = await prisma.order.findFirst({
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
          res.status(403).json({ success: false, error: { message: 'Forbidden' } });
          return;
        }
      }

      const rows: TimelineRow[] = [];

      // 1. Audit log entries for this order
      const audits = await prisma.auditLog.findMany({
        where: { storeId, resourceType: 'order', resourceId: orderId },
        include: { user: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      const auditKinds = new Set<string>();
      for (const a of audits) {
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
