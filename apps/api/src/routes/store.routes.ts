import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { Prisma, prisma, StoreStatus } from '@force/database';
import { StoreService } from '../services/store.service';
import { VercelDomainService } from '../services/vercel-domain.service';
import { ResendService } from '../services/resend.service';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { getAuthUser } from '../utils/store-helpers';
import { requireFeature } from '../middleware/feature-gate';
import { bustCorsCache } from '../lib/cors-cache';
import { auditLog } from '../middleware/security';

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
  settings: z.record(z.string(), z.any()).optional(),
});

const heroNullableStr = (maxLen: number) =>
  z.preprocess(v => (v === '' ? null : v), z.string().max(maxLen).nullable().optional());

const updateStoreSchema = createStoreSchema.partial().extend({
  heroTitle: heroNullableStr(200),
  heroTitleAr: heroNullableStr(200),
  heroSubtitle: heroNullableStr(500),
  heroSubtitleAr: heroNullableStr(500),
  heroCtaText: heroNullableStr(100),
  heroCtaTextAr: heroNullableStr(100),
  heroCtaLink: heroNullableStr(500),
  heroImage: heroNullableStr(1000),
  blogEnabled: z.boolean().optional(),
});

const themeSchema = z.record(z.string(), z.unknown()).refine(
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

// Helpers that coerce empty strings and nulls to undefined before validation
const optionalStr = (maxLen: number) =>
  z.preprocess(v => (v === '' || v === null ? undefined : v), z.string().max(maxLen).optional());

// Merchants routinely paste the entire `<meta name="google-site-verification"
// content="..." />` tag instead of just the content token. Extract the token
// before validation so the storefront emits a valid meta tag and the
// verification flow doesn't silently fail.
const optionalGoogleVerification = z.preprocess(v => {
  if (typeof v !== 'string') return v === null ? undefined : v;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  const tagMatch = trimmed.match(/content\s*=\s*["']([^"']+)["']/i);
  return tagMatch ? tagMatch[1].trim() : trimmed;
}, z.string().max(200).optional());

const optionalUrl = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().url().max(500).optional()
);

const optionalEmail = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z.string().email().max(255).optional()
);

// Local-part for the from-line on per-store sender. Must be RFC-5321 safe.
const optionalEmailLocalPart = z.preprocess(
  v => (v === '' || v === null ? undefined : v),
  z
    .string()
    .regex(
      /^[a-z0-9._-]+$/,
      'Sender prefix must be lowercase letters, numbers, dot/hyphen/underscore only'
    )
    .max(64)
    .optional()
);

const seoSchema = z
  .object({
    metaTitle: optionalStr(200),
    metaTitleAr: optionalStr(200),
    metaDescription: optionalStr(500),
    metaDescriptionAr: optionalStr(500),
    // AEO — conversational answer-engine copy.
    metaDescriptionAeo: z.string().max(400).optional().nullable(),
    metaDescriptionAeoAr: z.string().max(400).optional().nullable(),
    ogImage: optionalUrl,
    twitterHandle: optionalStr(50),
    googleSiteVerification: optionalGoogleVerification,
    emailSenderLocalPart: optionalEmailLocalPart,
  })
  .strip();

const contactSchema = z
  .object({
    email: optionalEmail,
    phone: optionalStr(50),
    phoneAr: optionalStr(50),
    whatsapp: optionalStr(50),
    address: optionalStr(500),
    addressAr: optionalStr(500),
    // Phase D.6 — WhatsApp bot "Locations & Hours" branch
    businessHours: optionalStr(500),
    googleMapsUrl: optionalStr(2000),
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
    linkedin: optionalUrl,
    wikidata: optionalUrl,
    wikipedia: optionalUrl,
    whatsapp: optionalStr(50),
  })
  .strip();

// Announcement payload mirrors the @force/shared AnnouncementBar shape. The
// storefront renders linkText / linkTextAr / dismissible alongside the link
// itself, so the schema must accept (and the .strip() must not drop) them.
const announcementSchema = z
  .object({
    enabled: z.boolean().optional(),
    text: z.string().max(500).optional(),
    textAr: z.string().max(500).optional(),
    bgColor: z.string().max(50).optional(),
    textColor: z.string().max(50).optional(),
    link: optionalUrl,
    linkText: optionalStr(200),
    linkTextAr: optionalStr(200),
    dismissible: z.boolean().optional(),
  })
  .strip();

const marketingPixelsSchema = z.record(z.string(), z.unknown());

// Floating widget — sticky button group on the storefront. Schema mirrors
// the FloatingWidgetConfig type in @force/shared. The buttons array can
// hold any FloatingButton shape; we use z.record for the per-button object
// so adding a new optional field on the client (e.g. a new social kind)
// doesn't immediately require a backend redeploy. Length caps prevent
// runaway payloads — a merchant should not be configuring 200 buttons.
const floatingButtonSchema = z
  .object({
    id: z.string().max(64),
    kind: z.enum(['whatsapp', 'instagram', 'phone', 'email', 'music', 'custom']),
    label: optionalStr(200),
    labelAr: optionalStr(200),
    bgColor: optionalStr(50),
    iconColor: optionalStr(50),
    iconUrl: optionalStr(500),
    whatsappPhone: optionalStr(50),
    whatsappMessage: optionalStr(500),
    instagramHandle: optionalStr(100),
    phoneNumber: optionalStr(50),
    emailAddress: optionalStr(255),
    emailSubject: optionalStr(200),
    musicUrl: optionalStr(500),
    musicLoop: z.boolean().optional(),
    customHref: optionalStr(500),
  })
  .strip();

const floatingWidgetSchema = z
  .object({
    enabled: z.boolean().optional(),
    position: z.enum(['br', 'bl', 'tr', 'tl']).optional(),
    expandDirection: z.enum(['up', 'down', 'left', 'right']).optional(),
    toggleBgColor: optionalStr(50),
    toggleIconUrl: optionalStr(500),
    toggleLabel: optionalStr(200),
    toggleLabelAr: optionalStr(200),
    startExpanded: z.boolean().optional(),
    hideOnMobile: z.boolean().optional(),
    hideOnDesktop: z.boolean().optional(),
    buttons: z.array(floatingButtonSchema).max(50).optional(),
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
        ownerId: req.user!.role === 'store_admin' ? req.user!.userId : undefined,
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
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
  authorize('store_admin', 'super_admin'),
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

      const store = await StoreService.create(getAuthUser(req).userId, {
        ...data,
        settings: data.settings as Prisma.InputJsonValue,
      });

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

      const store = await StoreService.update(id, {
        ...data,
        settings: data.settings as Prisma.InputJsonValue,
      });

      res.json({
        success: true,
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:id - Hard-delete a store and ALL its data (super_admin only).
// Cascade rules in the Prisma schema clean up most relations; the service
// transaction handles the few non-cascading ones (orders, returns, audit logs).
router.delete(
  '/:id',
  authenticate,
  authorize('super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const user = getAuthUser(req);

      const deleted = await StoreService.delete(id);

      await auditLog({
        action: 'STORE_DELETED',
        userId: user.userId,
        resourceType: 'store',
        resourceId: id,
        details: { storeName: deleted.name, storeSlug: deleted.slug },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      logger.info({ storeId: id, deletedBy: user.userId }, '[STORE] Hard-deleted store');

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:id/status - Suspend or activate a store (super_admin only)
router.patch(
  '/:id/status',
  authenticate,
  authorize('super_admin'),
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
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
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

// PUT /stores/:id/floating-widget — dedicated writer for the storefront's
// floating action-button widget. Lives on Store.settings.floatingWidget;
// the merge happens server-side in StoreService.updateFloatingWidget so
// the admin only ships the widget config, not the whole settings blob
// (which is fragile across tabs and silently drops fields if the admin
// holds a stale copy).
router.put(
  '/:id/floating-widget',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const floatingWidget = floatingWidgetSchema.parse(req.body);

      const store = await StoreService.updateFloatingWidget(
        id,
        floatingWidget as Record<string, unknown>
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

// GET /stores/:id/seo - Get store SEO settings
router.get(
  '/:id/seo',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = await prisma.store.findFirst({
        where: { id: req.params.id },
        select: {
          metaTitle: true,
          metaTitleAr: true,
          metaDescription: true,
          metaDescriptionAr: true,
          metaDescriptionAeo: true,
          metaDescriptionAeoAr: true,
          ogImage: true,
          twitterHandle: true,
          googleSiteVerification: true,
          emailSenderLocalPart: true,
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
  requireFeature('marketing_pixels'),
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
      const storeRow = await prisma.store.findUnique({
        where: { id },
        select: { emailDomainId: true, emailDomainStatus: true, emailDomainVerifiedAt: true },
      });

      // No custom domain at all — neither Vercel nor Resend state is meaningful.
      if (!store.domain) {
        res.json({
          success: true,
          data: {
            domain: null,
            verified: false,
            dnsRecords: [],
            emailSender: {
              domainId: storeRow?.emailDomainId ?? null,
              status: storeRow?.emailDomainStatus ?? null,
              verifiedAt: storeRow?.emailDomainVerifiedAt ?? null,
            },
          },
        });
        return;
      }

      const vercelStatus = await VercelDomainService.getDomain(store.domain);

      // Best-effort: refresh Resend status alongside. Failure shouldn't block
      // the admin page from rendering — the storefront domain status is the
      // primary concern; the email DNS records are secondary.
      // `priority` (MX-only, Resend's AWS SES feedback MX defaults to 10)
      // and `ttl` (string, e.g. "Auto" or seconds) are preserved through
      // the merge. Without them merchants hit registrar fields they don't
      // know how to fill — caught on wadyaljuz.com 2026-05-13.
      let resendRecords: Array<{
        type: string;
        name: string;
        value: string;
        priority?: number;
        ttl?: string;
      }> = [];
      if (storeRow?.emailDomainId) {
        try {
          const refreshed = await ResendService.refreshDomainStatus(id);
          resendRecords = refreshed.records.map(r => ({
            type: r.type,
            name: r.name,
            value: r.value,
            ...(typeof r.priority === 'number' ? { priority: r.priority } : {}),
            ...(r.ttl ? { ttl: r.ttl } : {}),
          }));
        } catch (err) {
          logger.warn(
            { err, storeId: id },
            'Resend status fetch failed during GET /domain — admin will still render Vercel side'
          );
        }
      }

      // Merge Vercel + Resend DNS records into one panel. The admin renders
      // this list under a neutral 'DNS records to add at your registrar'
      // heading so merchants never see provider names. The fallback when
      // Vercel API is unreachable now mirrors the apex-vs-subdomain split
      // from VercelDomainService: an apex like `wadyaljuz.com` gets the
      // simple `A @ → 76.76.21.21` instruction; a subdomain like
      // `shop.example.com` keeps the CNAME path. www handling is automatic
      // (the service pre-attaches the www variant when an apex is added).
      const isApexFallback = store.domain.split('.').filter(Boolean).length === 2;
      const vercelRecords =
        vercelStatus?.dnsRecords ??
        (isApexFallback
          ? [{ type: 'A', name: '@', value: '76.76.21.21' }]
          : [{ type: 'CNAME', name: store.domain, value: 'cname.vercel-dns.com' }]);
      const mergedDns = [...vercelRecords, ...resendRecords];

      res.json({
        success: true,
        data: {
          ...(vercelStatus ?? {
            domain: store.domain,
            verified: false,
            misconfigured: true,
          }),
          dnsRecords: mergedDns,
          emailSender: {
            domainId: storeRow?.emailDomainId ?? null,
            status: storeRow?.emailDomainStatus ?? null,
            verifiedAt: storeRow?.emailDomainVerifiedAt ?? null,
          },
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
    // Compensation context for partial-success rollback: if we successfully
    // register a new domain with Vercel but the subsequent DB update fails,
    // we must remove the domain from Vercel so it doesn't strand as a
    // phantom (admin can't see it, but Vercel is still serving / billing).
    // Cleared once the DB update commits.
    let rollbackVercelAdd: (() => Promise<void>) | null = null;

    try {
      const { id } = req.params;
      const rawDomain = (req.body as { domain: string | null }).domain;

      // Normalize domain: lowercase, strip www prefix, trim whitespace
      const domain = rawDomain
        ? rawDomain
            .toLowerCase()
            .replace(/^www\./, '')
            .trim()
        : null;

      const store = await StoreService.getById(id);
      const oldDomain = store.domain;

      const previousEmailRow = await prisma.store.findUnique({
        where: { id },
        select: { emailDomainId: true },
      });
      const previousEmailDomainId = previousEmailRow?.emailDomainId ?? null;

      // Add new domain to Vercel FIRST (before touching the old one). If we
      // removed the old domain first and then add-new failed, the storefront
      // on the old domain would go dark AND the new domain wouldn't work —
      // a customer-visible outage. With this ordering, the old domain keeps
      // serving traffic until everything else (Vercel add + DB update)
      // succeeds; old-domain removal moves to AFTER the DB commit below.
      if (domain && domain !== oldDomain) {
        // Check platform configuration first — domain feature is unusable
        // without the Vercel API credentials configured on the API
        if (!VercelDomainService.isConfigured()) {
          res.status(503).json({
            success: false,
            error: {
              code: 'DOMAIN_FEATURE_UNAVAILABLE',
              message:
                'Custom domain feature is not configured on this platform. Please contact support.',
            },
          });
          return;
        }

        // Check uniqueness
        const existingStore = await StoreService.getByDomain(domain).catch(() => null);
        if (existingStore && existingStore.id !== id) {
          res.status(400).json({
            success: false,
            error: { code: 'DOMAIN_TAKEN', message: 'Domain is already in use by another store' },
          });
          return;
        }

        const vercelResult = await VercelDomainService.addDomain(domain);
        if (!vercelResult) {
          res.status(502).json({
            success: false,
            error: {
              code: 'DOMAIN_PROVISION_FAILED',
              message:
                'Failed to register domain with the platform. Please try again or contact support.',
            },
          });
          return;
        }

        // Vercel-add succeeded — arm the compensating action in case the DB
        // update below throws (slug collision race, DB hiccup, etc.). Without
        // this, the domain would be registered in Vercel but invisible to
        // the admin in our DB.
        const domainToRollback = domain;
        rollbackVercelAdd = async () => {
          try {
            await VercelDomainService.removeDomain(domainToRollback);
            logger.info(
              { domain: domainToRollback },
              '[STORE] Rolled back Vercel domain after DB update failure'
            );
          } catch (rollbackError) {
            logger.error(
              {
                err: rollbackError instanceof Error ? rollbackError.message : 'Unknown error',
                domain: domainToRollback,
              },
              '[STORE] Failed to roll back Vercel domain — manual cleanup required'
            );
          }
        };
      }

      // Update domain in DB (use prisma directly for null clearing)
      const updated = domain
        ? await StoreService.update(id, { domain })
        : await prisma.store.update({
            where: { id },
            data: { domain: null },
            include: {
              owner: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          });

      // DB update committed — disarm the rollback so a successful change is
      // never undone by a downstream error (e.g. CORS-cache bust, status fetch).
      rollbackVercelAdd = null;

      // Per-store Resend provisioning. Run only on actual domain change.
      // Order matters: remove the OLD Resend record BEFORE provisioning the
      // new one, otherwise provisionStoreDomain would overwrite the row's
      // emailDomainId and we'd lose the reference to the old domain.
      if (domain !== oldDomain) {
        if (previousEmailDomainId) {
          // Await the removal so the upcoming provision sees a clean row state
          // (no stale emailDomainId that would cause provisionStoreDomain to
          // refresh the old Resend domain instead of creating a new one).
          await ResendService.removeStoreDomain(id).catch(error =>
            logger.error(
              { err: error instanceof Error ? error.message : 'Unknown error', storeId: id },
              'Failed to remove old Resend domain after domain change'
            )
          );
        }

        if (domain) {
          try {
            await ResendService.provisionStoreDomain(id);
          } catch (err) {
            logger.warn(
              { err, storeId: id, domain },
              'Resend domain provision failed (storefront still works; email stays on platform fallback)'
            );
          }
        }
      }

      // Remove old domain from Vercel AFTER the DB commit. Doing this before
      // (and especially before adding the new domain) created a window where
      // an addDomain failure left BOTH domains broken — old removed, new not
      // added. Now: new domain is live, DB points at it, then we tear down
      // the old one. Fire-and-forget — if the carrier-side removal fails we
      // log it; the worst case is a stranded domain alias on Vercel (no
      // customer impact, just manual cleanup).
      if (oldDomain && oldDomain !== domain) {
        const domainToRemove = oldDomain;
        void VercelDomainService.removeDomain(domainToRemove).catch(error =>
          logger.error(
            {
              err: error instanceof Error ? error.message : 'Unknown error',
              oldDomain: domainToRemove,
            },
            '[STORE] Failed to remove old domain from Vercel after DB commit — manual cleanup may be required'
          )
        );
      }

      // Bust CORS cache so the new domain works immediately
      if (domain) bustCorsCache(domain);
      if (oldDomain && oldDomain !== domain) bustCorsCache(oldDomain);

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
      // Run any compensating action that was armed above
      if (rollbackVercelAdd) {
        await rollbackVercelAdd();
      }
      next(error);
    }
  }
);

// POST /stores/:id/email-sender/provision — create or refresh the Resend
// domain entry and return the DNS records the merchant must add. Idempotent.
router.post(
  '/:id/email-sender/provision',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const records = await ResendService.provisionStoreDomain(req.params.id);
      res.json({ success: true, data: { records } });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:id/email-sender/verify — kick off Resend verification AND
// refresh the local state. Previously called refreshDomainStatus which only
// does a GET; without the POST-to-/verify the domain stays in `not_started`
// forever. Caught on wadyaljuz.com 2026-05-13.
router.post(
  '/:id/email-sender/verify',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ResendService.verifyAndRefreshDomain(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
);

// ===== Store FAQ CRUD =====

const faqSchema = z.object({
  question: z.string().min(1).max(500),
  questionAr: z.string().max(500).optional().nullable(),
  answer: z.string().min(1).max(5000),
  answerAr: z.string().max(5000).optional().nullable(),
  orderIndex: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

router.get(
  '/:id/faqs',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const faqs = await prisma.storeFaq.findMany({
        where: { storeId: req.params.id },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ success: true, data: faqs });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/faqs',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = faqSchema.parse(req.body);
      const faq = await prisma.storeFaq.create({
        data: {
          storeId: req.params.id,
          question: body.question,
          questionAr: body.questionAr ?? null,
          answer: body.answer,
          answerAr: body.answerAr ?? null,
          orderIndex: body.orderIndex ?? 0,
          isActive: body.isActive ?? true,
          aiDrafted: false,
          manuallyEdited: true,
        },
      });
      res.status(201).json({ success: true, data: faq });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/faqs/:faqId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = faqSchema.partial().parse(req.body);
      const faq = await prisma.storeFaq.updateMany({
        where: { id: req.params.faqId, storeId: req.params.id },
        data: {
          ...(body.question !== undefined && { question: body.question }),
          ...(body.questionAr !== undefined && { questionAr: body.questionAr }),
          ...(body.answer !== undefined && { answer: body.answer }),
          ...(body.answerAr !== undefined && { answerAr: body.answerAr }),
          ...(body.orderIndex !== undefined && { orderIndex: body.orderIndex }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
          manuallyEdited: true,
        },
      });
      if (faq.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
      }
      const updated = await prisma.storeFaq.findUnique({ where: { id: req.params.faqId } });
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id/faqs/:faqId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await prisma.storeFaq.deleteMany({
        where: { id: req.params.faqId, storeId: req.params.id },
      });
      if (deleted.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'FAQ not found');
      }
      res.json({ success: true, data: { message: 'FAQ deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

// ===== Store HowTo CRUD =====

const howtoStepSchema = z.object({
  name: z.string().min(1).max(200),
  text: z.string().min(1).max(2000),
  image: z.string().url().optional(),
});

const howtoSchema = z.object({
  title: z.string().min(1).max(200),
  titleAr: z.string().max(200).optional().nullable(),
  description: z.string().min(1).max(2000),
  descriptionAr: z.string().max(2000).optional().nullable(),
  steps: z.array(howtoStepSchema).min(1).max(20),
  stepsAr: z.array(howtoStepSchema).optional().nullable(),
  orderIndex: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

router.get(
  '/:id/howtos',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const howtos = await prisma.storeHowto.findMany({
        where: { storeId: req.params.id },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ success: true, data: howtos });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/howtos',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = howtoSchema.parse(req.body);
      const howto = await prisma.storeHowto.create({
        data: {
          storeId: req.params.id,
          title: body.title,
          titleAr: body.titleAr ?? null,
          description: body.description,
          descriptionAr: body.descriptionAr ?? null,
          steps: body.steps as Prisma.InputJsonValue,
          stepsAr: body.stepsAr != null ? (body.stepsAr as Prisma.InputJsonValue) : Prisma.DbNull,
          orderIndex: body.orderIndex ?? 0,
          isActive: body.isActive ?? true,
          aiDrafted: false,
          manuallyEdited: true,
        },
      });
      res.status(201).json({ success: true, data: howto });
    } catch (error) {
      next(error);
    }
  }
);

router.put(
  '/:id/howtos/:howtoId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = howtoSchema.partial().parse(req.body);
      // Verify ownership before update
      const existing = await prisma.storeHowto.findFirst({
        where: { id: req.params.howtoId, storeId: req.params.id },
        select: { id: true },
      });
      if (!existing) {
        throw new AppError(404, 'NOT_FOUND', 'HowTo not found');
      }
      const updateData: Prisma.StoreHowtoUpdateInput = { manuallyEdited: true };
      if (body.title !== undefined) updateData.title = body.title;
      if (body.titleAr !== undefined) updateData.titleAr = body.titleAr;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.descriptionAr !== undefined) updateData.descriptionAr = body.descriptionAr;
      if (body.steps !== undefined) updateData.steps = body.steps as Prisma.InputJsonValue;
      if (body.stepsAr !== undefined) {
        updateData.stepsAr =
          body.stepsAr != null ? (body.stepsAr as Prisma.InputJsonValue) : Prisma.DbNull;
      }
      if (body.orderIndex !== undefined) updateData.orderIndex = body.orderIndex;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;
      const updated = await prisma.storeHowto.update({
        where: { id: req.params.howtoId },
        data: updateData,
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
);

router.delete(
  '/:id/howtos/:howtoId',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await prisma.storeHowto.deleteMany({
        where: { id: req.params.howtoId, storeId: req.params.id },
      });
      if (deleted.count === 0) {
        throw new AppError(404, 'NOT_FOUND', 'HowTo not found');
      }
      res.json({ success: true, data: { message: 'HowTo deleted' } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
