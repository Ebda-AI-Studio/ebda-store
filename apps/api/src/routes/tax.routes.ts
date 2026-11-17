import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import multer from 'multer';
import {
  TAX_DOCUMENT_KINDS,
  TAX_DOCUMENT_MAX_BYTES,
  taxProfileDetailsSchema,
  taxProfileSubmitSchema,
} from '@ebda/shared';
import { TaxService } from '../services/tax.service';
import { TaxProfileService } from '../services/tax-profile.service';
import { tenantContext } from '../middleware/tenant-context';
import { uploadLimiter, dailyUploadLimiter } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { parseInput } from '../lib/parse-input';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/done/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// NOT behind `requireFeature('tax')` (issue 2358, ruling TAX-1a). Collection is
// gated on `Store.taxEnabled` AND a verified VAT registration (ruling TAX-2,
// which supersedes TAX-1's "taxEnabled alone"; still not a plan feature), so
// the switch that turns it on or off and the rate list that sets what it charges must be reachable on EVERY plan — a store that lapsed
// to `free` kept charging VAT while every route here 403'd. The `tax` feature
// is reserved for ADVANCED tax features (region-scoped or compound rates);
// none exists today, so nothing here is gated by it.

// Validation schemas
//
// `.strict()` (issue 2357, ruling TAX-1a): the charge reads only `taxEnabled`,
// `taxIncludedInPrice` and the SUM of every active rate's `rate`
// (lib/order-tax.ts). Keys it does not read — `defaultTaxRate`, and a rate's
// `country`/`state`/`priority`/`isCompound` — are REJECTED (400), never
// accepted and silently ignored: a merchant who set "KW 5%" and "SA 15%"
// would otherwise have every order charged 20%.
const updateSettingsSchema = z
  .object({
    taxEnabled: z.boolean().optional(),
    taxIncludedInPrice: z.boolean().optional(),
  })
  .strict();

// `nameAr` is `.nullable()` so an emptied field on the edit modal CLEARS it:
// Prisma reads `null` as "set to NULL", `undefined` (omitted key) as "leave
// alone". Without the null form the merchant's clear no-ops.
export const createTaxRateSchema = z
  .object({
    name: z.string().min(1).max(100),
    nameAr: z.string().max(100).optional().nullable(),
    rate: z.number().min(0).max(100),
    isActive: z.boolean().optional(),
  })
  .strict();

export const updateTaxRateSchema = createTaxRateSchema.partial();

// GET /stores/:storeId/tax/settings - Get tax settings
router.get(
  '/:storeId/tax/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const settings = await TaxService.getSettings(storeId);

      res.json({
        success: true,
        data: { settings },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/tax/settings - Update tax settings
router.put(
  '/:storeId/tax/settings',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = updateSettingsSchema.parse(req.body);

      const settings = await TaxService.updateSettings(storeId, data);

      res.json({
        success: true,
        data: { settings },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/tax/rates - List tax rates
router.get(
  '/:storeId/tax/rates',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { includeInactive } = req.query;

      const rates = await TaxService.listRates(storeId, includeInactive === 'true');

      res.json({
        success: true,
        data: { rates },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/tax/rates/:id - Get tax rate by ID
router.get(
  '/:storeId/tax/rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const rate = await TaxService.getRate(storeId, id);

      res.json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/tax/rates - Create tax rate
router.post(
  '/:storeId/tax/rates',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createTaxRateSchema.parse(req.body);

      const rate = await TaxService.createRate(storeId, data);

      res.status(201).json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/tax/rates/:id - Update tax rate
router.put(
  '/:storeId/tax/rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateTaxRateSchema.parse(req.body);

      const rate = await TaxService.updateRate(storeId, id, data);

      res.json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/tax/rates/:id - Delete tax rate
router.delete(
  '/:storeId/tax/rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      await TaxService.deleteRate(storeId, id);

      res.json({
        success: true,
        data: { message: 'Tax rate deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/tax/rates/:id/toggle - Toggle tax rate active status
router.patch(
  '/:storeId/tax/rates/:id/toggle',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const rate = await TaxService.toggleRate(storeId, id);

      res.json({
        success: true,
        data: { rate },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ── VAT registration (ruling TAX-2) ──────────────────────────────────────────
// The merchant's VAT-registration profile: TRN + legal name + evidence, then
// "submit for review". A super-admin approves it (routes/tax-verification.routes.ts);
// only then can `taxEnabled` be switched on and VAT be charged.

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAX_DOCUMENT_MAX_BYTES, files: 1 },
});
const documentKindSchema = z.object({ kind: z.enum(TAX_DOCUMENT_KINDS) }).strict();

function actorOf(req: Request) {
  return { userId: req.user!.userId, ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

// GET /stores/:storeId/tax/profile - VAT registration status + documents (no file URLs)
router.get(
  '/:storeId/tax/profile',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await TaxProfileService.get(req.params.storeId);
      res.json({ success: true, data: { profile } });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/tax/profile - TRN + legal name (only while none/rejected/revoked)
router.put(
  '/:storeId/tax/profile',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = parseInput(taxProfileDetailsSchema, req.body);
      const profile = await TaxProfileService.updateDetails(req.params.storeId, data, actorOf(req));
      res.json({ success: true, data: { profile } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/tax/profile/documents - upload one evidence file (multipart: file, kind)
router.post(
  '/:storeId/tax/profile/documents',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  uploadLimiter,
  dailyUploadLimiter,
  documentUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new AppError(400, 'NO_FILE', 'No file uploaded. Send field name: file');
      const { kind } = parseInput(documentKindSchema, { kind: req.body?.kind });
      const document = await TaxProfileService.addDocument(
        req.params.storeId,
        kind,
        { buffer: req.file.buffer, originalname: req.file.originalname },
        actorOf(req)
      );
      res.status(201).json({ success: true, data: { document } });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/tax/profile/documents/:documentId/file - the bytes, never a URL (ruling TAX-4)
router.get(
  '/:storeId/tax/profile/documents/:documentId/file',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = await TaxProfileService.readDocument(req.params.storeId, req.params.documentId);
      sendTaxDocument(res, file);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/tax/profile/documents/:documentId
router.delete(
  '/:storeId/tax/profile/documents/:documentId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await TaxProfileService.deleteDocument(
        req.params.storeId,
        req.params.documentId,
        actorOf(req)
      );
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/tax/profile/submit - attest + send for super-admin review
router.post(
  '/:storeId/tax/profile/submit',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      parseInput(taxProfileSubmitSchema, req.body);
      const profile = await TaxProfileService.submit(req.params.storeId, actorOf(req));
      res.json({ success: true, data: { profile } });
    } catch (error) {
      next(error);
    }
  }
);

/** One evidence file as a private, non-cacheable, non-sniffable download. */
export function sendTaxDocument(
  res: Response,
  file: { body: Buffer; mimeType: string; fileName: string }
): void {
  const safeName = file.fileName.replace(/[^\w.\- ]/g, '_');
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.body);
}

// REMOVED (issue 2211 / issue 2167): `POST /public/:storeId/tax/calculate`
// and `TaxService.calculateTax` behind it. Nothing in apps/web, apps/admin or
// apps/orders called it, and it was a SECOND, differently-gated tax resolver
// reachable unauthenticated: it ignored `Store.taxEnabled`, taxed the raw
// subtotal (not subtotal − discount), never extracted an inclusive price, and
// summed multi-rate/compound/country rates plus `defaultTaxRate` — none of
// which the charge does. `resolveActiveTaxRate` (lib/order-tax.ts) is the one
// resolver for both the charge and the storefront display; a surface that
// needs a tax quote calls it (and `computeOrderTax`), never a parallel model.

export default router;
