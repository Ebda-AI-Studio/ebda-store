/**
 * Ebda AI assistant — translation, SEO meta, category suggestions.
 *
 * Mounted at `/stores/:storeId/ai/*`. Every endpoint requires
 * `store_admin` or `super_admin` scoped to the store, plus the
 * `writeLimiter` per-IP rate limiter on top of the AI service's own
 * per-store daily token budget.
 */
import { aiUsageCost, aiUsageLast30Days } from '../services/usage-aggregates.service';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { isStoreAiEnabled, requireAiEnabled } from '../lib/store-ai-switch';
import { requireFeature } from '../middleware/feature-gate';
import { AIService } from '../services/ai.service';
import {
  applyStoreCategories,
  proposeStoreCategories,
} from '../services/store-category-suggest.service';
import { proposeBuilderPatch } from '../services/builder-ai-patch.service';
import { BUILDER_PAGE_KEYS } from '../services/page-builder.service';
import { AppError } from '../middleware/error-handler';
import { inngest } from '../lib/inngest/client';
import { generateProductFaqs } from '../lib/ai/product-faq-generator';
import { generateProductMetaAeo } from '../lib/ai/product-meta-aeo-generator';
import { currentStoreId, prisma } from '@ebda/database';
import { AI_AUTOFILL_FIELD_NAMES } from '@ebda/shared';
import {
  fillProductFields,
  balanceProductLanguages,
  revertProductBalance,
} from '../services/ai-autofill.service';
import { markJobFailedOnEnqueueError } from '../lib/jobs/enqueue-fail';
import { requestStoreReindex, touchesEmbedDoc } from '../lib/search/reindex';
import { storeUpdate } from '../lib/repo-factory';

const router = Router({ mergeParams: true });

router.use(authenticate, authorize('store_admin', 'super_admin'), requireStoreAccess);

/**
 * The merchant's AI switch (`stores.ai_features_enabled`). These two routes are the ONLY ones registered before
 * `requireAiEnabled`: a merchant must be able to read and flip the switch while it is off. Everything below it,
 * including cached answers, is refused with 403 AI_DISABLED_BY_MERCHANT when it is off
 * (`tests/unit/ai-entry-points-respect-switch.test.ts` pins the order).
 */
router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const enabled = await isStoreAiEnabled(req.params.storeId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: { enabled } });
  } catch (error) {
    next(error);
  }
});

router.put('/settings', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await storeUpdate(prisma, { where: { id: storeId }, data: { aiFeaturesEnabled: enabled } });
    await auditLog({
      action: enabled ? 'store.ai.enabled' : 'store.ai.disabled',
      userId: req.user!.userId,
      resourceType: 'store',
      resourceId: storeId,
      details: {},
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: { enabled } });
  } catch (error) {
    next(error);
  }
});

router.use(requireAiEnabled);

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

/**
 * POST /stores/:storeId/ai/section-content
 * Generate kicker + subtitle for a homepage section, bilingual EN+AR.
 * Used by the admin Layout page's "Generate with AI" button next to
 * the kicker/subtitle fields (Ahmad 2026-05-16).
 */
const sectionSchema = z.object({
  section: z.enum(['categories', 'newArrivals', 'bestSellers', 'featured', 'testimonials']),
  existingTitle: z.string().optional(),
  existingTitleAr: z.string().optional(),
});

router.post(
  '/section-content',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { section, existingTitle, existingTitleAr } = sectionSchema.parse(req.body);

      const store = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { name: true, nameAr: true, description: true, descriptionAr: true },
      });
      if (!store) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
        return;
      }

      // For categories section, pass sample category names so the AI
      // grounds copy in the merchant's actual catalog rather than
      // inventing generic "fashion / accessories / lifestyle" lines.
      let categoryNames: string[] | undefined;
      if (section === 'categories') {
        const cats = await (
          await storeDb(storeId)
        ).category.findMany({
          where: { storeId },
          select: { name: true },
          take: 8,
          orderBy: { position: 'asc' },
        });
        categoryNames = cats.map(c => c.name).filter(Boolean);
      }

      const result = await AIService.suggestSectionContent({
        storeId,
        section,
        storeName: store.name,
        storeNameAr: store.nameAr,
        storeDescription: store.description,
        storeDescriptionAr: store.descriptionAr,
        categoryNames,
        existingTitle,
        existingTitleAr,
      });

      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/ai/suggest-store-categories
 * A store with NO categories gets a proposal grouped from its products (the model sees product text only).
 * Nothing is written: the merchant accepts or edits it, then calls apply-store-categories.
 */
router.post(
  '/suggest-store-categories',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const r = await proposeStoreCategories(req.params.storeId);
      if (!r.ok) {
        res.status(r.status).json({
          success: false,
          error: { code: r.code, message: r.message },
        });
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ success: true, data: r.value });
    } catch (error) {
      next(error);
    }
  }
);

/** POST /stores/:storeId/ai/apply-store-categories — creates what the merchant approved (their edits included). */
router.post(
  '/apply-store-categories',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await applyStoreCategories({
        storeId: req.params.storeId,
        userId: req.user!.userId,
        categories: (req.body as { categories?: unknown } | undefined)?.categories,
      });
      if (!r.ok) {
        res.status(r.status).json({
          success: false,
          error: { code: r.code, message: r.message },
        });
        return;
      }
      res.status(201).json({ success: true, data: r.value });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /stores/:storeId/ai/builder-patch
 * The visual builder's "ask AI" box: a plain Arabic/English request becomes a STRUCTURED patch
 * proposal against the saved page document (never code). Nothing is saved here; the merchant
 * reviews the diff and applies it as a normal draft edit (one undo step) in the editor.
 */
const builderPatchSchema = z
  .object({
    pageKey: z.string().refine(k => BUILDER_PAGE_KEYS.has(k), 'Unknown page'),
    instruction: z.string().trim().min(2).max(500),
  })
  .strict();

router.post(
  '/builder-patch',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const body = builderPatchSchema.parse(req.body);
      const r = await proposeBuilderPatch({ storeId, ...body });
      if (!r.ok) {
        res.status(r.status).json({
          success: false,
          error: {
            code: r.code,
            message: r.message,
            details: r.errors ? { errors: r.errors } : {},
          },
        });
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ success: true, data: r.value });
    } catch (error) {
      next(error);
    }
  }
);

router.post('/seo', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const { kind, id } = seoSchema.parse(req.body);

    const store = await (
      await storeDb(storeId)
    ).store.findUnique({
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
      const cat = await (
        await storeDb(storeId)
      ).category.findFirst({
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
      const product = await (
        await storeDb(storeId)
      ).product.findFirst({
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

// =====================================================================
// Per-product AEO meta description — bilingual conversational
// "What is X?" style meta description for a single product, drafted
// inline (no Inngest job). Twin of the catalogue-wide bulk-ai-meta-aeo
// sweep (Inngest) — both share `generateProductMetaAeo` (lib/ai/
// product-meta-aeo-generator.ts) so per-product and bulk output never
// diverge. Powers the product edit page's "Generate with AI" button
// alongside /seo and /product-faqs/draft.
// =====================================================================

const productMetaAeoSchema = z.object({
  productId: z.string().min(1),
});

router.post(
  '/product-meta-aeo',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productId } = productMetaAeoSchema.parse(req.body);

      const product = await (
        await storeDb(storeId)
      ).product.findFirst({
        where: { id: productId, storeId },
        select: { id: true, name: true, description: true },
      });
      if (!product) {
        throw new AppError(404, 'NOT_FOUND', 'Product not found');
      }

      const store = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { name: true },
      });

      // Accept GEMINI_API_KEY as a fallback so a prod deploy that set the shorter
      // var name still works without a reconfig (same trap as /product-faqs/draft).
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI service is not configured');
      }

      let aeo;
      try {
        aeo = await generateProductMetaAeo(
          {
            storeId,
            storeName: store?.name ?? storeId,
            product: { name: product.name, description: product.description },
          },
          apiKey,
          process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest'
        );
      } catch (err) {
        // generateProductMetaAeo already converts Gemini/SDK errors into a
        // well-classified AppError with a merchant-safe message — let those
        // through unchanged. Only a genuine JSON-parse/shape failure (thrown
        // as a plain Error) becomes AI_PARSE_ERROR.
        if (err instanceof AppError) throw err;
        throw new AppError(502, 'AI_PARSE_ERROR', 'AI returned unexpected format');
      }

      // AI usage is recorded inside generateProductMetaAeo() itself (feature
      // 'aeo', the same bucket the bulk sweep uses) — recording it again here
      // would double-count this single request against the quota cap.

      res.json({ success: true, data: { aeo } });
    } catch (error) {
      next(error);
    }
  }
);

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
      const cats = await (
        await storeDb(storeId)
      ).category.findMany({
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

// =====================================================================
// Smart Palette v3 — Layer C: Gemini Vision logo-to-palette extraction.
// POST /stores/:storeId/ai/palette-from-logo
// =====================================================================

router.post(
  '/palette-from-logo',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const store = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { logo: true },
      });

      if (!store?.logo) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_LOGO', message: 'Upload a store logo first.' },
        });
        return;
      }

      const palette = await AIService.extractPaletteFromLogo(store.logo, storeId);
      res.json({ success: true, data: palette });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Bulk sweeps — translate or SEO across the entire catalogue.
// Returns 202 + jobId; admin polls /bulk/:jobId for progress.
// =====================================================================

const bulkTranslateSchema = z.object({
  direction: z.enum(['to_ar', 'to_en']),
});

// Helper: when the job start fails (Cloudflare Workflows/Queues unreachable or unbound), the job
// row was created but no one will ever process it. Mark it failed so the merchant sees an
// actionable error instead of a stuck "queued" row that lingers forever (lib/jobs/enqueue-fail.ts).
function markJobFailedIfEnqueueFailed(jobId: string, err: unknown): Promise<void> {
  return markJobFailedOnEnqueueError(currentStoreId(), jobId, err);
}

router.post(
  '/bulk/translate',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { direction } = bulkTranslateSchema.parse(req.body);

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: { storeId, userId: req.user!.userId, kind: 'translate', direction },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/translate-requested',
          data: { jobId: job.id, storeId, direction },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/seo',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'seo',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/seo-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const jobs = await (
      await storeDb(currentStoreId())
    ).bulkAiJob.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        kind: true,
        status: true,
        direction: true,
        total: true,
        processed: true,
        filled: true,
        skipped: true,
        failed: true,
        errorMessage: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    res.json({ success: true, data: { jobs } });
  } catch (error) {
    next(error);
  }
});

router.get('/bulk/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, jobId } = req.params;
    const job = await (
      await storeDb(currentStoreId())
    ).bulkAiJob.findFirst({
      where: { id: jobId, storeId },
      select: {
        id: true,
        kind: true,
        status: true,
        direction: true,
        total: true,
        processed: true,
        filled: true,
        skipped: true,
        failed: true,
        errors: true,
        filledProducts: true,
        errorMessage: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
    if (!job) {
      res
        .status(404)
        .json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
      return;
    }
    res.json({ success: true, data: { job } });
  } catch (error) {
    next(error);
  }
});

// =====================================================================
// Per-product FAQ draft — generates up to 5 FAQ pairs for a single
// product via Gemini, returned inline (no Inngest job). Merchant
// reviews and accepts before FAQs are persisted.
// =====================================================================

const draftProductFaqsSchema = z.object({
  productId: z.string().min(1),
  count: z.number().int().min(1).max(10).default(3),
});

router.post(
  '/product-faqs/draft',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productId, count } = draftProductFaqsSchema.parse(req.body);

      // Verify the product belongs to this store.
      const product = await (
        await storeDb(storeId)
      ).product.findFirst({
        where: { id: productId, storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          description: true,
          descriptionAr: true,
          options: {
            select: {
              name: true,
              nameAr: true,
              values: { select: { value: true, valueAr: true } },
            },
          },
        },
      });
      if (!product) {
        throw new AppError(404, 'NOT_FOUND', 'Product not found');
      }

      const store = await (
        await storeDb(storeId)
      ).store.findUnique({
        where: { id: storeId },
        select: { name: true, nameAr: true },
      });

      // Accept GEMINI_API_KEY as a fallback so a prod deploy that set the shorter
      // var name still works without a reconfig (trap: silent 503 if neither is set).
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI service is not configured');
      }

      // Shared FAQ core — identical prompt + parse path as the bulk
      // product-FAQ sweep (Inngest bulk-ai-product-faqs). DRY: both call
      // generateProductFaqs so per-product and bulk output never diverge.
      let faqs;
      try {
        faqs = await generateProductFaqs(
          {
            storeId,
            storeName: store?.name ?? storeId,
            product: {
              name: product.name,
              nameAr: product.nameAr,
              description: product.description,
              options: product.options,
            },
            count,
          },
          apiKey,
          process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest'
        );
      } catch (err) {
        // generateProductFaqs already converts Gemini/SDK errors (e.g. a 429
        // quota) into a well-classified AppError with a merchant-safe message
        // — let those through unchanged. Only a genuine JSON-parse failure
        // (thrown as a plain Error) becomes AI_PARSE_ERROR.
        if (err instanceof AppError) throw err;
        throw new AppError(502, 'AI_PARSE_ERROR', 'AI returned unexpected format');
      }

      // AI usage is now recorded inside generateProductFaqs() itself (feature
      // 'product-faqs') — recording it again here would double-count this
      // single request against the daily/monthly quota cap.

      res.json({ success: true, data: { faqs } });
    } catch (error) {
      next(error);
    }
  }
);

// Catalogue-wide product-FAQ sweep — the bulk twin of /product-faqs/draft.
// Creates a BulkAiJob and hands off to the `bulk-ai-product-faqs` Inngest
// function (which reuses generateProductFaqs, so bulk and per-product never
// diverge). Default smart-skips products that already have FAQs; `force`
// re-drafts AI-owned rows only (manual edits preserved).
router.post(
  '/bulk/product-faqs',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'product_faqs',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/product-faqs-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the product-FAQ draft right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Catalogue field sweeps (2026-07-03) — category assignment, image
// alt-text, product excerpts, product tags. Each mirrors the bulk-ai
// pattern above: creates a BulkAiJob + hands off to an Inngest function.
// See docs/plans/2026-07-03-ai-bulk-sweeps.md.
// =====================================================================

// Uncategorized-products-only category assignment. `force` is accepted for
// wiring consistency but is a no-op in the Inngest function (never
// re-categorizes a product that already has one — see bulk-ai-categorize.ts).
router.post(
  '/bulk/categorize',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: { storeId, userId: req.user!.userId, kind: 'category_assign' },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/categorize-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the category sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// Gemini-Vision image alt-text sweep. `force` is accepted for wiring
// consistency but is a no-op — an image that already has `alt` is never
// overwritten (see bulk-ai-image-alt.ts).
router.post(
  '/bulk/image-alt',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: { storeId, userId: req.user!.userId, kind: 'image_alt' },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/image-alt-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the image alt-text sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// Product-excerpt sweep. `force` re-generates ai-owned excerpts only —
// never overwrites a human-written one (see bulk-ai-excerpt.ts).
router.post(
  '/bulk/excerpt',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'excerpt',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/excerpt-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the excerpt sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// Product-tag sweep. `force` tops up already-tagged products with newly
// suggested tags (never deletes an existing tag — see bulk-ai-tags.ts).
router.post(
  '/bulk/tags',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'product_tags',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/tags-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the tag sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// AI Usage — summary + paginated log for merchant quota visibility.
// =====================================================================

router.get('/usage/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const now = new Date();

    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const startOfMonth = new Date(now);
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const dailyCap = parseInt(process.env.AI_DAILY_REQUEST_CAP ?? '450', 10);
    const monthlyCap = parseInt(process.env.AI_MONTHLY_REQUEST_CAP ?? '20000', 10);

    const [todayCount, monthCount, todayCost, monthCost, last30] = await Promise.all([
      prisma.aiUsage.count({
        where: { storeId, createdAt: { gte: startOfDay }, cachedHit: false },
      }),
      prisma.aiUsage.count({
        where: { storeId, createdAt: { gte: startOfMonth }, cachedHit: false },
      }),
      // costMicros is NULL for a model with no configured rate, which SUM
      // and COUNT(cost_micros) both correctly ignore — null (unpriced) must
      // never be folded into 0 (genuinely free) when reporting spend. See
      // lib/ai-pricing.ts's doc comment. (Ruling NZ-AN-1: no raw SQL; the router serves D1 or Postgres.)
      aiUsageCost(storeId, startOfDay),
      aiUsageCost(storeId, startOfMonth),
      aiUsageLast30Days(storeId, now),
    ]);

    res.json({
      success: true,
      data: {
        today: todayCount,
        thisMonth: monthCount,
        dailyCap,
        monthlyCap,
        // Micros of the store's billing currency; null when nothing in the
        // window has a configured rate. unpriced*Count is how many rows
        // that total excludes, so the admin surface can label it a partial
        // figure rather than implying it covers every call.
        todayCostMicros: todayCost.total,
        todayUnpricedCount: todayCost.unpriced,
        monthCostMicros: monthCost.total,
        monthUnpricedCount: monthCost.unpriced,
        // Convert bigint → number so JSON.stringify works.
        last30Days: last30,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/usage/log', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10)));
    const skip = (page - 1) * pageSize;

    const [rows, total] = await Promise.all([
      prisma.aiUsage.findMany({
        where: { storeId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          feature: true,
          inputTokens: true,
          outputTokens: true,
          cachedHit: true,
          createdAt: true,
          model: true,
          costMicros: true,
          subjectType: true,
          subjectId: true,
        },
      }),
      prisma.aiUsage.count({ where: { storeId } }),
    ]);

    res.json({
      success: true,
      data: {
        rows,
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    next(error);
  }
});

// =====================================================================
// AEO bulk sweeps — FAQ items, HowTo guides, conversational meta.
// Each returns 202 + jobId; poll /bulk/:jobId for progress.
// =====================================================================

router.post(
  '/bulk/faq-aeo',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const count = Math.min(parseInt(String(req.body?.count ?? '8'), 10) || 8, 20);
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'faq_aeo',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/faq-aeo-requested',
          data: { jobId: job.id, storeId, count, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the FAQ draft right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/howto-aeo',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const count = Math.min(parseInt(String(req.body?.count ?? '3'), 10) || 3, 10);
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'howto_aeo',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/howto-aeo-requested',
          data: { jobId: job.id, storeId, count, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the HowTo draft right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/meta-aeo',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'meta_aeo',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/meta-aeo-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the meta rewrite right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Bulk AI recommendations sweep.
// Generates cross-sell suggestions for every active product using
// Gemini. Results are stored in ai_recommendation and queried by
// recommendation.service.ts as the second priority (after manual
// cross-sells, before FBT).
// =====================================================================

router.post(
  '/bulk/recommendations',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'recommendations',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/recommendations-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message:
              'Could not enqueue the recommendations sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// AEO master sweep — fires faq_aeo + howto_aeo + meta_aeo in parallel.
// All three jobs share a master_run_id tag in their summary field so
// the admin UI can poll + aggregate them as a single combined card.
// =====================================================================

router.post(
  '/bulk/aeo-sweep-all',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const masterRunId = crypto.randomUUID();

      const aeoForce = req.body?.force === true;

      // Create all three jobs in parallel
      const [faqJob, howtoJob, metaJob] = await Promise.all([
        (await storeWriter(currentStoreId())).bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'faq_aeo',
            errors: { master_run_id: masterRunId, ...(aeoForce ? { force: true } : {}) } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
        (await storeWriter(currentStoreId())).bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'howto_aeo',
            errors: { master_run_id: masterRunId, ...(aeoForce ? { force: true } : {}) } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
        (await storeWriter(currentStoreId())).bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'meta_aeo',
            errors: { master_run_id: masterRunId, ...(aeoForce ? { force: true } : {}) } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
      ]);

      // Fire all three Inngest events, handling failures per-job
      const count = Math.min(parseInt(String(req.body?.count ?? '8'), 10) || 8, 20);
      const force = aeoForce;
      const enqueueResults = await Promise.allSettled([
        inngest
          .send({
            name: 'bulk-ai/faq-aeo-requested',
            data: { jobId: faqJob.id, storeId, count, force },
          })
          .catch((err: unknown) => markJobFailedIfEnqueueFailed(faqJob.id, err)),
        inngest
          .send({
            name: 'bulk-ai/howto-aeo-requested',
            data: { jobId: howtoJob.id, storeId, count: 3, force },
          })
          .catch((err: unknown) => markJobFailedIfEnqueueFailed(howtoJob.id, err)),
        inngest
          .send({
            name: 'bulk-ai/meta-aeo-requested',
            data: { jobId: metaJob.id, storeId, force },
          })
          .catch((err: unknown) => markJobFailedIfEnqueueFailed(metaJob.id, err)),
      ]);

      const anyFailed = enqueueResults.some(r => r.status === 'rejected');
      if (anyFailed) {
        // At least one enqueue failed — return 503 so the UI can retry.
        // The per-job markJobFailedIfEnqueueFailed calls above already
        // persisted the failure on those individual jobs.
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'One or more AEO sweeps could not be enqueued. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({
        success: true,
        data: {
          masterRunId,
          jobs: [faqJob, howtoJob, metaJob],
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// GEO bulk sweeps — LLMs.txt generation, product citation copy,
// and brand facts JSON.  Mirrors the AEO pattern exactly.
// =====================================================================

router.post(
  '/bulk/llms-txt',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'llms_txt',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/llms-txt-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the LLMs.txt generation right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/citation-copy',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'citation_copy',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/citation-copy-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the citation copy sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/brand-facts',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: {
          storeId,
          userId: req.user!.userId,
          kind: 'brand_facts',
          ...(force ? { errors: { force: true } as object } : {}),
        },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/brand-facts-requested',
          data: { jobId: job.id, storeId, force },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the brand facts sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/geo-sweep-all',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const masterRunId = crypto.randomUUID();

      const geoSweepForce = req.body?.force === true;

      const [llmsJob, citationJob, factsJob] = await Promise.all([
        (await storeWriter(currentStoreId())).bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'llms_txt',
            errors: {
              master_run_id: masterRunId,
              ...(geoSweepForce ? { force: true } : {}),
            } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
        (await storeWriter(currentStoreId())).bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'citation_copy',
            errors: {
              master_run_id: masterRunId,
              ...(geoSweepForce ? { force: true } : {}),
            } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
        (await storeWriter(currentStoreId())).bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'brand_facts',
            errors: {
              master_run_id: masterRunId,
              ...(geoSweepForce ? { force: true } : {}),
            } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
      ]);

      const geoForce = geoSweepForce; // alias used in enqueue data below
      const enqueueResults = await Promise.allSettled([
        inngest
          .send({
            name: 'bulk-ai/llms-txt-requested',
            data: { jobId: llmsJob.id, storeId, force: geoForce },
          })
          .catch((err: unknown) => markJobFailedIfEnqueueFailed(llmsJob.id, err)),
        inngest
          .send({
            name: 'bulk-ai/citation-copy-requested',
            data: { jobId: citationJob.id, storeId, force: geoForce },
          })
          .catch((err: unknown) => markJobFailedIfEnqueueFailed(citationJob.id, err)),
        inngest
          .send({
            name: 'bulk-ai/brand-facts-requested',
            data: { jobId: factsJob.id, storeId, force: geoForce },
          })
          .catch((err: unknown) => markJobFailedIfEnqueueFailed(factsJob.id, err)),
      ]);

      const anyFailed = enqueueResults.some(r => r.status === 'rejected');
      if (anyFailed) {
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'One or more GEO sweeps could not be enqueued. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({
        success: true,
        data: {
          masterRunId,
          jobs: [llmsJob, citationJob, factsJob],
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// =====================================================================
// Cancel a running or queued bulk AI job.
// POST /stores/:storeId/ai/jobs/:jobId/cancel
// Cooperative cancellation: sets status=cancelled in DB; the Inngest
// function checks this flag every 5 iterations and breaks out cleanly.
// =====================================================================

router.post(
  '/jobs/:jobId/cancel',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, jobId } = req.params;
      const updated = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.updateMany({
        where: { id: jobId, storeId, status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new AppError(404, 'JOB_NOT_CANCELLABLE', 'Job not found or already finished');
      }
      res.json({ success: true, data: { cancelled: true } });
    } catch (e) {
      next(e);
    }
  }
);

// ==========================================
// AI Sweep Result Viewers
// ==========================================
// Closes the "every data has a UI" gap for the GEO sweeps. The bulk-ai
// jobs write to `stores.llmsTxt` + `stores.aboutJson` + `ai_recommendation`,
// then disappear from the admin's view. These endpoints expose the
// CURRENT VALUES so the merchant can see what the sweep actually filled.

/**
 * GET /stores/:storeId/ai/results/geo
 * Returns the current populated GEO outputs: llmsTxt content + brand
 * facts JSON + a citation-copy fill-rate summary across products.
 */
router.get('/results/geo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [store, totalProducts, productsWithCitation] = await Promise.all([
      (await storeDb(storeId)).store.findUnique({
        where: { id: storeId },
        select: { llmsTxt: true, aboutJson: true },
      }),
      (await storeDb(storeId)).product.count({ where: { storeId, deletedAt: null } }),
      (await storeDb(storeId)).product.count({
        where: { storeId, deletedAt: null, citationCopy: { not: null } },
      }),
    ]);

    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    }

    res.json({
      success: true,
      data: {
        llmsTxt: store.llmsTxt ?? null,
        brandFacts: store.aboutJson ?? null,
        citationCopy: {
          totalProducts,
          filledProducts: productsWithCitation,
          // Surface 0 instead of NaN when the store has no products yet.
          fillRate: totalProducts === 0 ? 0 : productsWithCitation / totalProducts,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/recommendations?productId=...
 * Returns the AI recommendations populated by the bulk-ai-recommendations
 * sweep, scoped to ONE source product. Up to 25 target products with
 * score + reason + name + slug + first image.
 *
 * Closes the gap where the admin product recommendations page only
 * read `product_relations` (manual cross-sells) and ignored the
 * `ai_recommendation` table that the sweep populates.
 */
router.get('/results/recommendations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;
    const productId = (req.query.productId as string | undefined)?.trim();
    if (!productId) {
      throw new AppError(400, 'PRODUCT_ID_REQUIRED', 'productId query param is required');
    }

    const rows = await (
      await storeDb(currentStoreId())
    ).aiRecommendation.findMany({
      where: { storeId, sourceProductId: productId },
      orderBy: { score: 'desc' },
      take: 25,
      select: {
        id: true,
        targetProductId: true,
        score: true,
        reason: true,
        // AiRecommendation model uses `generatedAt` (NOT createdAt).
        // PR #16 merged this with `createdAt` which fails tsc on Railway
        // (Prisma client typed select doesn't expose that field). Hotfix
        // restores the build. The response shape stays `createdAt` for
        // backward compat with the AiSuggestionsPanel frontend.
        generatedAt: true,
        targetProduct: {
          select: {
            id: true,
            name: true,
            nameAr: true,
            slug: true,
            price: true,
            images: {
              take: 1,
              orderBy: { position: 'asc' },
              select: { url: true, alt: true },
            },
          },
        },
      },
    });

    res.json({
      success: true,
      data: {
        recommendations: rows.map(r => ({
          id: r.id,
          targetProductId: r.targetProductId,
          score: r.score,
          reason: r.reason,
          createdAt: r.generatedAt,
          targetProduct: r.targetProduct,
        })),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/recommendations/overview
 * Store-wide rollup: which products HAVE AI recs vs which don't.
 */
router.get(
  '/results/recommendations/overview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = (req.params as { storeId: string }).storeId;

      const db = await storeDb(storeId);
      const [totalProducts, recSources] = await Promise.all([
        db.product.count({ where: { storeId, deletedAt: null } }),
        // no `distinct` (not served by the DO client): the distinct sources are counted in memory
        db.aiRecommendation.findMany({ where: { storeId }, select: { sourceProductId: true } }),
      ]);
      const totalRecs = recSources.length;
      const distinctSourcesWithRecs = new Set(recSources.map(r => r.sourceProductId)).size;

      res.json({
        success: true,
        data: {
          totalProducts,
          productsWithAiRecs: distinctSourcesWithRecs,
          productsWithoutAiRecs: Math.max(0, totalProducts - distinctSourcesWithRecs),
          totalRecommendations: totalRecs,
          averageRecsPerProduct:
            distinctSourcesWithRecs === 0 ? 0 : totalRecs / distinctSourcesWithRecs,
        },
      });
    } catch (e) {
      next(e);
    }
  }
);

// =====================================================================
// Sweep Result Viewers (read-only) — translate, seo, faqs, howtos,
// meta-aeo.  All follow the same auth chain as the rest of the file.
// =====================================================================

/**
 * GET /stores/:storeId/ai/results/translate
 * AR fill-rate for products and categories + 5 recently-translated
 * products (nameAr filled in the last 30 days).
 */
router.get('/results/translate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totalProducts, productsWithAr, totalCategories, categoriesWithAr, recentlyTranslated] =
      await Promise.all([
        (await storeDb(storeId)).product.count({ where: { storeId, deletedAt: null } }),
        (await storeDb(storeId)).product.count({
          where: { storeId, deletedAt: null, nameAr: { not: null } },
        }),
        (await storeDb(storeId)).category.count({ where: { storeId } }),
        (await storeDb(storeId)).category.count({
          where: { storeId, nameAr: { not: null } },
        }),
        // Products that got an Arabic name in the last 30 days
        (await storeDb(storeId)).product.findMany({
          where: {
            storeId,
            deletedAt: null,
            nameAr: { not: null },
            updatedAt: { gte: since30d },
          },
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            name: true,
            nameAr: true,
            updatedAt: true,
          },
        }),
      ]);

    if (!totalProducts && !totalCategories) {
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    }

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          filled: productsWithAr,
          fillRate: totalProducts === 0 ? 0 : productsWithAr / totalProducts,
        },
        categories: {
          total: totalCategories,
          filled: categoriesWithAr,
          fillRate: totalCategories === 0 ? 0 : categoriesWithAr / totalCategories,
        },
        recentlyTranslated,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/seo
 * SEO meta fill-rate for products, categories, and the store row.
 * Returns sample of 5 most-recently-updated products with their meta.
 */
router.get('/results/seo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [
      store,
      totalProducts,
      productsWithMeta,
      totalCategories,
      categoriesWithMeta,
      recentProducts,
    ] = await Promise.all([
      (await storeDb(storeId)).store.findUnique({
        where: { id: storeId },
        select: { metaTitle: true, metaDescription: true },
      }),
      (await storeDb(storeId)).product.count({ where: { storeId, deletedAt: null } }),
      (await storeDb(storeId)).product.count({
        where: {
          storeId,
          deletedAt: null,
          metaTitle: { not: null },
          metaDescription: { not: null },
        },
      }),
      (await storeDb(storeId)).category.count({ where: { storeId } }),
      (await storeDb(storeId)).category.count({
        where: {
          storeId,
          metaTitle: { not: null },
          metaDescription: { not: null },
        },
      }),
      (await storeDb(storeId)).product.findMany({
        where: {
          storeId,
          deletedAt: null,
          metaTitle: { not: null },
        },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          metaTitle: true,
          metaDescription: true,
          updatedAt: true,
        },
      }),
    ]);

    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    }

    res.json({
      success: true,
      data: {
        storeMetaFilled: !!(store.metaTitle?.trim() && store.metaDescription?.trim()),
        products: {
          total: totalProducts,
          filled: productsWithMeta,
          fillRate: totalProducts === 0 ? 0 : productsWithMeta / totalProducts,
        },
        categories: {
          total: totalCategories,
          filled: categoriesWithMeta,
          fillRate: totalCategories === 0 ? 0 : categoriesWithMeta / totalCategories,
        },
        // Truncated to 80 chars each for display
        recentProducts: recentProducts.map(p => ({
          id: p.id,
          name: p.name,
          metaTitle: p.metaTitle ? p.metaTitle.slice(0, 80) : null,
          metaDescription: p.metaDescription ? p.metaDescription.slice(0, 80) : null,
          updatedAt: p.updatedAt,
        })),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/faqs
 * Full list of store-level FAQ rows + count + last-updated timestamp.
 */
router.get('/results/faqs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const faqs = await (
      await storeDb(currentStoreId())
    ).storeFaq.findMany({
      where: { storeId, isActive: true },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        question: true,
        questionAr: true,
        answer: true,
        answerAr: true,
        aiDrafted: true,
        manuallyEdited: true,
        updatedAt: true,
      },
    });

    const lastUpdated =
      faqs.length > 0
        ? faqs.reduce((latest, f) => (f.updatedAt > latest.updatedAt ? f : latest)).updatedAt
        : null;

    res.json({
      success: true,
      data: {
        count: faqs.length,
        lastUpdated,
        faqs: faqs.map(f => ({
          ...f,
          // Truncate answer to 150 chars for the panel preview
          answerPreview: f.answer.slice(0, 150),
          answerArPreview: f.answerAr ? f.answerAr.slice(0, 150) : null,
        })),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/howtos
 * Full list of store-level HowTo guides + step count per guide.
 */
router.get('/results/howtos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const howtos = await (
      await storeDb(currentStoreId())
    ).storeHowto.findMany({
      where: { storeId, isActive: true },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        title: true,
        titleAr: true,
        description: true,
        steps: true,
        stepsAr: true,
        aiDrafted: true,
        manuallyEdited: true,
        updatedAt: true,
      },
    });

    const lastUpdated =
      howtos.length > 0
        ? howtos.reduce((latest, h) => (h.updatedAt > latest.updatedAt ? h : latest)).updatedAt
        : null;

    res.json({
      success: true,
      data: {
        count: howtos.length,
        lastUpdated,
        howtos: howtos.map(h => {
          // steps is stored as JSON array; derive step count safely
          const stepCount = Array.isArray(h.steps) ? (h.steps as unknown[]).length : 0;
          return {
            id: h.id,
            title: h.title,
            titleAr: h.titleAr,
            descriptionPreview: h.description.slice(0, 150),
            stepCount,
            aiDrafted: h.aiDrafted,
            manuallyEdited: h.manuallyEdited,
            updatedAt: h.updatedAt,
          };
        }),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/meta-aeo
 * Fill-rate for the metaDescriptionAeo column (written by bulk-ai-meta-aeo)
 * across store, products, and categories, plus 5 most-recently-rewritten
 * products with the conversational description shown.
 */
router.get('/results/meta-aeo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [
      store,
      totalProducts,
      productsWithAeo,
      totalCategories,
      categoriesWithAeo,
      recentProducts,
    ] = await Promise.all([
      (await storeDb(storeId)).store.findUnique({
        where: { id: storeId },
        select: { metaDescriptionAeo: true },
      }),
      (await storeDb(storeId)).product.count({ where: { storeId, deletedAt: null } }),
      (await storeDb(storeId)).product.count({
        where: { storeId, deletedAt: null, metaDescriptionAeo: { not: null } },
      }),
      (await storeDb(storeId)).category.count({ where: { storeId } }),
      (await storeDb(storeId)).category.count({
        where: { storeId, metaDescriptionAeo: { not: null } },
      }),
      (await storeDb(storeId)).product.findMany({
        where: { storeId, deletedAt: null, metaDescriptionAeo: { not: null } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          metaDescriptionAeo: true,
          updatedAt: true,
        },
      }),
    ]);

    if (!store) {
      throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
    }

    res.json({
      success: true,
      data: {
        storeAeoFilled: !!store.metaDescriptionAeo?.trim(),
        storeMetaDescriptionAeo: store.metaDescriptionAeo ?? null,
        products: {
          total: totalProducts,
          filled: productsWithAeo,
          fillRate: totalProducts === 0 ? 0 : productsWithAeo / totalProducts,
        },
        categories: {
          total: totalCategories,
          filled: categoriesWithAeo,
          fillRate: totalCategories === 0 ? 0 : categoriesWithAeo / totalCategories,
        },
        recentProducts: recentProducts.map(p => ({
          id: p.id,
          name: p.name,
          metaDescriptionAeo: p.metaDescriptionAeo,
          updatedAt: p.updatedAt,
        })),
      },
    });
  } catch (e) {
    next(e);
  }
});

// =====================================================================
// AI-first autofill — hand a single field BACK to the AI.
// POST /stores/:storeId/ai/products/:productId/ai/reset-field
// Clears the field + its provenance lock, then regenerates ONLY that
// field via the autofill core. Used by the admin product editor's
// "✨ Switch to AI" button next to each human-owned AI-writable field.
// =====================================================================

router.post(
  '/products/:productId/ai/reset-field',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const { field } = req.body as { field?: string };
      if (!field || !AI_AUTOFILL_FIELD_NAMES.includes(field)) {
        res.status(400).json({ success: false, error: { code: 'BAD_FIELD' } });
        return;
      }

      const product = await (
        await storeDb(storeId)
      ).product.findFirst({ where: { id: productId, storeId } });
      if (!product) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
        return;
      }

      // Drop the provenance lock for this field + clear the value, so the
      // autofill core treats it as an empty gap and regenerates it.
      const sources = { ...((product.aiFieldSources as Record<string, string>) ?? {}) };
      delete sources[field];
      await (
        await storeWriter(storeId)
      ).product.update({
        where: { id: productId, storeId },
        data: { [field]: null, aiFieldSources: sources },
      });
      // The cleared text changes the search embedding even if the regeneration below fails.
      if (touchesEmbedDoc([field])) await requestStoreReindex(storeId, 'ai-handback');

      await fillProductFields(storeId, productId, { op: 'create', onlyFields: [field] });

      const updated = await (
        await storeDb(storeId)
      ).product.findFirst({ where: { id: productId, storeId } });
      res.json({
        success: true,
        data: {
          field,
          value: (updated as Record<string, unknown> | null)?.[field] ?? null,
          source: 'ai',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// =====================================================================
// Description-language balancer — bulk + per-product routes.
//
// Bulk: POST /bulk/balance-descriptions  → creates BulkAiJob + enqueues
// Bulk: POST /bulk/revert-balance        → creates BulkAiJob + enqueues revert
// Per-product: POST /products/:productId/ai/balance-description
// Per-product: POST /products/:productId/ai/revert-balance
// =====================================================================

router.post(
  '/bulk/balance-descriptions',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: { storeId, userId: req.user!.userId, kind: 'description_balance' },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/balance-descriptions.requested',
          data: { jobId: job.id, storeId },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the sweep right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/bulk/revert-balance',
  requireFeature('bulk_operations'),
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const job = await (
        await storeWriter(currentStoreId())
      ).bulkAiJob.create({
        data: { storeId, userId: req.user!.userId, kind: 'description_revert' },
        select: { id: true, status: true, kind: true, createdAt: true },
      });

      try {
        await inngest.send({
          name: 'bulk-ai/revert-balance.requested',
          data: { jobId: job.id, storeId },
        });
      } catch (err) {
        await markJobFailedIfEnqueueFailed(job.id, err);
        res.status(503).json({
          success: false,
          error: {
            code: 'AI_QUEUE_UNREACHABLE',
            message: 'Could not enqueue the revert right now. Try again in a minute.',
          },
        });
        return;
      }

      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      next(error);
    }
  }
);

// Per-product balance
router.post(
  '/products/:productId/ai/balance-description',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;
      const force = req.body?.force === true;

      const result = await balanceProductLanguages(storeId, productId, { force });

      const updated = await (
        await storeDb(storeId)
      ).product.findFirst({
        where: { id: productId, storeId },
        select: { name: true, nameAr: true, description: true, descriptionAr: true },
      });

      res.json({
        success: true,
        data: {
          balanced: result.balanced,
          sides: result.sides,
          // Legacy compat: expose the description side directly
          side: result.sides.description ?? null,
          name: updated?.name ?? null,
          nameAr: updated?.nameAr ?? null,
          description: updated?.description ?? null,
          descriptionAr: updated?.descriptionAr ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Per-product revert
router.post(
  '/products/:productId/ai/revert-balance',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, productId } = req.params;

      const result = await revertProductBalance(storeId, productId);

      const updated = await (
        await storeDb(storeId)
      ).product.findFirst({
        where: { id: productId, storeId },
        select: { name: true, nameAr: true, description: true, descriptionAr: true },
      });

      res.json({
        success: true,
        data: {
          reverted: result.reverted,
          name: updated?.name ?? null,
          nameAr: updated?.nameAr ?? null,
          description: updated?.description ?? null,
          descriptionAr: updated?.descriptionAr ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// =====================================================================
// Catalogue field sweep results — closes the every-data-has-a-UI gap for
// category / image-alt / excerpt / tags, mirroring /results/translate etc.
// =====================================================================

/**
 * GET /stores/:storeId/ai/results/categorize
 * Category-assignment fill-rate: how many active products have >=1
 * category, plus the 5 most recently-categorized products.
 */
router.get('/results/categorize', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [totalProducts, categorizedProducts, recentProducts] = await Promise.all([
      (await storeDb(storeId)).product.count({
        where: { storeId, status: 'active', deletedAt: null },
      }),
      (await storeDb(storeId)).product.count({
        where: { storeId, status: 'active', deletedAt: null, categories: { some: {} } },
      }),
      (await storeDb(storeId)).product.findMany({
        where: { storeId, status: 'active', deletedAt: null, categories: { some: {} } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          updatedAt: true,
          categories: { take: 1, select: { category: { select: { name: true } } } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          filled: categorizedProducts,
          fillRate: totalProducts === 0 ? 0 : categorizedProducts / totalProducts,
        },
        recentProducts: recentProducts.map(p => ({
          id: p.id,
          name: p.name,
          categoryName: p.categories[0]?.category.name ?? null,
          updatedAt: p.updatedAt,
        })),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/image-alt
 * Image alt-text fill-rate across every active product's images.
 */
router.get('/results/image-alt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [totalImages, imagesWithAlt] = await Promise.all([
      (await storeDb(storeId)).productImage.count({
        where: { product: { storeId, status: 'active', deletedAt: null } },
      }),
      (await storeDb(storeId)).productImage.count({
        where: {
          product: { storeId, status: 'active', deletedAt: null },
          alt: { not: null },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        images: {
          total: totalImages,
          filled: imagesWithAlt,
          fillRate: totalImages === 0 ? 0 : imagesWithAlt / totalImages,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/excerpt
 * Excerpt fill-rate + 5 most-recently-filled products.
 */
router.get('/results/excerpt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [totalProducts, productsWithExcerpt, recentProducts] = await Promise.all([
      (await storeDb(storeId)).product.count({
        where: { storeId, status: 'active', deletedAt: null },
      }),
      (await storeDb(storeId)).product.count({
        where: { storeId, status: 'active', deletedAt: null, excerpt: { not: null } },
      }),
      (await storeDb(storeId)).product.findMany({
        where: { storeId, status: 'active', deletedAt: null, excerpt: { not: null } },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: { id: true, name: true, excerpt: true, excerptAr: true, updatedAt: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          filled: productsWithExcerpt,
          fillRate: totalProducts === 0 ? 0 : productsWithExcerpt / totalProducts,
        },
        recentProducts,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /stores/:storeId/ai/results/tags
 * Tag fill-rate + total distinct tags in the store.
 */
router.get('/results/tags', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const storeId = (req.params as { storeId: string }).storeId;

    const [totalProducts, taggedProducts, totalTags] = await Promise.all([
      (await storeDb(storeId)).product.count({
        where: { storeId, status: 'active', deletedAt: null },
      }),
      (await storeDb(storeId)).product.count({
        where: { storeId, status: 'active', deletedAt: null, tags: { some: {} } },
      }),
      (await storeDb(storeId)).tag.count({ where: { storeId } }),
    ]);

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          filled: taggedProducts,
          fillRate: totalProducts === 0 ? 0 : taggedProducts / totalProducts,
        },
        totalTags,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
