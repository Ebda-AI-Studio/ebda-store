import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb } from '../lib/repo-factory';
import { csvField } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { writeLimiter } from '../middleware/security';
import { streamXlsxResponse } from '../lib/exports/xlsx';
import {
  BROADCAST_MAX_RECIPIENTS,
  broadcastNewsletter,
} from '../services/newsletter-broadcast.service';

/**
 * Admin newsletter routes — list + CSV export of subscribers for a store.
 *
 * The customer-facing signup endpoint lives in `public.routes.ts`. This
 * file is store-admin only and goes through the same auth chain as every
 * other admin route (authenticate → authorize → requireStoreAccess).
 */
/** BE:E-5: exports and the broadcast read are bounded (a tenant-sized list must never be loaded whole). */
const EXPORT_MAX_ROWS = 50_000;

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

      // the list lives on the store's own backend (Ruling CF-R4-4)
      const db = await storeDb(storeId);
      const [subscribers, total] = await Promise.all([
        db.newsletterSubscriber.findMany({
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
        db.newsletterSubscriber.count({ where: { storeId } }),
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

      const rows = await (
        await storeDb(storeId)
      ).newsletterSubscriber.findMany({
        where: { storeId },
        orderBy: { subscribedAt: 'desc' },
        take: EXPORT_MAX_ROWS,
        select: {
          email: true,
          language: true,
          source: true,
          isActive: true,
          subscribedAt: true,
        },
      });

      const header = 'email,language,source,active,subscribed_at\n';
      const body = rows
        .map(r =>
          [
            csvField(r.email),
            csvField(r.language),
            csvField(r.source),
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

      const rows = await (
        await storeDb(storeId)
      ).newsletterSubscriber.findMany({
        where: { storeId },
        orderBy: { subscribedAt: 'desc' },
        take: EXPORT_MAX_ROWS,
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

// ==========================================
// Newsletter broadcast
// ==========================================

const broadcastSchema = z.object({
  subject: z.string().min(1).max(300),
  html: z.string().min(1),
  text: z.string().optional(),
  /** Optional: only send to this language segment (e.g. 'ar', 'en'). */
  language: z.string().max(10).optional(),
});

// POST /stores/:storeId/newsletter/broadcast
//
// Sends a newsletter email to all active subscribers of the store.
// The body HTML is rendered inside the store's branded email shell so
// the message has the store's header/footer.
//
// Rate / scale note: for very large lists (>1000) this should move to an
// Inngest job for fan-out.  For current tenant sizes a single Resend batch
// call is fine — Resend allows up to 100 recipients per API call, so we
// chunk automatically below.
router.post(
  '/:storeId/newsletter/broadcast',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('email_campaigns'), // BE:S-5: the same plan gate as the campaigns twin
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = broadcastSchema.parse(req.body);

      const result = await broadcastNewsletter(storeId, body);

      if (result.kind === 'store_not_found') {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
        return;
      }
      if (result.kind === 'too_large') {
        res.status(413).json({
          success: false,
          error: {
            code: 'BROADCAST_TOO_LARGE',
            message: `A broadcast reaches at most ${BROADCAST_MAX_RECIPIENTS} subscribers; use a campaign.`,
          },
        });
        return;
      }
      if (result.kind === 'empty') {
        res.json({ success: true, data: { sent: 0, message: 'No active subscribers to send to' } });
        return;
      }
      res.json({
        success: true,
        data: {
          sent: result.sent,
          total: result.total,
          errors: result.errors.length > 0 ? result.errors : undefined,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
