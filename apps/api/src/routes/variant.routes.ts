import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { VariantService } from '../services/variant.service';
import { tenantContext } from '../middleware/tenant-context';
import { optionValueSwatchSchema } from '@ebda/shared';

const router = Router();

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/done/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// Validation schemas
export const createOptionSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional(),
  values: z
    .array(
      z
        .object({
          value: z.string().min(1).max(100),
          valueAr: z.string().max(100).optional(),
        })
        .merge(optionValueSwatchSchema)
    )
    .min(1)
    .max(50),
});

const updateOptionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  nameAr: z.string().max(100).optional().nullable(),
});

export const createOptionValueSchema = z
  .object({
    value: z.string().min(1).max(100),
    valueAr: z.string().max(100).optional(),
  })
  .merge(optionValueSwatchSchema);

export const updateOptionValueSchema = z
  .object({
    value: z.string().min(1).max(100).optional(),
    valueAr: z.string().max(100).optional().nullable(),
  })
  .merge(optionValueSwatchSchema);

const createVariantSchema = z.object({
  sku: z.string().max(100).optional(),
  barcode: z.string().max(100).optional(),
  price: z.number().int().min(0).optional(),
  compareAtPrice: z.number().int().min(0).optional(),
  costPrice: z.number().int().min(0).optional(),
  inventory: z.number().int().min(0).optional(),
  weight: z.number().min(0).optional(),
  // Per-variant image. Nullable so the admin form can post explicit null
  // (e.g. when the merchant clears a previously-uploaded image before
  // submitting); undefined = leave alone, mirroring the costPrice pattern.
  imageUrl: z.string().url().nullable().optional(),
  optionValueIds: z.array(z.string().uuid()).min(1).max(3),
});

const updateVariantSchema = z.object({
  sku: z.string().max(100).optional().nullable(),
  barcode: z.string().max(100).optional().nullable(),
  price: z.number().int().min(0).optional().nullable(),
  compareAtPrice: z.number().int().min(0).optional().nullable(),
  costPrice: z.number().int().min(0).optional().nullable(),
  inventory: z.number().int().min(0).optional(),
  weight: z.number().min(0).optional().nullable(),
  imageUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
});

const bulkInventorySchema = z.object({
  updates: z
    .array(
      z.object({
        variantId: z.string().uuid(),
        inventory: z.number().int().min(0),
      })
    )
    .min(1)
    .max(100),
});

const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

// GET /stores/:storeId/products/:productId/variants - Get product variants
router.get(
  '/:storeId/products/:productId/variants',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const result = await VariantService.getProductVariants(storeId, productId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/:productId/options - Add option to product
router.post(
  '/:storeId/products/:productId/options',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const data = createOptionSchema.parse(req.body);

      const option = await VariantService.addOption(storeId, productId, data);

      res.status(201).json({
        success: true,
        data: { option },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/:productId/options/reorder - Reorder options
// NOTE: Must be registered BEFORE /:optionId to avoid being shadowed
router.put(
  '/:storeId/products/:productId/options/reorder',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { ids } = reorderSchema.parse(req.body);

      await VariantService.reorderOptions(storeId, productId, ids);

      res.json({
        success: true,
        data: { message: 'Options reordered successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/:productId/options/:optionId - Update option
router.put(
  '/:storeId/products/:productId/options/:optionId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, optionId } = req.params;
      const data = updateOptionSchema.parse(req.body);

      const option = await VariantService.updateOption(storeId, productId, optionId, {
        name: data.name,
        nameAr: data.nameAr,
      });

      res.json({
        success: true,
        data: { option },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/products/:productId/options/:optionId - Delete option
router.delete(
  '/:storeId/products/:productId/options/:optionId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, optionId } = req.params;

      await VariantService.deleteOption(storeId, productId, optionId);

      res.json({
        success: true,
        data: { message: 'Option deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/:productId/options/:optionId/values - Add value to option
router.post(
  '/:storeId/products/:productId/options/:optionId/values',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, optionId } = req.params;
      const data = createOptionValueSchema.parse(req.body);

      const value = await VariantService.addOptionValue(storeId, productId, optionId, data);

      res.status(201).json({
        success: true,
        data: { value },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/:productId/option-values/:valueId - Update option value
router.put(
  '/:storeId/products/:productId/option-values/:valueId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, valueId } = req.params;
      const data = updateOptionValueSchema.parse(req.body);

      const value = await VariantService.updateOptionValue(storeId, productId, valueId, {
        value: data.value,
        valueAr: data.valueAr,
        swatchHex: data.swatchHex,
        swatchImageUrl: data.swatchImageUrl,
      });

      res.json({
        success: true,
        data: { value },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/products/:productId/option-values/:valueId - Delete option value
router.delete(
  '/:storeId/products/:productId/option-values/:valueId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, valueId } = req.params;

      await VariantService.deleteOptionValue(storeId, productId, valueId);

      res.json({
        success: true,
        data: { message: 'Option value deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/:productId/variants - Create variant
router.post(
  '/:storeId/products/:productId/variants',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const data = createVariantSchema.parse(req.body);

      const variant = await VariantService.createVariant(storeId, productId, data);

      res.status(201).json({
        success: true,
        data: { variant },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/:productId/variants/reorder - Reorder variants
// NOTE: Must be registered BEFORE /:variantId to avoid being shadowed
router.put(
  '/:storeId/products/:productId/variants/reorder',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { ids } = reorderSchema.parse(req.body);

      await VariantService.reorderVariants(storeId, productId, ids);

      res.json({
        success: true,
        data: { message: 'Variants reordered successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/products/:productId/variants/:variantId - Update variant
router.put(
  '/:storeId/products/:productId/variants/:variantId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, variantId } = req.params;
      const data = updateVariantSchema.parse(req.body);

      const variant = await VariantService.updateVariant(storeId, productId, variantId, data);

      res.json({
        success: true,
        data: { variant },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/products/:productId/variants/:variantId - Delete variant
router.delete(
  '/:storeId/products/:productId/variants/:variantId',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId, variantId } = req.params;

      await VariantService.deleteVariant(storeId, productId, variantId);

      res.json({
        success: true,
        data: { message: 'Variant deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/:productId/variants/generate - Generate all variant combinations
router.post(
  '/:storeId/products/:productId/variants/generate',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;

      const result = await VariantService.generateVariants(storeId, productId);

      res.json({
        success: true,
        data: { result },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/products/:productId/variants/bulk-inventory - Bulk update inventory
router.post(
  '/:storeId/products/:productId/variants/bulk-inventory',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { updates } = bulkInventorySchema.parse(req.body);

      const result = await VariantService.bulkUpdateInventory(storeId, productId, updates);

      res.json({
        success: true,
        data: { result },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
