import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { writeLimiter } from '../middleware/security';
import { runInTenantContext, prisma } from '@force/database';
import {
  createAdjustment,
  postAdjustment,
  listAdjustments,
  getAdjustment,
} from '../services/accounting/stock-adjustment.service';
import { parseStockAdjustCsv, STOCK_ADJUST_ROW_LIMIT } from '@force/shared';

const router = Router();

const itemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  newQty: z.number().int().min(0),
});

const createSchema = z.object({
  type: z.enum([
    'cycle_count',
    'damage',
    'theft',
    'loss',
    'write_off',
    'found',
    'return_to_supplier',
  ]),
  reason: z.string().max(500).optional(),
  reasonAr: z.string().max(500).optional(),
  evidenceUrl: z.string().url().optional(),
  items: z.array(itemSchema).min(1),
});

router.get(
  '/:storeId/stock-adjustments',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  async (req, res, next) => {
    try {
      const from = req.query.from ? new Date(String(req.query.from) + 'T00:00:00') : undefined;
      const to = req.query.to ? new Date(String(req.query.to) + 'T23:59:59') : undefined;
      const data = await runInTenantContext(req.params.storeId, () =>
        listAdjustments(req.params.storeId, { from, to })
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:storeId/stock-adjustments/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        getAdjustment(req.params.storeId, req.params.id)
      );
      if (!data) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:storeId/stock-adjustments',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  writeLimiter,
  async (req, res, next) => {
    try {
      const body = createSchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json({ error: 'validation', issues: body.error.issues });
        return;
      }
      const data = await runInTenantContext(req.params.storeId, () =>
        createAdjustment({
          storeId: req.params.storeId,
          createdBy: req.user?.userId,
          ...body.data,
        })
      );
      res.status(201).json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// ─── CSV bulk-adjust endpoint ────────────────────────────────────────────────
// POST /stores/:storeId/stock-adjustments/csv-import
//
// Accepts a JSON body with the raw CSV text (already read client-side), resolves
// SKU/barcode → productId, translates new_quantity→newQty or applies delta to the
// current inventory value, then calls createAdjustment (draft) + postAdjustment in
// a single flow so the caller gets a fully-posted adjustment back.
//
// Body shape:
//   { csvContent: string, type: StockAdjustmentType, reason?: string, reasonAr?: string,
//     postImmediately?: boolean }
//
// Returns: { data: { adjustmentId, posted, totalRows, importedRows, errors } }
// ─────────────────────────────────────────────────────────────────────────────

const csvImportBodySchema = z.object({
  csvContent: z.string().min(1, 'csvContent is required'),
  type: z.enum([
    'cycle_count',
    'damage',
    'theft',
    'loss',
    'write_off',
    'found',
    'return_to_supplier',
  ]),
  reason: z.string().max(500).optional(),
  reasonAr: z.string().max(500).optional(),
  /** When false (default) creates a draft that the caller must POST separately */
  postImmediately: z.boolean().optional().default(true),
});

router.post(
  '/:storeId/stock-adjustments/csv-import',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  writeLimiter,
  async (req, res, next) => {
    try {
      const bodyParsed = csvImportBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(422).json({ error: 'validation', issues: bodyParsed.error.issues });
        return;
      }
      const { csvContent, type, reason, reasonAr, postImmediately } = bodyParsed.data;
      const storeId = req.params.storeId;

      // Parse + validate the CSV
      const parseResult = parseStockAdjustCsv(csvContent);

      // If every single row has parse errors, bail early
      if (!parseResult.hasValidRows) {
        res.status(422).json({
          error: 'csv_parse_failed',
          message: 'No valid rows found in CSV. Check the errors and resubmit.',
          errors: parseResult.errors,
          totalRows: parseResult.totalRows,
        });
        return;
      }

      // Resolve SKU / barcode → productId for each valid row
      const validRows = parseResult.rows.filter(r => !parseResult.errors[r.rowNumber]);
      const resolveErrors: Record<number, string[]> = {};
      const resolvedItems: Array<{
        productId: string;
        variantId?: string;
        newQty: number;
        rowNumber: number;
      }> = [];

      await runInTenantContext(storeId, async () => {
        for (const row of validRows) {
          // Try SKU first, then barcode
          let product: { id: string } | null = null;
          let variant: { id: string; productId: string; inventory: number } | null = null;

          // SOFT-DELETE SCOPING (all four lookups below).
          //
          // SKU and barcode are only unique among LIVE products — the
          // products_store_id_sku_key index is partial (`WHERE deleted_at IS
          // NULL`) precisely so a merchant can reuse the SKU of a product they
          // deleted, which production already contains a real case of.
          //
          // Without `deletedAt: null` here, `findFirst` can therefore match a
          // SOFT-DELETED product and this import would apply a stock adjustment
          // to it. There is no orderBy, so which row wins is not even
          // deterministic — the same CSV could hit the live product one run and
          // the deleted one the next.
          //
          // Variants have no deleted_at of their own; a variant is dead when its
          // parent product is, so they scope through the relation.
          if (row.sku) {
            // Check variants first (variant SKU is more specific)
            const foundVariant = await prisma.productVariant.findFirst({
              where: { sku: row.sku, product: { storeId, deletedAt: null } },
              select: { id: true, productId: true, inventory: true },
            });
            if (foundVariant) {
              variant = foundVariant;
            } else {
              // Fall back to product SKU
              product = await prisma.product.findFirst({
                where: { sku: row.sku, storeId, deletedAt: null },
                select: { id: true },
              });
            }
          } else if (row.barcode) {
            // Check variants first
            const foundVariant = await prisma.productVariant.findFirst({
              where: { barcode: row.barcode, product: { storeId, deletedAt: null } },
              select: { id: true, productId: true, inventory: true },
            });
            if (foundVariant) {
              variant = foundVariant;
            } else {
              product = await prisma.product.findFirst({
                where: { barcode: row.barcode, storeId, deletedAt: null },
                select: { id: true },
              });
            }
          }

          const identifier = row.sku ? `SKU "${row.sku}"` : `Barcode "${row.barcode}"`;

          if (!product && !variant) {
            resolveErrors[row.rowNumber] = [`No product found for ${identifier}.`];
            continue;
          }

          // Compute newQty
          let newQty: number;
          if (row.newQuantity !== null) {
            newQty = row.newQuantity;
          } else {
            // Delta mode — need current inventory
            const currentQty = variant
              ? variant.inventory
              : ((
                  await prisma.product.findFirst({
                    where: { id: product!.id },
                    select: { inventory: true },
                  })
                )?.inventory ?? 0);
            newQty = Math.max(0, currentQty + (row.delta ?? 0));
          }

          resolvedItems.push({
            productId: variant ? variant.productId : product!.id,
            variantId: variant ? variant.id : undefined,
            newQty,
            rowNumber: row.rowNumber,
          });
        }
      });

      // Merge resolve errors with parse errors
      const allErrors = { ...parseResult.errors, ...resolveErrors };
      const importedItems = resolvedItems.filter(i => !resolveErrors[i.rowNumber]);

      if (importedItems.length === 0) {
        res.status(422).json({
          error: 'no_resolvable_rows',
          message: 'Could not resolve any CSV rows to products in this store.',
          errors: allErrors,
          totalRows: parseResult.totalRows,
        });
        return;
      }

      // Create the adjustment (draft)
      const adjustment = await runInTenantContext(storeId, () =>
        createAdjustment({
          storeId,
          type,
          reason,
          reasonAr,
          createdBy: req.user?.userId,
          items: importedItems.map(i => ({
            productId: i.productId,
            variantId: i.variantId,
            newQty: i.newQty,
          })),
        })
      );

      let posted = false;
      if (postImmediately) {
        await runInTenantContext(storeId, () =>
          postAdjustment(storeId, adjustment.id, req.user?.userId)
        );
        posted = true;
      }

      res.status(201).json({
        data: {
          adjustmentId: adjustment.id,
          adjustmentNumber: adjustment.adjustmentNumber,
          posted,
          totalRows: parseResult.totalRows,
          importedRows: importedItems.length,
          skippedRows: parseResult.totalRows - importedItems.length,
          errors: Object.keys(allErrors).length > 0 ? allErrors : undefined,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/:storeId/stock-adjustments/:id/post',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.bulk_adjustments'),
  writeLimiter,
  async (req, res, next) => {
    try {
      const data = await runInTenantContext(req.params.storeId, () =>
        postAdjustment(req.params.storeId, req.params.id, req.user?.userId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
