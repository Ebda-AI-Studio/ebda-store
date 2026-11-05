import { Router } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { writeLimiter } from '../middleware/security';

import { uniqueViolationTarget } from '../lib/prisma-errors';
import { storeDb } from '../lib/repo-factory';
import {
  createAdjustment,
  postAdjustment,
  listAdjustments,
  getAdjustment,
  findAdjustmentByImportKey,
} from '../services/accounting/stock-adjustment.service';
import { parseStockAdjustCsv, STOCK_ADJUST_ROW_LIMIT } from '@ebda/shared';
import { rangeOrLegacyDays } from '../lib/report-range';
import { runInStoreCtx } from '../lib/jobs/store-db';

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
      // Shared report-range contract (viewer-local days); legacy date-only
      // `from`/`to` still accepted as UTC days.
      const range = rangeOrLegacyDays(req.query as Record<string, unknown>);
      if (!range.ok) {
        res.status(422).json({
          success: false,
          error: { code: 'validation_failed', message: 'Invalid date range.' },
        });
        return;
      }
      const { from, to } = range;
      const data = await runInStoreCtx(req.params.storeId, () =>
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
      const data = await runInStoreCtx(req.params.storeId, () =>
        getAdjustment(req.params.storeId, req.params.id)
      );
      if (!data) {
        res.status(404).json({
          success: false,
          error: { code: 'not_found', message: 'Stock adjustment not found.' },
        });
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
        res.status(422).json({
          success: false,
          error: {
            code: 'validation',
            message: 'Validation failed.',
            details: { issues: body.error.issues },
          },
        });
        return;
      }
      const data = await runInStoreCtx(req.params.storeId, () =>
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
//     postImmediately?: boolean, idempotencyKey?: string }
//
// Returns: { data: { adjustmentId, posted, totalRows, importedRows, errors, replayed? } }
//
// IDEMPOTENCY (#226). The post is irreversible (inventory + GL), so a retried
// request must not import twice — in delta mode the second import would
// re-read the stock the first one had already moved and apply the delta again.
// The admin client sends one `idempotencyKey` per loaded file; a request that
// repeats a key gets the FIRST import's adjustment back with `replayed: true`
// (HTTP 200) instead of a new one. Two in-flight requests with the same key
// meet at the (store_id, import_key) unique index: the second INSERT waits for
// the first and then loses with P2002, which is answered the same way. A
// request without a key (an older admin bundle) behaves exactly as before.
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
  /** One per loaded file, generated by the client (#226). */
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/, 'idempotencyKey must be 16-64 url-safe characters')
    .optional(),
});

function isImportKeyConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code } = err as { code?: unknown };
  if (code !== 'P2002') return false;
  const fields = uniqueViolationTarget(err);
  return fields.some(f => f.includes('import_key') || f.includes('importKey'));
}

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
        res.status(422).json({
          success: false,
          error: {
            code: 'validation',
            message: 'Validation failed.',
            details: { issues: bodyParsed.error.issues },
          },
        });
        return;
      }
      const { csvContent, type, reason, reasonAr, postImmediately, idempotencyKey } =
        bodyParsed.data;
      const storeId = req.params.storeId;

      // Parse + validate the CSV
      const parseResult = parseStockAdjustCsv(csvContent);

      const replay = async (): Promise<boolean> => {
        if (!idempotencyKey) return false;
        const prior = await runInStoreCtx(storeId, () =>
          findAdjustmentByImportKey(storeId, idempotencyKey)
        );
        if (!prior) return false;
        res.status(200).json({
          data: {
            adjustmentId: prior.id,
            adjustmentNumber: prior.adjustmentNumber,
            posted: prior.status === 'posted',
            totalRows: parseResult.totalRows,
            importedRows: prior._count.items,
            skippedRows: Math.max(0, parseResult.totalRows - prior._count.items),
            replayed: true,
          },
        });
        return true;
      };

      if (await replay()) return;

      // If every single row has parse errors, bail early
      if (!parseResult.hasValidRows) {
        res.status(422).json({
          success: false,
          error: {
            code: 'csv_parse_failed',
            message: 'No valid rows found in CSV. Check the errors and resubmit.',
            details: { errors: parseResult.errors, totalRows: parseResult.totalRows },
          },
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

      // Resolve every identifier in FOUR batched queries rather than 1-3
      // sequential queries per row (#225): a 5,000-row file used to issue up to
      // ~10,000 round trips inside one tenant transaction.
      //
      // SOFT-DELETE SCOPING (all four lookups below).
      //
      // SKU and barcode are only unique among LIVE products — the
      // products_store_id_sku_key index is partial (`WHERE deleted_at IS
      // NULL`) precisely so a merchant can reuse the SKU of a product they
      // deleted, which production already contains a real case of. Without
      // `deletedAt: null` a lookup can match a SOFT-DELETED product and this
      // import would apply a stock adjustment to it.
      //
      // Variants have no deleted_at of their own; a variant is dead when its
      // parent product is, so they scope through the relation.
      const skus = [...new Set(validRows.flatMap(r => (r.sku ? [r.sku] : [])))];
      const barcodes = [
        ...new Set(validRows.flatMap(r => (!r.sku && r.barcode ? [r.barcode] : []))),
      ];
      // First hit per key wins. The per-row findFirst this replaces had no
      // orderBy at all, so the explicit id order below is strictly more stable.
      const firstBy = <T>(rows: T[], key: (row: T) => string | null) => {
        const out = new Map<string, T>();
        for (const row of rows) {
          const k = key(row);
          if (k && !out.has(k)) out.set(k, row);
        }
        return out;
      };

      // a store on its Durable Object is looked up there (Ruling CF-R7-1), the same way it is written
      const sdb = await storeDb(storeId);
      const lookups = await runInStoreCtx(storeId, async () => {
        const liveProduct = { storeId, deletedAt: null };
        const variantSelect = {
          id: true,
          productId: true,
          inventory: true,
          sku: true,
          barcode: true,
        } as const;
        const productSelect = {
          id: true,
          inventory: true,
          sku: true,
          barcode: true,
          variants: { select: { id: true }, take: 1 },
        } as const;
        const [variantsBySku, productsBySku, variantsByBarcode, productsByBarcode] =
          await Promise.all([
            sdb.productVariant.findMany({
              where: { sku: { in: skus }, product: liveProduct },
              select: variantSelect,
              orderBy: { id: 'asc' },
            }),
            sdb.product.findMany({
              where: { sku: { in: skus }, ...liveProduct },
              select: productSelect,
              orderBy: { id: 'asc' },
            }),
            sdb.productVariant.findMany({
              where: { barcode: { in: barcodes }, product: liveProduct },
              select: variantSelect,
              orderBy: { id: 'asc' },
            }),
            sdb.product.findMany({
              where: { barcode: { in: barcodes }, ...liveProduct },
              select: productSelect,
              orderBy: { id: 'asc' },
            }),
          ]);
        return {
          variantBySku: firstBy(variantsBySku, v => v.sku),
          productBySku: firstBy(productsBySku, p => p.sku),
          variantByBarcode: firstBy(variantsByBarcode, v => v.barcode),
          productByBarcode: firstBy(productsByBarcode, p => p.barcode),
        };
      });

      for (const row of validRows) {
        // Variant first (a variant SKU/barcode is more specific), then product.
        const variant = row.sku
          ? lookups.variantBySku.get(row.sku)
          : row.barcode
            ? lookups.variantByBarcode.get(row.barcode)
            : undefined;
        const product = variant
          ? undefined
          : row.sku
            ? lookups.productBySku.get(row.sku)
            : row.barcode
              ? lookups.productByBarcode.get(row.barcode)
              : undefined;

        const identifier = row.sku ? `SKU "${row.sku}"` : `Barcode "${row.barcode}"`;

        if (!product && !variant) {
          resolveErrors[row.rowNumber] = [`No product found for ${identifier}.`];
          continue;
        }

        // A product that has variants keeps its stock on the variants; its
        // own column is held at 0 and moves nothing
        // (docs/architecture/inventory-model.md). Writing it would report a
        // successful adjustment — and post its value to the GL — while the
        // sellable stock stayed where it was.
        if (product && product.variants.length > 0) {
          resolveErrors[row.rowNumber] = [
            `${identifier} is a product with variants. Use the variant's SKU or barcode instead.`,
          ];
          continue;
        }

        // Delta mode applies to the stock read above, in the same request.
        const currentQty = variant ? variant.inventory : product!.inventory;
        const newQty =
          row.newQuantity !== null ? row.newQuantity : Math.max(0, currentQty + (row.delta ?? 0));

        resolvedItems.push({
          productId: variant ? variant.productId : product!.id,
          variantId: variant ? variant.id : undefined,
          newQty,
          rowNumber: row.rowNumber,
        });
      }

      // Merge resolve errors with parse errors
      const allErrors = { ...parseResult.errors, ...resolveErrors };
      const importedItems = resolvedItems.filter(i => !resolveErrors[i.rowNumber]);

      if (importedItems.length === 0) {
        res.status(422).json({
          success: false,
          error: {
            code: 'no_resolvable_rows',
            message: 'Could not resolve any CSV rows to products in this store.',
            details: { errors: allErrors, totalRows: parseResult.totalRows },
          },
        });
        return;
      }

      // Create the adjustment (draft). Its own transaction, so a lost
      // import-key race rolls back only this INSERT and the replay below
      // reads the winner on a fresh connection.
      let adjustment: Awaited<ReturnType<typeof createAdjustment>>;
      try {
        adjustment = await runInStoreCtx(storeId, () =>
          createAdjustment({
            storeId,
            type,
            reason,
            reasonAr,
            createdBy: req.user?.userId,
            importKey: idempotencyKey,
            items: importedItems.map(i => ({
              productId: i.productId,
              variantId: i.variantId,
              newQty: i.newQty,
            })),
          })
        );
      } catch (err) {
        if (isImportKeyConflict(err) && (await replay())) return;
        throw err;
      }

      let posted = false;
      if (postImmediately) {
        await runInStoreCtx(storeId, () =>
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
      const data = await runInStoreCtx(req.params.storeId, () =>
        postAdjustment(req.params.storeId, req.params.id, req.user?.userId)
      );
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
