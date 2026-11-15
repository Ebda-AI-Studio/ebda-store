import { Router, Request, Response, NextFunction } from 'express';
import { fiscalArchiveHub, fiscalArchiveStoresHub } from '../lib/fiscal-archive-hub';
import { hubOnD1 } from '../lib/platform-hub';
import { z } from 'zod/v3';
import { prisma, withUser } from '@ebda/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { FiscalDocumentService } from '../services/fiscal-document.service';
import { renderFiscalDocumentHtml } from '../services/fiscal-document-render';
import { fiscalArchive, fiscalArchiveStores } from '../lib/definer';
import {
  defaultPeriod,
  fiscalStoreSummary,
  pageFiscalRows,
  listFiscalDocuments,
} from '../services/fiscal-document-list';
import { etaForDocument } from '../services/fiscal-document-eta';
import { hubFanout } from '../lib/platform-hub';
import logger from '../lib/logger';
import { parseInput } from '../lib/parse-input';
import { AppError } from '../middleware/error-handler';

/**
 * Fiscal documents (rulings MONEYB-1, MONEYB-4).
 *
 * Merchant (tenant router, mounted under `/stores` with tenantContext):
 *   GET /:storeId/fiscal-documents                      the Invoices page list
 *   GET /:storeId/fiscal-documents/:docId/html          a document as issued (print)
 *   GET /:storeId/orders/:orderId/fiscal-documents      an order's documents
 *
 * Super-admin (mounted under `/admin`):
 *   GET /fiscal-archive?from&to                         stores with archived documents + period totals / tax status
 *   GET /fiscal-archive/:storeId?cursor&limit&docType&q&from&to[&summary=1]   a store's archive page (deleted ones too);
 *                                                       `summary=1` adds the store card for the current month
 *   GET /fiscal-archive/:storeId/:docId/html            one archived document
 *
 * Read-only by construction: documents are written only by the sale / refund /
 * store-deletion paths and are immutable in the database.
 */

const DOC_TYPES = [
  'tax_invoice',
  'receipt',
  'credit_note',
  'refund_receipt',
  'order_record',
  'billing_record',
] as const;

const listQuery = z.object({
  /** Opaque keyset cursor `<issued_at ISO>_<id>` from a previous page's `nextCursor`. */
  cursor: z
    .string()
    .regex(/^.+Z_[0-9a-f-]{36}$/i)
    .max(80)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  docType: z.enum(DOC_TYPES).optional(),
  /** Search by document number (INV-000042) or the number of the document a credit note reverses. */
  q: z.string().trim().min(1).max(64).optional(),
  /** Issue-date range (ISO instants). */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const periodQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const archiveListQuery = listQuery.extend({ summary: z.enum(['1']).optional() });
const localeQuery = z.object({ locale: z.enum(['ar', 'en']).optional() });
const UUID = z.string().uuid();

const merchant = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
];

export const fiscalDocumentRoutes = Router();

fiscalDocumentRoutes.get(
  '/:storeId/fiscal-documents',
  ...merchant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const q = parseInput(listQuery, req.query);
      const result = await FiscalDocumentService.list(storeId, q);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

fiscalDocumentRoutes.get(
  '/:storeId/fiscal-documents/:docId/html',
  ...merchant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const docId = parseInput(UUID, req.params.docId);
      const { locale } = parseInput(localeQuery, req.query);
      const doc = await FiscalDocumentService.getById(storeId, docId);
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { timezone: true, settings: true },
      });
      const lang =
        locale ??
        ((store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en'
          ? 'en'
          : 'ar');
      const eta = await etaForDocument(storeId, doc);
      res
        .type('html')
        .send(renderFiscalDocumentHtml(doc, lang, store?.timezone || 'Africa/Cairo', eta));
    } catch (error) {
      next(error);
    }
  }
);

fiscalDocumentRoutes.get(
  '/:storeId/orders/:orderId/fiscal-documents',
  ...merchant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const orderId = parseInput(UUID, req.params.orderId);
      const documents = await FiscalDocumentService.documentsForOrder(storeId, orderId);
      res.json({ success: true, data: { documents } });
    } catch (error) {
      next(error);
    }
  }
);

const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

export const fiscalArchiveRoutes = Router();

/** The retained Postgres copy (SECURITY DEFINER), which still holds a deleted store's documents. */
function archiveRowsViaDefiner(userId: string, storeId: string) {
  return withUser(userId, () => fiscalArchive(storeId));
}

async function archiveRows(userId: string, storeId: string) {
  return (await hubOnD1())
    ? await fiscalArchiveHub(storeId)
    : await withUser(userId, () => fiscalArchive(storeId));
}

fiscalArchiveRoutes.get(
  '/fiscal-archive',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = parseInput(periodQuery, req.query);
      const period = {
        ...defaultPeriod(),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
      };
      const userId = req.user!.userId;
      let base = (await hubOnD1())
        ? await fiscalArchiveStoresHub()
        : await withUser(userId, () => fiscalArchiveStores());
      if (await hubOnD1()) {
        // Deleted stores have no live tables: the retained Postgres copy still lists them (7-year retention).
        const kept = await (async () => withUser(userId, () => fiscalArchiveStores()))().catch(
          err => {
            logger.warn({ err }, '[FISCAL] retained archive store list unavailable');
            return [];
          }
        );
        const have = new Set(base.map(s => s.storeId));
        base = [...base, ...kept.filter(s => !s.storeExists && !have.has(s.storeId))];
      }
      // Live stores get their period totals + tax / ETA status; a deleted store has no live tables, so null.
      const live = base.filter(s => s.storeExists).map(s => s.storeId);
      const summaries = new Map(
        (
          await hubFanout(
            live,
            id => fiscalStoreSummary(id, period),
            (id, err) => logger.warn({ err, storeId: id }, '[FISCAL] archive summary failed')
          )
        ).map(r => [r.storeId, r.value])
      );
      const stores = base.map(s => ({ ...s, summary: summaries.get(s.storeId) ?? null }));
      res.json({ success: true, data: { stores, period } });
    } catch (error) {
      next(error);
    }
  }
);

fiscalArchiveRoutes.get(
  '/fiscal-archive/:storeId',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const { summary: withSummary, ...f } = parseInput(archiveListQuery, req.query);
      // Live store = keyset query on its own tables. A store that no longer has live tables (deleted: the 7-year
      // retention case) is read from the retained Postgres copy through the definer, paged in memory. If neither
      // source answers, say so (`unavailable`) instead of failing the page.
      const userId = req.user!.userId;
      const retained = async () =>
        pageFiscalRows(storeId, await archiveRowsViaDefiner(userId, storeId), f);
      let result: Awaited<ReturnType<typeof listFiscalDocuments>> & { unavailable?: true };
      if (await hubOnD1()) {
        const unfiltered = !f.cursor && !f.docType && !f.q && !f.from && !f.to;
        try {
          result = await listFiscalDocuments(storeId, f);
          if (unfiltered && result.documents.length === 0) {
            const kept = await retained().catch(() => null);
            if (kept && kept.documents.length) result = kept;
          }
        } catch (liveErr) {
          logger.warn(
            { err: liveErr, storeId },
            '[FISCAL] live archive unavailable, trying retained copy'
          );
          result = await retained().catch(err => {
            logger.warn({ err, storeId }, '[FISCAL] retained archive unavailable');
            return { documents: [], nextCursor: null, unavailable: true as const };
          });
        }
      } else {
        result = await retained();
      }
      // The store card (current month); null for a store that no longer exists.
      const summary = withSummary
        ? await fiscalStoreSummary(storeId, defaultPeriod()).catch(() => null)
        : undefined;
      res.json({ success: true, data: { ...result, ...(withSummary ? { summary } : {}) } });
    } catch (error) {
      next(error);
    }
  }
);

fiscalArchiveRoutes.get(
  '/fiscal-archive/:storeId/:docId/html',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const docId = parseInput(UUID, req.params.docId);
      const { locale } = parseInput(localeQuery, req.query);
      const rows = await archiveRows(req.user!.userId, storeId);
      const doc = rows.find(r => r.id === docId);
      if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
      const eta = await etaForDocument(storeId, doc);
      res.type('html').send(renderFiscalDocumentHtml(doc, locale ?? 'ar', 'Africa/Cairo', eta));
    } catch (error) {
      next(error);
    }
  }
);
