import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb } from '../lib/repo-factory';
import { DEFAULT_LABEL_SETTINGS, labelSettingsSchema } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { tenantContext } from '../middleware/tenant-context';
import { AppError } from '../middleware/error-handler';
import { StoreService } from '../services/store.service';
import { generateMissingBarcodes } from '../services/barcode.service';

const router = Router();

// Mounted at the bare '/stores' prefix: bind the RLS tenant context once :storeId is resolved.
router.param('storeId', tenantContext);

const guard = [
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('inventory.barcode'),
];

export function readLabelSettings(raw: unknown) {
  const labels =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).labels : undefined;
  const parsed = labelSettingsSchema.safeParse(labels);
  return parsed.success ? parsed.data : DEFAULT_LABEL_SETTINGS;
}

// GET /stores/:storeId/barcodes/settings - label design + what the page needs to build store QR links
router.get(
  '/:storeId/barcodes/settings',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await (
        await storeDb(storeId)
      ).store.findFirst({
        where: { id: storeId },
        select: { slug: true, domain: true, domainStatus: true, settings: true },
      });
      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
      res.json({
        success: true,
        data: {
          settings: readLabelSettings(store.settings),
          slug: store.slug,
          domain: store.domainStatus === 'active' ? store.domain : null,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/barcodes/settings
router.put(
  '/:storeId/barcodes/settings',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = labelSettingsSchema.parse(req.body);
      await StoreService.updateLabelSettings(req.params.storeId, settings);
      res.json({ success: true, data: { settings } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/barcodes/generate - give every barcode-less product / variant a code (<= 500 per call)
router.post(
  '/:storeId/barcodes/generate',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await generateMissingBarcodes(req.params.storeId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

type PickerItem = {
  id: string;
  kind: 'product' | 'variant';
  productId: string;
  /** Storefront slug: the label QR links to /q/p/<slug>. */
  productSlug: string;
  name: string;
  nameAr: string | null;
  variantTitle: string | null;
  variantTitleAr: string | null;
  priceMinor: number;
  barcode: string | null;
};

const itemsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

// GET /stores/:storeId/barcodes/items - sellable items for the label picker (cursor-paged by product)
router.get(
  '/:storeId/barcodes/items',
  ...guard,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { search, cursor, limit } = itemsQuery.parse(req.query);
      const products = await (
        await storeDb(storeId)
      ).product.findMany({
        where: {
          storeId,
          deletedAt: null,
          ...(search
            ? {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { nameAr: { contains: search, mode: 'insensitive' } },
                  { sku: { contains: search, mode: 'insensitive' } },
                  { barcode: { contains: search } },
                  {
                    variants: {
                      some: {
                        OR: [
                          { barcode: { contains: search } },
                          { sku: { contains: search, mode: 'insensitive' } },
                        ],
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          slug: true,
          name: true,
          nameAr: true,
          price: true,
          barcode: true,
          variants: {
            where: { isActive: true },
            orderBy: { position: 'asc' },
            select: { id: true, title: true, titleAr: true, price: true, barcode: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const page = products.slice(0, limit);
      const items = page.flatMap<PickerItem>(p =>
        p.variants.length
          ? p.variants.map(v => ({
              id: v.id,
              kind: 'variant',
              productId: p.id,
              productSlug: p.slug,
              name: p.name,
              nameAr: p.nameAr,
              variantTitle: v.title,
              variantTitleAr: v.titleAr,
              priceMinor: v.price ?? p.price,
              barcode: v.barcode,
            }))
          : [
              {
                id: p.id,
                kind: 'product',
                productId: p.id,
                productSlug: p.slug,
                name: p.name,
                nameAr: p.nameAr,
                variantTitle: null,
                variantTitleAr: null,
                priceMinor: p.price,
                barcode: p.barcode,
              },
            ]
      );
      res.json({
        success: true,
        data: { items, nextCursor: products.length > limit ? page[page.length - 1].id : null },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
