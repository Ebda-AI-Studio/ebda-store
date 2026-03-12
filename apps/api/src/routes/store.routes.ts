import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireRole } from '../middleware/rbac';
import { Prisma, prisma, StoreStatus } from '@force/database';
import { StoreService } from '../services/store.service';
import { VercelDomainService } from '../services/vercel-domain.service';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { getAuthUser } from '../utils/store-helpers';

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

// Helpers that coerce empty strings and nulls to undefined before validation
const optionalStr = (maxLen: number) =>
  z.preprocess(v => (v === '' || v === null ? undefined : v), z.string().max(maxLen).optional());

const optionalUrl = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().url().max(500).optional()
);

const optionalEmail = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().email().max(255).optional()
);

const contactSchema = z
  .object({
    email: optionalEmail,
    phone: optionalStr(50),
    phoneAr: optionalStr(50),
    whatsapp: optionalStr(50),
    address: optionalStr(500),
    addressAr: optionalStr(500),
  })
  .strip();

const brandingSchema = z
  .object({
    name: z.preprocess(v => (v === null ? undefined : v), z.string().min(1).max(200).optional()),
    nameAr: optionalStr(200),
    logo: optionalUrl,
    logoAr: optionalUrl,
    favicon: optionalUrl,
    description: optionalStr(1000),
    descriptionAr: optionalStr(1000),
  })
  .strip();

const socialSchema = z
  .object({
    facebook: optionalUrl,
    instagram: optionalUrl,
    twitter: optionalUrl,
    tiktok: optionalUrl,
    youtube: optionalUrl,
    snapchat: optionalUrl,
    whatsapp: optionalStr(50),
  })
  .strip();

const announcementSchema = z
  .object({
    enabled: z.boolean().optional(),
    text: z.string().max(500).optional(),
    textAr: z.string().max(500).optional(),
    bgColor: z.string().max(50).optional(),
    textColor: z.string().max(50).optional(),
    link: optionalUrl,
  })
  .strip();

const marketingPixelsSchema = z.record(z.unknown());

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

// GET /stores/:id - Get store by ID (requires store_admin or super_admin)
router.get(
  '/:id',
  authenticate,
  requireRole(['store_admin', 'super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
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
  }
);

// GET /stores/:id/stats - Get store stats
router.get(
  '/:id/stats',
  authenticate,
  requireRole(['store_admin', 'super_admin']),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
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
  }
);

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

      const store = await StoreService.create(getAuthUser(req).userId, data);

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

// PATCH /stores/:id/status - Suspend or activate a store (super_admin only)
router.patch(
  '/:id/status',
  authenticate,
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body as { status: StoreStatus };

      if (!['active', 'suspended'].includes(status)) {
        throw new AppError(400, 'INVALID_STATUS', 'Status must be active or suspended');
      }

      const store = await prisma.store.update({
        where: { id: req.params.id },
        data: { status: status as StoreStatus },
      });

      res.json({ success: true, data: store });
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

      const store = await StoreService.updateTheme(id, theme as Prisma.InputJsonValue);

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
      const branding = brandingSchema.parse(req.body);

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
      const socialLinks = socialSchema.parse(req.body);

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

// GET /stores/:id/announcement - Get store announcement bar settings
router.get(
  '/:id/announcement',
  authenticate,
  requireRole(['store_admin', 'super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await prisma.store.findFirst({
        where: { id: req.params.id },
        select: { announcementBar: true },
      });

      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

      res.json({ success: true, data: store.announcementBar ?? {} });
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
      const announcementBar = announcementSchema.parse(req.body);

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

// GET /stores/:id/seo - Get store SEO settings
router.get(
  '/:id/seo',
  authenticate,
  requireRole(['store_admin', 'super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await prisma.store.findFirst({
        where: { id: req.params.id },
        select: {
          metaTitle: true,
          metaTitleAr: true,
          metaDescription: true,
          metaDescriptionAr: true,
        },
      });

      if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

      res.json({ success: true, data: store });
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
      const { marketingPixels } = z
        .object({ marketingPixels: marketingPixelsSchema })
        .parse(req.body);

      const store = await StoreService.updateMarketingPixels(
        id,
        marketingPixels as Prisma.InputJsonValue
      );

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:id/domain - Get domain verification status
router.get(
  '/:id/domain',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const store = await StoreService.getById(id);

      if (!store.domain) {
        res.json({
          success: true,
          data: { domain: null, verified: false, dnsRecords: [] },
        });
        return;
      }

      const status = await VercelDomainService.getDomain(store.domain);

      res.json({
        success: true,
        data: status || {
          domain: store.domain,
          verified: false,
          misconfigured: true,
          dnsRecords: [{ type: 'CNAME', name: store.domain, value: 'cname.vercel-dns.com' }],
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:id/domain - Update store custom domain
router.put(
  '/:id/domain',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { domain } = req.body as { domain: string | null };

      const store = await StoreService.getById(id);
      const oldDomain = store.domain;

      // Remove old domain from Vercel
      if (oldDomain && oldDomain !== domain) {
        try {
          await VercelDomainService.removeDomain(oldDomain);
        } catch (error) {
          logger.error(
            { err: error instanceof Error ? error.message : 'Unknown error', oldDomain },
            '[STORE] Failed to remove old domain from Vercel'
          );
        }
      }

      // Add new domain to Vercel
      if (domain && domain !== oldDomain) {
        // Check uniqueness
        const existingStore = await StoreService.getByDomain(domain).catch(() => null);
        if (existingStore && existingStore.id !== id) {
          res.status(400).json({
            success: false,
            error: { code: 'DOMAIN_TAKEN', message: 'Domain is already in use by another store' },
          });
          return;
        }

        try {
          await VercelDomainService.addDomain(domain);
        } catch (error) {
          logger.error(
            { err: error instanceof Error ? error.message : 'Unknown error', domain },
            '[STORE] Failed to add domain to Vercel'
          );
        }
      }

      // Update domain in DB (use prisma directly for null clearing)
      const { prisma } = await import('@force/database');
      const updated = domain
        ? await StoreService.update(id, { domain })
        : await prisma.store.update({
            where: { id },
            data: { domain: null },
            include: {
              owner: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          });

      // Get verification status
      let domainStatus: import('../services/vercel-domain.service').DomainStatus | null = null;
      if (domain) {
        domainStatus = await VercelDomainService.getDomain(domain);
      }

      res.json({
        success: true,
        data: {
          store: updated,
          domainStatus:
            domainStatus ||
            (domain
              ? {
                  domain,
                  verified: false,
                  misconfigured: true,
                  dnsRecords: [{ type: 'CNAME', name: domain, value: 'cname.vercel-dns.com' }],
                }
              : null),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
