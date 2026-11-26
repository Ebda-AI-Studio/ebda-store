import { Router, Request, Response, NextFunction } from 'express';
import { fiscalArchiveHub, fiscalArchiveStoresHub } from '../lib/fiscal-archive-hub';
import { hubStoresById } from '../lib/platform-hub';
import { archiveBucket, backfillOne } from '../lib/fiscal-archive-do';
import {
  listArchivedStores,
  loadArchive,
  pageArchivedDocuments,
} from '../lib/fiscal-archive-store';
import { hubOnD1 } from '../lib/platform-hub';
import { z } from 'zod/v3';
import { prisma, withUser } from '@ebda/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { FiscalDocumentService } from '../services/fiscal-document.service';
import { renderFiscalDocumentHtml } from '../services/fiscal-document-render';
import { fiscalArchive, fiscalArchiveStores } from '../lib/definer';
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
 *   GET /fiscal-archive                                 stores with archived documents
 *   GET /fiscal-archive/:storeId                        a store's archive (deleted ones too)
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
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  docType: z.enum(DOC_TYPES).optional(),
  /** Search by document number (INV-000042) or the number of the document a credit note reverses. */
  q: z.string().trim().min(1).max(64).optional(),
});
/** Keyset list of a deleted store's archive: `cursor` is the previous page's `nextCursor`. */
const archiveListQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d+:[\w-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  docType: z.enum(DOC_TYPES).optional(),
  q: z.string().trim().min(1).max(64).optional(),
});
const localeQuery = z.object({ locale: z.enum(['ar', 'en']).optional() });
const UUID = z.string().uuid();

/**
 * A printable document is inert HTML: every dynamic value is escaped in the renderer, and the response
 * also forbids script (CSP), sniffing and caching, so stored data can never execute in the viewer's origin.
 */
// pq-allow(unused-export): test seam, imported by tests/unit/fiscal-document-html-xss.test.ts
export function sendFiscalHtml(res: Response, html: string): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(html);
}

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
      const storeId = parseInput(UUID, req.params.storeId);
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
      sendFiscalHtml(
        res,
        renderFiscalDocumentHtml(
          doc,
          lang,
          store?.timezone || 'Africa/Cairo',
          (store?.settings as { receiptBarcodeShape?: unknown } | null)?.receiptBarcodeShape
        )
      );
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

/**
 * A DELETED DO store (Ruling FISCAL-ARCHIVE-1): its directory row is retired, so the store DO can no longer be reached through
 * `storeDb`; its documents are read from the platform archive instead. null = the store is live (or has no archive): use the live path.
 */
async function deletedStoreArchive(storeId: string) {
  const r2 = archiveBucket();
  if (!r2 || !(await hubOnD1())) return null;
  if ((await hubStoresById([storeId])).length > 0) return null;
  const a = await loadArchive(r2, storeId);
  if (!a) throw new AppError(404, 'NOT_FOUND', 'No archived fiscal records for this store');
  return a;
}

const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

export const fiscalArchiveRoutes = Router();

fiscalArchiveRoutes.get(
  '/fiscal-archive',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let stores: unknown[];
      if (await hubOnD1()) {
        const live = await fiscalArchiveStoresHub();
        const r2 = archiveBucket();
        const archived: Awaited<ReturnType<typeof listArchivedStores>>['stores'] = [];
        let cursor: string | undefined;
        if (r2)
          do {
            const page = await listArchivedStores(r2, { cursor, limit: 1000 });
            archived.push(...page.stores);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
        const liveIds = new Set(live.map(l => l.storeId));
        stores = [...live, ...archived.filter(a => !liveIds.has(a.storeId))];
      } else stores = await withUser(req.user!.userId, () => fiscalArchiveStores());
      res.json({ success: true, data: { stores } });
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
      const deleted = await deletedStoreArchive(storeId);
      if (deleted) {
        const q = parseInput(archiveListQuery, req.query);
        const { documents, nextCursor } = pageArchivedDocuments(deleted.documents, q);
        res.json({
          success: true,
          data: {
            documents: documents.map(({ payload, ...d }) => ({
              ...d,
              orderNumber: (payload as { orderNumber?: string } | null)?.orderNumber ?? null,
            })),
            nextCursor,
            archive: {
              exportedAt: deleted.manifest.exportedAt,
              retainUntilMax: deleted.manifest.retainUntilMax,
              sha256: deleted.manifest.sha256,
            },
          },
        });
        return;
      }
      const rows = (await hubOnD1())
        ? await fiscalArchiveHub(storeId)
        : await withUser(req.user!.userId, () => fiscalArchive(storeId));
      // The list omits the payload; the HTML route renders a document from it.
      const documents = rows.map(({ payload, ...d }) => ({
        ...d,
        orderNumber: (payload as { orderNumber?: string } | null)?.orderNumber ?? null,
      }));
      res.json({ success: true, data: { documents } });
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
      const deleted = await deletedStoreArchive(storeId);
      if (deleted) {
        const d = deleted.documents.find(r => r.id === docId);
        if (!d) throw new AppError(404, 'NOT_FOUND', 'Document not found');
        sendFiscalHtml(res, renderFiscalDocumentHtml(d, locale ?? 'ar'));
        return;
      }
      const rows = (await hubOnD1())
        ? await fiscalArchiveHub(storeId)
        : await withUser(req.user!.userId, () => fiscalArchive(storeId));
      const doc = rows.find(r => r.id === docId);
      if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
      sendFiscalHtml(res, renderFiscalDocumentHtml(doc, locale ?? 'ar'));
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Backfill of DO stores deleted before the platform archive existed (Ruling FISCAL-ARCHIVE-1). Super-admin + MFA. Read-only unless
 * `?apply=1`; idempotent. Refuses anything that is not a retired DO store.
 */
fiscalArchiveRoutes.post(
  '/fiscal-archive/:storeId/backfill',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = parseInput(UUID, req.params.storeId);
      const result = await backfillOne(storeId, req.query.apply === '1');
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);
