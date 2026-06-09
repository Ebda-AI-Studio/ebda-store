import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { streamXlsxResponse } from '../lib/exports/xlsx';
import { ResendService } from '../services/resend.service';
import { renderBrandedShell } from '../services/email.service';
import { sanitizeNewsletterHtml } from '../lib/email-html-sanitizer';
import logger from '../lib/logger';

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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = broadcastSchema.parse(req.body);

      // Fetch the store context for the branded shell.
      // `defaultLanguage` lives inside the `settings` JSON column, not a
      // first-class column, so we read `settings` and extract it manually.
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          nameAr: true,
          logo: true,
          email: true,
          phone: true,
          address: true,
          settings: true,
          theme: true,
          emailSenderLocalPart: true,
          emailDomainStatus: true,
          domain: true,
        },
      });

      if (!store) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
        return;
      }

      // Fetch all active subscribers (optionally filtered by language)
      const where: Record<string, unknown> = { storeId, isActive: true };
      if (body.language) where.language = body.language;

      const subscribers = await prisma.newsletterSubscriber.findMany({
        where,
        select: { email: true },
      });

      if (subscribers.length === 0) {
        res.json({ success: true, data: { sent: 0, message: 'No active subscribers to send to' } });
        return;
      }

      const emails = subscribers.map(s => s.email);

      const settingsJson = store.settings as Record<string, unknown> | null;
      const defaultLanguage: 'en' | 'ar' = settingsJson?.defaultLanguage === 'ar' ? 'ar' : 'en';

      // Wrap the provided HTML in the branded shell
      const storeContext = {
        name: store.name,
        nameAr: store.nameAr,
        logo: store.logo,
        email: store.email,
        phone: store.phone,
        address: store.address,
        defaultLanguage,
        theme: store.theme as { primaryColor?: string | null; primary?: string | null } | null,
      };
      // Sanitize the merchant-composed HTML before relaying it to every
      // subscriber: strip <script>/<iframe>/<object> etc., on* handlers, and
      // javascript:/data: URLs. Stops a careless or malicious admin from
      // broadcasting active/phishing content through our sender reputation.
      const safeHtml = sanitizeNewsletterHtml(body.html);
      const wrappedHtml = renderBrandedShell(safeHtml, storeContext);

      // Send in chunks of 50 (well within Resend's per-call limit)
      const CHUNK = 50;
      let sent = 0;
      const errors: string[] = [];

      for (let i = 0; i < emails.length; i += CHUNK) {
        const chunk = emails.slice(i, i + CHUNK);
        try {
          await ResendService.sendBrandedEmail(storeId, {
            to: chunk,
            subject: body.subject,
            html: wrappedHtml,
            text: body.text,
          });
          sent += chunk.length;
        } catch (err: any) {
          const msg = err?.message ?? 'send failed';
          logger.error({ err, storeId, chunk: i / CHUNK }, '[Newsletter] Chunk send error');
          errors.push(msg);
        }
      }

      logger.info({ storeId, sent, errors: errors.length }, '[Newsletter] Broadcast complete');

      res.json({
        success: true,
        data: {
          sent,
          total: emails.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
