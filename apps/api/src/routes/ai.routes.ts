import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { AIService } from '../services/ai.service';
import { auditLog, writeLimiter } from '../middleware/security';

const router = Router();

// Rate limiter specifically for AI endpoints (more restrictive)
import rateLimit from 'express-rate-limit';

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 AI requests per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many AI requests. Please wait.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation schemas
const productDescriptionSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().optional(),
  features: z.array(z.string()).optional(),
  targetAudience: z.string().optional(),
  tone: z.enum(['professional', 'casual', 'luxury', 'playful']).optional(),
  length: z.enum(['short', 'medium', 'long']).optional(),
});

const seoSchema = z.object({
  productName: z.string().min(1).max(255),
  description: z.string().min(1).max(2000),
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

const marketingCopySchema = z.object({
  productName: z.string().min(1).max(255),
  description: z.string().min(1).max(2000),
  promoType: z.enum(['sale', 'new_arrival', 'limited_edition', 'seasonal', 'general']),
  discount: z.number().min(0).max(100).optional(),
  platform: z.enum(['email', 'social', 'banner', 'push']).optional(),
});

const improveTextSchema = z.object({
  text: z.string().min(1).max(5000),
  goal: z.enum(['clarity', 'engagement', 'seo', 'conciseness']),
});

const categoryDescriptionSchema = z.object({
  categoryName: z.string().min(1).max(100),
  productTypes: z.array(z.string()).min(1),
});

/**
 * GET /ai/status
 * Check AI service availability
 */
router.get('/status', authenticate, async (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      available: AIService.isAvailable(),
      features: [
        'product-description',
        'seo',
        'marketing-copy',
        'improve-text',
        'category-description',
      ],
    },
  });
});

/**
 * POST /ai/product-description
 * Generate product description
 */
router.post(
  '/product-description',
  authenticate,
  requirePermission('ai:use'),
  aiLimiter,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = productDescriptionSchema.parse(req.body);
      const result = await AIService.generateProductDescription(input);

      await auditLog({
        action: 'ai.product_description',
        userId: req.user!.userId,
        resourceType: 'ai',
        details: { productName: input.name },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: {
          description: result.content,
          tokensUsed: result.tokens_used,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /ai/seo
 * Generate SEO meta tags
 */
router.post(
  '/seo',
  authenticate,
  requirePermission('ai:use'),
  aiLimiter,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = seoSchema.parse(req.body);
      const result = await AIService.generateSEO(input);

      await auditLog({
        action: 'ai.seo',
        userId: req.user!.userId,
        resourceType: 'ai',
        details: { productName: input.productName },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /ai/marketing-copy
 * Generate marketing copy
 */
router.post(
  '/marketing-copy',
  authenticate,
  requirePermission('ai:use'),
  aiLimiter,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = marketingCopySchema.parse(req.body);
      const result = await AIService.generateMarketingCopy(input);

      await auditLog({
        action: 'ai.marketing_copy',
        userId: req.user!.userId,
        resourceType: 'ai',
        details: { productName: input.productName, promoType: input.promoType },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /ai/improve-text
 * Improve existing text
 */
router.post(
  '/improve-text',
  authenticate,
  requirePermission('ai:use'),
  aiLimiter,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = improveTextSchema.parse(req.body);
      const result = await AIService.improveText(input.text, input.goal);

      await auditLog({
        action: 'ai.improve_text',
        userId: req.user!.userId,
        resourceType: 'ai',
        details: { goal: input.goal, originalLength: input.text.length },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: {
          improvedText: result.content,
          tokensUsed: result.tokens_used,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /ai/category-description
 * Generate category description
 */
router.post(
  '/category-description',
  authenticate,
  requirePermission('ai:use'),
  aiLimiter,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = categoryDescriptionSchema.parse(req.body);
      const result = await AIService.generateCategoryDescription(
        input.categoryName,
        input.productTypes
      );

      await auditLog({
        action: 'ai.category_description',
        userId: req.user!.userId,
        resourceType: 'ai',
        details: { categoryName: input.categoryName },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        success: true,
        data: {
          description: result.content,
          tokensUsed: result.tokens_used,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
