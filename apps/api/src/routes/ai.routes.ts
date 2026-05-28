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
import { AppError } from '../middleware/error-handler';
import { inngest } from '../lib/inngest/client';
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

      // For categories section, pass sample category names so the AI
      // grounds copy in the merchant's actual catalog rather than
      // inventing generic "fashion / accessories / lifestyle" lines.
      let categoryNames: string[] | undefined;
      if (section === 'categories') {
        const cats = await prisma.category.findMany({
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

      const store = await prisma.store.findUnique({
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

// Helper: when inngest is unreachable (DNS / outage / wrong key), the
// job row was created but no one will ever process it. Mark it failed
// so the merchant sees an actionable error instead of a stuck "queued"
// row that lingers forever.
async function markJobFailedIfEnqueueFailed(jobId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : 'Failed to enqueue job';
  try {
    await prisma.bulkAiJob.update({
      where: { id: jobId },
      data: { status: 'failed', errorMessage: message, completedAt: new Date() },
    });
  } catch {
    // best-effort
  }
}

router.post(
  '/bulk/translate',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { direction } = bulkTranslateSchema.parse(req.body);

      const job = await prisma.bulkAiJob.create({
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

router.post('/bulk/seo', writeLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const force = req.body?.force === true;

    const job = await prisma.bulkAiJob.create({
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
});

router.get('/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const jobs = await prisma.bulkAiJob.findMany({
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
    const job = await prisma.bulkAiJob.findFirst({
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
  count: z.number().int().min(1).max(10).default(5),
});

router.post(
  '/product-faqs/draft',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { productId, count } = draftProductFaqsSchema.parse(req.body);

      // Verify the product belongs to this store.
      const product = await prisma.product.findFirst({
        where: { id: productId, storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          description: true,
          descriptionAr: true,
        },
      });
      if (!product) {
        throw new AppError(404, 'NOT_FOUND', 'Product not found');
      }

      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { name: true, nameAr: true },
      });

      // Use the Gemini model to draft product-specific FAQs.
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_KEY;
      if (!apiKey) {
        throw new AppError(503, 'AI_NOT_CONFIGURED', 'AI service is not configured');
      }
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({
        model: process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest',
      });

      const prompt = `You are an SEO + AEO expert helping a Kuwait-based e-commerce store write product FAQs.

Store: ${store?.name ?? storeId}
Product: ${product.name}${product.nameAr ? ` / ${product.nameAr}` : ''}
Description: ${product.description ?? '(no description provided)'}

Draft exactly ${count} FAQ pairs that real customers would ask about this specific product.
Cover: sizing/fit, materials, shipping time, return policy, how to use, care instructions — pick the most relevant for this product.
Each FAQ must have a question AND answer in BOTH English AND Arabic (formal MSA, not dialect).

Return ONLY valid JSON — no markdown, no explanation:
[
  {
    "question": "English question?",
    "questionAr": "السؤال بالعربية؟",
    "answer": "English answer.",
    "answerAr": "الإجابة بالعربية."
  }
]`;

      const result = await model.generateContent(prompt);
      const raw = result.response.text();

      // Extract outermost JSON array to tolerate any trailing text Gemini adds.
      const start = raw.indexOf('[');
      const end = raw.lastIndexOf(']');
      if (start === -1 || end === -1) {
        throw new AppError(502, 'AI_PARSE_ERROR', 'AI returned unexpected format');
      }
      const faqs = JSON.parse(raw.slice(start, end + 1)) as Array<{
        question: string;
        questionAr?: string;
        answer: string;
        answerAr?: string;
      }>;

      // Record AI usage for quota tracking (non-blocking).
      prisma.aiUsage
        .create({
          data: {
            storeId,
            feature: 'product_faq_draft',
            inputTokens: 0,
            outputTokens: 0,
            cachedHit: false,
          },
        })
        .catch(() => {
          /* intentionally swallowed */
        });

      res.json({ success: true, data: { faqs } });
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

    const dailyCap = parseInt(process.env.AI_DAILY_REQUEST_CAP ?? '1000', 10);
    const monthlyCap = parseInt(process.env.AI_MONTHLY_REQUEST_CAP ?? '20000', 10);

    const [todayCount, monthCount, last30] = await Promise.all([
      prisma.aiUsage.count({
        where: { storeId, createdAt: { gte: startOfDay }, cachedHit: false },
      }),
      prisma.aiUsage.count({
        where: { storeId, createdAt: { gte: startOfMonth }, cachedHit: false },
      }),
      prisma.$queryRaw<Array<{ day: Date; total: bigint }>>`
          SELECT
            DATE_TRUNC('day', created_at) AS day,
            COUNT(*) AS total
          FROM ai_usage
          WHERE store_id = ${storeId}
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY day
          ORDER BY day ASC
        `,
    ]);

    res.json({
      success: true,
      data: {
        today: todayCount,
        thisMonth: monthCount,
        dailyCap,
        monthlyCap,
        // Convert bigint → number so JSON.stringify works.
        last30Days: last30.map(r => ({
          day: r.day.toISOString().slice(0, 10),
          total: Number(r.total),
        })),
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const count = Math.min(parseInt(String(req.body?.count ?? '8'), 10) || 8, 20);
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const count = Math.min(parseInt(String(req.body?.count ?? '3'), 10) || 3, 10);
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const masterRunId = crypto.randomUUID();

      const aeoForce = req.body?.force === true;

      // Create all three jobs in parallel
      const [faqJob, howtoJob, metaJob] = await Promise.all([
        prisma.bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'faq_aeo',
            errors: { master_run_id: masterRunId, ...(aeoForce ? { force: true } : {}) } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
        prisma.bulkAiJob.create({
          data: {
            storeId,
            userId: req.user!.userId,
            kind: 'howto_aeo',
            errors: { master_run_id: masterRunId, ...(aeoForce ? { force: true } : {}) } as object,
          },
          select: { id: true, status: true, kind: true, createdAt: true },
        }),
        prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const force = req.body?.force === true;

      const job = await prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const masterRunId = crypto.randomUUID();

      const geoSweepForce = req.body?.force === true;

      const [llmsJob, citationJob, factsJob] = await Promise.all([
        prisma.bulkAiJob.create({
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
        prisma.bulkAiJob.create({
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
        prisma.bulkAiJob.create({
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
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, jobId } = req.params;
      const updated = await prisma.bulkAiJob.updateMany({
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
      prisma.store.findUnique({
        where: { id: storeId },
        select: { llmsTxt: true, aboutJson: true },
      }),
      prisma.product.count({ where: { storeId, deletedAt: null } }),
      prisma.product.count({
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

    const rows = await prisma.aiRecommendation.findMany({
      where: { storeId, sourceProductId: productId },
      orderBy: { score: 'desc' },
      take: 25,
      select: {
        id: true,
        targetProductId: true,
        score: true,
        reason: true,
        createdAt: true,
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
          createdAt: r.createdAt,
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

      const [totalProducts, distinctSourcesWithRecs, totalRecs] = await Promise.all([
        prisma.product.count({ where: { storeId, deletedAt: null } }),
        prisma.aiRecommendation
          .findMany({
            where: { storeId },
            distinct: ['sourceProductId'],
            select: { sourceProductId: true },
          })
          .then(rows => rows.length),
        prisma.aiRecommendation.count({ where: { storeId } }),
      ]);

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

export default router;
