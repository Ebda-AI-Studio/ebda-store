/**
 * Force Store AI assistant — translation, SEO meta, category suggestions.
 *
 * Mounted at `/stores/:storeId/ai/*`. Every endpoint requires
 * `store_admin` or `super_admin` scoped to the store, plus the
 * `writeLimiter` per-IP rate limiter on top of the AI service's own
 * per-store daily token budget.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { writeLimiter } from '../middleware/security';
import { AIService } from '../services/ai.service';
import { prisma } from '@force/database';

const router = Router({ mergeParams: true });

router.use(authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess);

const translateSchema = z.object({
  text: z.string().min(1).max(10_000),
  from: z.enum(['en', 'ar']),
  to: z.enum(['en', 'ar']),
  kind: z
    .enum([
      'product-name',
      'product-description',
      'category-name',
      'category-description',
      'meta-title',
      'meta-description',
      'store-name',
      'store-description',
      'free',
    ])
    .default('free'),
});

router.post('/translate', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const data = translateSchema.parse(req.body);
    const result = await AIService.translate({ storeId, ...data });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

const seoSchema = z.object({
  kind: z.enum(['store', 'category', 'product']),
  id: z.string().uuid().optional(),
});

router.post('/seo', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { kind, id } = seoSchema.parse(req.body);

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, nameAr: true, description: true, descriptionAr: true },
    });
    if (!store) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
      return;
    }

    let entityName = store.name;
    let entityNameAr: string | null | undefined = store.nameAr;
    let entityDescription: string | null | undefined = store.description;
    let entityDescriptionAr: string | null | undefined = store.descriptionAr;
    let categoryNames: string[] | undefined;

    if (kind === 'category') {
      if (!id) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DATA', message: 'id is required for category SEO' },
        });
        return;
      }
      const cat = await prisma.category.findFirst({
        where: { id, storeId },
        select: { name: true, nameAr: true, description: true, descriptionAr: true },
      });
      if (!cat) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Category not found' } });
        return;
      }
      entityName = cat.name;
      entityNameAr = cat.nameAr;
      entityDescription = cat.description;
      entityDescriptionAr = cat.descriptionAr;
    } else if (kind === 'product') {
      if (!id) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_DATA', message: 'id is required for product SEO' },
        });
        return;
      }
      const product = await prisma.product.findFirst({
        where: { id, storeId },
        select: {
          name: true,
          nameAr: true,
          description: true,
          descriptionAr: true,
          categories: { include: { category: { select: { name: true } } } },
        },
      });
      if (!product) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Product not found' } });
        return;
      }
      entityName = product.name;
      entityNameAr = product.nameAr;
      entityDescription = product.description;
      entityDescriptionAr = product.descriptionAr;
      categoryNames = product.categories.map(pc => pc.category.name);
    }

    const result = await AIService.suggestSeo({
      storeId,
      kind,
      storeName: store.name,
      storeNameAr: store.nameAr,
      entityName,
      entityNameAr,
      entityDescription,
      entityDescriptionAr,
      categoryNames,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

const categorizeSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
});

router.post(
  '/suggest-categories',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = categorizeSchema.parse(req.body);
      const cats = await prisma.category.findMany({
        where: { storeId, isActive: true },
        select: { id: true, name: true, nameAr: true },
      });
      const result = await AIService.suggestCategories({
        storeId,
        productName: data.name,
        productDescription: data.description,
        existingCategories: cats,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
