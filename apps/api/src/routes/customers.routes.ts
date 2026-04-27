import { Router, Request, Response, NextFunction } from 'express';
import ExcelJS from 'exceljs';
import { prisma } from '@force/database';
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
  totalOrders: number;
  totalSpent: number;
  lastOrderDate: Date;
  lastOrderNumber: string;
}

/**
 * Aggregate customers from order history. The User row carries the
 * authoritative phone, but we fall back to the most recent order's
 * shippingAddress.phone — that's what merchants actually use to call
 * the customer.
 */
async function aggregateCustomers(storeId: string): Promise<AggregatedCustomer[]> {
  const orders = await prisma.order.findMany({
    where: { storeId, customerId: { not: null } },
    select: {
      id: true,
      orderNumber: true,
      total: true,
      createdAt: true,
      shippingAddress: true,
      customer: {
        select: { id: true, email: true, firstName: true, lastName: true, phone: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const map = new Map<string, AggregatedCustomer>();
  for (const order of orders) {
    if (!order.customer) continue;
    const shipping = (order.shippingAddress ?? null) as { phone?: string } | null;
    const fallbackPhone = shipping?.phone ?? '';
    const existing = map.get(order.customer.id);
    if (existing) {
      existing.totalOrders += 1;
      existing.totalSpent += order.total;
      // findMany is ordered by createdAt desc, so the first row we see for
      // this customer is the most recent. Keep that order's phone if the
      // user record doesn't have one.
      if (!existing.phone && fallbackPhone) existing.phone = fallbackPhone;
    } else {
      map.set(order.customer.id, {
        id: order.customer.id,
        firstName: order.customer.firstName ?? '',
        lastName: order.customer.lastName ?? '',
        email: order.customer.email ?? '',
        phone: order.customer.phone ?? fallbackPhone,
        totalOrders: 1,
        totalSpent: order.total,
        lastOrderDate: order.createdAt,
        lastOrderNumber: order.orderNumber,
      });
    }
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
        { header: 'Total Orders', key: 'totalOrders', width: 14 },
        { header: 'Total Spent (KWD)', key: 'totalSpent', width: 18 },
        { header: 'Last Order #', key: 'lastOrderNumber', width: 24 },
        { header: 'Last Order Date', key: 'lastOrderDate', width: 18 },
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
          totalOrders: c.totalOrders,
          // Convert fils → KWD with 3 decimals so the cell is numeric and
          // sortable in Excel rather than a formatted string.
          totalSpent: Number((c.totalSpent / 1000).toFixed(3)),
          lastOrderNumber: c.lastOrderNumber,
          lastOrderDate: c.lastOrderDate,
        });
      }

      // Format the date + currency columns. Excel's "kwd" doesn't have a
      // built-in symbol, so we use a numeric format with 3 decimals.
      sheet.getColumn('totalSpent').numFmt = '0.000';
      sheet.getColumn('lastOrderDate').numFmt = 'yyyy-mm-dd';

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

export default router;
