import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { StoreService } from '../services/store.service';

const router = Router();

// Validation schemas
const createStoreSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  domain: z.string().optional(),
  settings: z.record(z.any()).optional(),
});

const updateStoreSchema = createStoreSchema.partial();

const themeSchema = z.record(z.unknown()).refine(
  data => {
    // Validate known string fields have reasonable lengths
    const stringFields = [
      'primaryColor',
      'secondaryColor',
      'accentColor',
      'backgroundColor',
      'textColor',
      'buttonStyle',
    ];
    for (const field of stringFields) {
      if (field in data && typeof data[field] === 'string' && (data[field] as string).length > 50)
        return false;
    }
    const longStringFields = ['fontFamily', 'headingFontFamily'];
    for (const field of longStringFields) {
      if (field in data && typeof data[field] === 'string' && (data[field] as string).length > 100)
        return false;
    }
    return true;
  },
  { message: 'Theme field values exceed maximum length' }
);

const seoSchema = z
  .object({
    metaTitle: z.string().max(200).optional(),
    metaTitleAr: z.string().max(200).optional(),
    metaDescription: z.string().max(500).optional(),
    metaDescriptionAr: z.string().max(500).optional(),
  })
  .strip();

const contactSchema = z
  .object({
    email: z.string().email().max(255).optional(),
    phone: z.string().max(50).optional(),
    phoneAr: z.string().max(50).optional(),
    whatsapp: z.string().max(50).optional(),
    address: z.string().max(500).optional(),
    addressAr: z.string().max(500).optional(),
  })
  .strip();

/**
 * @swagger
 * /stores:
 *   get:
 *     summary: List all stores
 *     description: Get paginated list of all stores (admin only)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: List of stores
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     stores:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Store'
 *                     meta:
 *                       $ref: '#/components/schemas/Pagination'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 */
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page, limit } = req.query;

      const result = await StoreService.list({
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
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

// GET /stores/:id - Get store by ID
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const store = await StoreService.getById(id);

    res.json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:id/stats - Get store stats
router.get('/:id/stats', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const stats = await StoreService.getStoreStats(id);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /stores:
 *   post:
 *     summary: Create a new store
 *     description: Create a new store (admin only)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: My Store
 *               slug:
 *                 type: string
 *                 pattern: ^[a-z0-9-]+$
 *                 example: my-store
 *               domain:
 *                 type: string
 *                 example: mystore.com
 *               settings:
 *                 type: object
 *     responses:
 *       201:
 *         description: Store created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     store:
 *                       $ref: '#/components/schemas/Store'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = createStoreSchema.parse(req.body);

      const store = await StoreService.create(req.user!.userId, data);

      res.status(201).json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id - Update store (admin only)
router.put(
  '/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateStoreSchema.parse(req.body);

      const store = await StoreService.update(id, data);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:id - Delete store
router.delete(
  '/:id',
  authenticate,
  authorize('super_admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      await StoreService.delete(id);

      res.json({
        success: true,
        data: { message: 'Store deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/template - Update store template
router.put(
  '/:id/template',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { template } = req.body;

      if (!template) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_TEMPLATE', message: 'Template is required' },
        });
        return;
      }

      const store = await StoreService.updateTemplate(id, template);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/theme - Update store theme
router.put(
  '/:id/theme',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const theme = themeSchema.parse(req.body);

      const store = await StoreService.updateTheme(id, theme as any);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/branding - Update store branding
router.put(
  '/:id/branding',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const branding = req.body;

      const store = await StoreService.updateBranding(id, branding);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/social - Update store social links
router.put(
  '/:id/social',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const socialLinks = req.body;

      const store = await StoreService.updateSocialLinks(id, socialLinks);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/contact - Update store contact info
router.put(
  '/:id/contact',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const contact = contactSchema.parse(req.body);

      const store = await StoreService.updateContactInfo(id, contact);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/announcement - Update store announcement bar
router.put(
  '/:id/announcement',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const announcementBar = req.body;

      const store = await StoreService.updateAnnouncementBar(id, announcementBar);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/seo - Update store SEO settings
router.put(
  '/:id/seo',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const seo = seoSchema.parse(req.body);

      const store = await StoreService.updateSeo(id, seo);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/marketing-pixels - Update store marketing pixels
router.put(
  '/:id/marketing-pixels',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { marketingPixels } = req.body;

      const store = await StoreService.updateMarketingPixels(id, marketingPixels);

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
