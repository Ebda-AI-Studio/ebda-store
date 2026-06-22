/**
 * Payment-gateway abandonment retargeting API.
 *
 * Enterprise-only (feature: payment_abandonment). These endpoints surface
 * orders that were stamped paymentGatewayAbandonedAt != NULL by the Inngest
 * payment-abandonment-sweep cron. Operators use this data for retargeting:
 * contacting high-intent shoppers who reached the gateway but did not pay.
 *
 * PII handling: customerPhone and customerEmail are masked by default
 * (last-4 digits / domain-only) in the list response. The detail view
 * (order detail endpoint, already in order.routes.ts) exposes full data to
 * authorized staff.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { runInTenantContext } from '@force/database';

const router = Router({ mergeParams: true });

/** Middleware chain shared across all routes in this file. */
const adminMiddleware = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  requireFeature('payment_abandonment'),
];

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  from: z.string().optional(),
  to: z.string().optional(),
});

/**
 * Masks a phone number to show only the last 4 digits:
 * "+965 9876 5432" → "***5432"
 * Returns null/undefined as-is.
 */
function maskPhone(phone: string | null | undefined): string | null | undefined {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

/**
 * Masks an email to show only the domain:
 * "ahmad@example.com" → "***@example.com"
 * Returns null/undefined as-is.
 */
function maskEmail(email: string | null | undefined): string | null | undefined {
  if (!email) return email;
  const at = email.indexOf('@');
  if (at < 0) return '***';
  return `***${email.slice(at)}`;
}

/**
 * GET /stores/:storeId/payment-abandonments
 *
 * Paginated list of gateway-abandonment orders, newest first.
 * Returns masked contact data (last-4 phone, domain-only email).
 * Use the order detail endpoint for full contact / admin access.
 */
router.get('/', ...adminMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { page, limit, from, to } = listQuerySchema.parse(req.query);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {
      storeId,
      deletedAt: null,
      paymentGatewayAbandonedAt: { not: null },
      // Only pending/unpaid — if the order was subsequently paid or cancelled,
      // include it so the operator can see the full funnel (status changed =
      // recovered or cancelled after abandon).
    };

    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range['gte'] = new Date(`${from}T00:00:00`);
      if (to) range['lte'] = new Date(`${to}T23:59:59`);
      where['paymentGatewayAbandonedAt'] = range;
    }

    const [rows, total] = await runInTenantContext(storeId, () =>
      Promise.all([
        prisma.order.findMany({
          where,
          skip,
          take: limit,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            total: true,
            currency: true,
            paymentGatewayAbandonedAt: true,
            createdAt: true,
            shippingAddress: true,
            customer: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
              },
            },
            payments: {
              select: { provider: true, paymentUrl: true, status: true },
              take: 1,
              orderBy: { createdAt: 'desc' },
            },
            items: {
              select: {
                id: true,
                productName: true,
                variantName: true,
                quantity: true,
                price: true,
                total: true,
              },
              take: 5,
            },
            _count: { select: { items: true } },
          },
          orderBy: { paymentGatewayAbandonedAt: 'desc' },
        }),
        prisma.order.count({ where }),
      ])
    );

    const abandoners = rows.map(row => {
      // Derive contact from the customer record or the shipping address JSON.
      const addr = row.shippingAddress as Record<string, unknown> | null;
      const rawPhone =
        (row.customer?.phone as string | null | undefined) ??
        (addr?.phone as string | null | undefined);
      const rawEmail =
        (row.customer?.email as string | null | undefined) ??
        (addr?.email as string | null | undefined);

      return {
        id: row.id,
        orderNumber: row.orderNumber,
        status: row.status,
        paymentStatus: row.paymentStatus,
        total: row.total,
        currency: row.currency,
        abandonedAt: row.paymentGatewayAbandonedAt,
        createdAt: row.createdAt,
        customer: row.customer
          ? {
              id: row.customer.id,
              firstName: row.customer.firstName,
              lastName: row.customer.lastName,
              // Masked PII in list view.
              phoneMasked: maskPhone(rawPhone),
              emailMasked: maskEmail(rawEmail),
            }
          : null,
        guestContact: !row.customer
          ? {
              firstName: (addr?.firstName as string | undefined) ?? null,
              lastName: (addr?.lastName as string | undefined) ?? null,
              phoneMasked: maskPhone(rawPhone),
              emailMasked: maskEmail(rawEmail),
            }
          : null,
        gateway: row.payments[0]?.provider ?? null,
        itemCount: row._count.items,
        items: row.items.map(i => ({
          id: i.id,
          productName: i.productName,
          variantName: i.variantName ?? null,
          quantity: i.quantity,
          price: i.price,
          total: i.total,
        })),
      };
    });

    res.json({
      success: true,
      data: {
        abandoners,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /stores/:storeId/payment-abandonments/stats
 *
 * Aggregate stats for the abandonment dashboard card.
 */
router.get(
  '/stats',
  ...adminMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const [total, last7d, last30d, totalValueResult] = await runInTenantContext(storeId, () =>
        Promise.all([
          prisma.order.count({
            where: { storeId, deletedAt: null, paymentGatewayAbandonedAt: { not: null } },
          }),
          prisma.order.count({
            where: {
              storeId,
              deletedAt: null,
              paymentGatewayAbandonedAt: {
                not: null,
                gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              },
            },
          }),
          prisma.order.count({
            where: {
              storeId,
              deletedAt: null,
              paymentGatewayAbandonedAt: {
                not: null,
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
              },
            },
          }),
          prisma.order.aggregate({
            where: { storeId, deletedAt: null, paymentGatewayAbandonedAt: { not: null } },
            _sum: { total: true },
          }),
        ])
      );

      res.json({
        success: true,
        data: {
          total,
          last7d,
          last30d,
          totalValue: totalValueResult._sum.total ?? 0,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
