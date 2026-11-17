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
      const rawShape = (store?.settings as { receiptBarcodeShape?: unknown } | null)
        ?.receiptBarcodeShape;
      res.type('html').send(
        renderFiscalDocumentHtml(doc, lang, store?.timezone || 'Africa/Cairo', {
          barcodeShape: typeof rawShape === 'string' ? rawShape : 'plain',
        })
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

const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

export const fiscalArchiveRoutes = Router();

fiscalArchiveRoutes.get(
  '/fiscal-archive',
  ...superAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stores = (await hubOnD1())
        ? await fiscalArchiveStoresHub()
        : await withUser(req.user!.userId, () => fiscalArchiveStores());
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
      const rows = (await hubOnD1())
        ? await fiscalArchiveHub(storeId)
        : await withUser(req.user!.userId, () => fiscalArchive(storeId));
      const doc = rows.find(r => r.id === docId);
      if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
      res.type('html').send(renderFiscalDocumentHtml(doc, locale ?? 'ar'));
    } catch (error) {
      next(error);
    }
  }
);
