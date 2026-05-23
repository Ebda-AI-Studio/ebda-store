import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { streamXlsxResponse } from '../lib/exports/xlsx';

/**
 * Admin newsletter routes — list + CSV export of subscribers for a store.
 *
 * The customer-facing signup endpoint lives in `public.routes.ts`. This
 * file is store-admin only and goes through the same auth chain as every
 * other admin route (authenticate → authorize → requireStoreAccess).
 */
const router = Router();

// GET /stores/:storeId/newsletter/subscribers - List newsletter subscribers
router.get(
  '/:storeId/newsletter/subscribers',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit } = req.query;

      const pageNum = Math.max(1, parseInt((page as string) || '1', 10));
      const limitNum = Math.min(200, Math.max(1, parseInt((limit as string) || '50', 10)));
      const skip = (pageNum - 1) * limitNum;

      const [subscribers, total] = await Promise.all([
        prisma.newsletterSubscriber.findMany({
          where: { storeId },
          orderBy: { subscribedAt: 'desc' },
          skip,
          take: limitNum,
          select: {
            id: true,
            email: true,
            language: true,
            source: true,
            isActive: true,
            subscribedAt: true,
            unsubscribedAt: true,
          },
        }),
        prisma.newsletterSubscriber.count({ where: { storeId } }),
      ]);

      res.json({
        success: true,
        data: {
          subscribers,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/newsletter/subscribers/export - CSV download
//
// Streamed via res.send rather than res.json — admins paste this straight
// into Mailchimp / Sendgrid. Returns *all* rows (no pagination) since the
// expected list size for a single tenant is well below memory pressure
// thresholds; if a store ever pushes past ~100k subs this should be
// switched to a streaming cursor.
router.get(
  '/:storeId/newsletter/subscribers/export',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rows = await prisma.newsletterSubscriber.findMany({
        where: { storeId },
        orderBy: { subscribedAt: 'desc' },
        select: {
          email: true,
          language: true,
          source: true,
          isActive: true,
          subscribedAt: true,
        },
      });

      const escapeCsv = (v: string | null | undefined): string => {
        if (v == null) return '';
        const needsQuote = /[",\n\r]/.test(v);
        const escaped = v.replace(/"/g, '""');
        return needsQuote ? `"${escaped}"` : escaped;
      };

      const header = 'email,language,source,active,subscribed_at\n';
      const body = rows
        .map(r =>
          [
            escapeCsv(r.email),
            escapeCsv(r.language),
            escapeCsv(r.source),
            r.isActive ? 'true' : 'false',
            r.subscribedAt.toISOString(),
          ].join(',')
        )
        .join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="newsletter-${storeId}-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      res.send(header + body + (body ? '\n' : ''));
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/newsletter/subscribers/export.xlsx - XLSX download
//
// Sibling to the CSV export above — same query, same column set, formatted
// as an Excel workbook via ExcelJS. Two formats, one source of data.
router.get(
  '/:storeId/newsletter/subscribers/export.xlsx',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rows = await prisma.newsletterSubscriber.findMany({
        where: { storeId },
        orderBy: { subscribedAt: 'desc' },
        select: {
          email: true,
          language: true,
          source: true,
          isActive: true,
          subscribedAt: true,
        },
      });

      const date = new Date().toISOString().slice(0, 10);
      await streamXlsxResponse(res, {
        filename: `newsletter-${storeId}-${date}.xlsx`,
        sheetName: 'Subscribers',
        columns: [
          { header: 'Email', key: 'email', width: 36 },
          { header: 'Language', key: 'language', width: 12 },
          { header: 'Source', key: 'source', width: 16 },
          { header: 'Active', key: 'isActive', width: 10 },
          { header: 'Subscribed At', key: 'subscribedAt', width: 24 },
        ],
        rows: rows.map(r => ({
          email: r.email,
          language: r.language ?? '',
          source: r.source ?? '',
          isActive: r.isActive ? 'true' : 'false',
          subscribedAt: r.subscribedAt.toISOString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
