import { Router, Request, Response, NextFunction } from 'express';
import ExcelJS from 'exceljs';
import { prisma, Prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { AppError } from '../middleware/error-handler';

const router = Router({ mergeParams: true });

const adminMiddleware = [authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess];

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
  lastOrderDate: Date;
  lastOrderNumber: string;
  lastOrderStatus: string;
  lastOrderPaymentStatus: string;
  /** Oldest order's createdAt — "customer since" date. */
  firstOrderDate: Date;
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
  state?: string;
  country?: string;
  postalCode?: string;
}

function formatShippingAddress(addr: ShippingAddressShape | null): string {
  if (!addr) return '';
  return [addr.address1, addr.address2, addr.area, addr.city, addr.country]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(', ');
}

/**
 * Aggregate customers from order history. Now includes:
 * - guest orders (no User row) keyed by shipping email/phone
 * - cancelled / unpaid orders (no status filter — Ahmad 2026-05-16:
 *   'get the info even if cancelled or unpaid')
 * - latest shipping address + per-order payment amount so the export
 *   surfaces what the merchant needs to ship + reconcile
 */
async function aggregateCustomers(storeId: string): Promise<AggregatedCustomer[]> {
  const orders = await prisma.order.findMany({
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
      // the provider field via the relation; first payment wins for the
      // summary string.
      payments: { select: { provider: true } },
      customer: {
        select: { id: true, email: true, firstName: true, lastName: true, phone: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

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
      existing.firstOrderDate =
        order.createdAt < existing.firstOrderDate ? order.createdAt : existing.firstOrderDate;
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

  // Materialize comma-joined sets + recompute avgOrderValue after the
  // full aggregation pass.
  for (const [key, row] of map.entries()) {
    row.statuses = Array.from(statusSets.get(key) ?? []).join(', ');
    row.paymentMethods = Array.from(paymentMethodSets.get(key) ?? []).join(', ');
    row.avgOrderValue = row.totalOrders > 0 ? Math.round(row.totalSpent / row.totalOrders) : 0;
  }

  return Array.from(map.values()).sort((a, b) => b.totalSpent - a.totalSpent);
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

      const customers = await aggregateCustomers(storeId);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Force Website Builder';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Customers');

      sheet.columns = [
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
        sheet.addRow({
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
        });
      }

      // Format the date + currency columns. Excel's "kwd" doesn't have a
      // built-in symbol, so we use a numeric format with 3 decimals.
      sheet.getColumn('totalSpent').numFmt = '0.000';
      sheet.getColumn('avgOrderValue').numFmt = '0.000';
      sheet.getColumn('lastOrderTotal').numFmt = '0.000';
      sheet.getColumn('lastOrderDate').numFmt = 'yyyy-mm-dd';
      sheet.getColumn('firstOrderDate').numFmt = 'yyyy-mm-dd';

      const filenameSafe = (store.slug || store.name || 'customers').replace(/[^a-z0-9-]/gi, '-');
      const filename = `${filenameSafe}-customers-${new Date().toISOString().slice(0, 10)}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // exceljs.write() returns a Promise<void> when given a writable
      // stream; piping into res lets the response close cleanly.
      await workbook.xlsx.write(res);
      res.end();
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

      const orders = await prisma.order.findMany({
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
      });

      if (orders.length === 0) {
        throw new AppError(404, 'NOT_FOUND', 'Customer not found');
      }

      // Aggregate stats from the full order list. The first order
      // (newest) wins for current-snapshot fields (latest address,
      // phone, etc.). Mirror the listing-page logic exactly so the
      // detail view's totals match what the merchant saw in the list.
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

      res.json({
        success: true,
        data: { customer, orders },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
