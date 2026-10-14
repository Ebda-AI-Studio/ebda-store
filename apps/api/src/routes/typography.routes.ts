import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { prisma } from '@ebda/database';
import { invalidateCached } from '../lib/public-cache';
import { deleteR2ObjectIfOrphan } from '../services/r2-cleanup.service';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// Per-zone styling. Every field is optional so the merchant can leave
// most zones inheriting from the template and only override the bits
// they care about.
const zoneSchema = z.object({
  fontFamily: z.string().max(255).optional(),
  fontSize: z.string().max(64).optional(),
  fontWeight: z.string().max(64).optional(),
  color: z.string().max(64).optional(),
  lineHeight: z.string().max(64).optional(),
  letterSpacing: z.string().max(64).optional(),
  // Label / chip styling — backgroundColor turns the zone into a coloured
  // label. padding + borderRadius shape the chip. The storefront CSS
  // emitter auto-adds `display:inline-block` when any of these are set so
  // padding renders correctly on inline text.
  backgroundColor: z.string().max(64).optional(),
  padding: z.string().max(64).optional(),
  borderRadius: z.string().max(64).optional(),
  // Text decoration — underline / line-through / none.
  textDecoration: z.string().max(64).optional(),
  textDecorationColor: z.string().max(64).optional(),
  textDecorationThickness: z.string().max(32).optional(),
  textUnderlineOffset: z.string().max(32).optional(),
});

// Library of fonts the storefront should load. Two flavors:
//   1. Google Fonts URL the merchant pasted from fonts.google.com
//   2. Custom font file the merchant uploaded to R2 (woff2/woff/ttf/otf)
const fontSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('google'),
    url: z.string().url().max(2048),
    family: z.string().min(1).max(255),
  }),
  z.object({
    type: z.literal('custom'),
    family: z.string().min(1).max(255),
    url: z.string().url().max(2048),
    format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
    weight: z.string().max(64).optional(),
    style: z.enum(['normal', 'italic']).optional(),
  }),
]);

const typographySchema = z.object({
  fonts: z.array(fontSourceSchema).max(20),
  zones: z
    .object({
      // Broad zones
      beforeHeader: zoneSchema.optional(),
      header: zoneSchema.optional(),
      // storeName is a sub-zone of the header (store name text in the header
      // bar). Previously missing from this schema which caused Zod to silently
      // strip merchant edits made from the page-builder Header card — 2026-05-28.
      storeName: zoneSchema.optional(),
      categories: zoneSchema.optional(),
      products: zoneSchema.optional(),
      footer: zoneSchema.optional(),
      afterFooter: zoneSchema.optional(),
      // Sub-zones (nested inside broad zones; CSS specificity wins)
      sectionKicker: zoneSchema.optional(),
      sectionTitle: zoneSchema.optional(),
      sectionSubtitle: zoneSchema.optional(),
      sectionSeeAll: zoneSchema.optional(),
      productName: zoneSchema.optional(),
      productPrice: zoneSchema.optional(),
      cta: zoneSchema.optional(),
      filters: zoneSchema.optional(),
    })
    .default({}),
});

const EMPTY = { fonts: [], zones: {} };

// GET /stores/:storeId/typography — current typography settings.
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Defensive: column was added by migration 20260501010000. Until
      // every environment runs that migration, swallow P2022 and serve
      // an empty config so the admin page doesn't 500 on first visit.
      try {
        const store = await prisma.store.findUnique({
          where: { id: storeId },
          select: { typography: true },
        });
        res.json({ success: true, data: { typography: store?.typography ?? EMPTY } });
      } catch (err) {
        logger.warn({ err, storeId }, '[typography GET] column missing?');
        res.json({ success: true, data: { typography: EMPTY } });
      }
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/typography — replace the entire typography
// blob. The admin form is a single coherent unit, so partial updates
// don't add real value here — the client always sends the full shape.
router.put(
  '/',
  authenticate,
  requirePermission('settings:write'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = typographySchema.parse(req.body);

      // Snapshot the previous custom-font URLs so we can clean up R2
      // when a font gets removed from the library.
      let previous: { fonts?: Array<{ type: string; url?: string }> } = {};
      try {
        const existing = await prisma.store.findUnique({
          where: { id: storeId },
          select: { typography: true },
        });
        previous = (existing?.typography as typeof previous) ?? {};
      } catch (err) {
        // pre-migration; nothing to compare
        logger.warn({ err, storeId }, '[typography PUT] previous read failed');
      }

      const store = await prisma.store.update({
        where: { id: storeId },
        data: { typography: data },
        select: { typography: true },
      });

      // R2 cleanup for any custom font URL that disappeared from the
      // library. Google fonts are external — nothing to delete.
      const newCustomUrls = new Set(data.fonts.filter(f => f.type === 'custom').map(f => f.url));
      const previousFonts = Array.isArray(previous.fonts) ? previous.fonts : [];
      for (const f of previousFonts) {
        if (f.type !== 'custom' || !f.url) continue;
        if (newCustomUrls.has(f.url)) continue;
        void deleteR2ObjectIfOrphan(f.url).catch(err =>
          logger.warn({ err, storeId, url: f.url }, '[typography PUT] r2 cleanup failed')
        );
      }

      await auditLog({
        action: 'store.typography.updated',
        userId: req.user!.userId,
        resourceType: 'store',
        resourceId: storeId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Bust the public store cache so the storefront picks up the new
      // typography on the next request rather than waiting out the TTL.
      await invalidateCached(`public:store:${storeId}`);

      res.json({ success: true, data: { typography: store.typography } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
