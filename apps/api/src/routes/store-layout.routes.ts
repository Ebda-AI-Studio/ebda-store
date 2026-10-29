/**
 * Store layout settings — admin GET/PUT for the layout-toggle page +
 * a public read used by the storefront when rendering the home composition.
 *
 * The shape is `StoreLayoutSettings` from @ebda/shared; an empty `{}` blob
 * resolves to packaged Storefront-flow defaults via `resolveLayoutSettings`,
 * so existing tenants don't need a backfill before this ships.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { prisma } from '@ebda/database';
import {
  resolveLayoutSettings,
  storeLayoutSchema,
  heroSlideSchema,
  pageOwnedKeysIn,
  normalizeLegacyTemplate,
} from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { cleanupRemovedJsonUrls } from '../services/r2-cleanup.service';
import { bustStoreCaches } from '../services/store.service';
import { publishLegacyLayout } from '../services/page-builder.service';
import logger from '../lib/logger';
import { storeUpdate } from '../lib/repo-factory';

const router = Router({ mergeParams: true });

// The layout Zod schema lives in @ebda/shared (`builder/layout-schema.ts`) so
// the visual-builder section registry and this PUT validate with ONE schema.
// Re-exported under the old names for `tests/unit/layout-schema-parity.test.ts`
// and `tests/unit/hero-slide-schema.test.ts`.
export const layoutSchema: z.ZodObject<Record<string, z.ZodTypeAny>> = storeLayoutSchema;
export { heroSlideSchema };

/**
 * GET /admin/stores/:storeId/layout
 * Returns the resolved (= defaults-merged) layout settings.
 */
router.get(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true, template: true, look: true },
      });
      const layout = resolveLayoutSettings(
        store?.layoutSettings ?? {},
        store?.template ? normalizeLegacyTemplate(store.template) : undefined,
        store?.look
      );
      res.json({ success: true, data: { layout } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/stores/:storeId/layout
 * Patches the layout settings. The request body can contain any subset of
 * the section keys; missing sections keep their current values. The whole
 * shape is re-merged through `resolveLayoutSettings` before persisting so
 * the on-disk JSON is always a complete, valid `StoreLayoutSettings`.
 */
router.put(
  '/',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Product / collection / cart page settings are written by the visual editor, per page (VE-13).
      // Taking them here would be accepted and then ignored by the next home publish, so refuse loudly.
      const moved = pageOwnedKeysIn(req.body);
      if (moved.length > 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'PAGE_SETTINGS_MOVED',
            message: `These settings are edited per page in the visual editor: ${moved.join(', ')}`,
            details: { keys: moved },
          },
        });
        return;
      }
      const patch = layoutSchema.parse(req.body);

      const current = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true, template: true, look: true, slug: true, domain: true },
      });
      const previousLayout = current?.layoutSettings ?? {};
      const currentTemplate = current?.template
        ? normalizeLegacyTemplate(current.template)
        : undefined;
      const merged = resolveLayoutSettings(
        {
          ...resolveLayoutSettings(previousLayout, currentTemplate, current?.look),
          ...patch,
        },
        currentTemplate,
        current?.look
      );

      // One writer for page documents (visual builder): this legacy save
      // becomes a published revision too, so the revision history and
      // `layout_settings` never diverge. Losing a race to a concurrent
      // publish answers 409 instead of overwriting it.
      const outcome = await publishLegacyLayout({
        storeId,
        layout: merged,
        userId: getAuthUser(req).userId,
      });
      if (outcome === 'conflict') {
        res.status(409).json({
          success: false,
          error: {
            code: 'REV_CONFLICT',
            message: 'The page was published by another editor at the same time; reload and retry.',
          },
        });
        return;
      }
      if (outcome !== 'ok') {
        res.status(422).json({
          success: false,
          error: {
            code: 'INVALID_DEFINITION',
            message: 'The page is not ready to publish',
            errors: outcome.invalid,
          },
        });
        return;
      }

      await storeUpdate(prisma, {
        where: { id: storeId },
        data: { layoutSettings: merged as unknown as object },
      });

      // Diff every image URL nested inside the layout JSON (hero slides,
      // banner blocks, etc.) and queue cleanup for any that dropped out.
      // Replacing a hero slide image without this leaks the previous R2
      // object — verified 2026-05-17 with 4 stale hero/* keys.
      void cleanupRemovedJsonUrls(previousLayout, merged).catch(err =>
        logger.warn({ err, storeId }, '[store-layout.put] r2 cleanup failed')
      );

      await auditLog({
        action: 'store.layout.updated',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        details: { keys: Object.keys(patch).join(',') },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Purge EVERY layer the storefront reads the layout through: the Redis
      // `public:store:*` keys (+ generation bump) AND the storefront's Next data
      // cache, via the `layout:<storeId>` tag on its layout fetches. Clearing
      // only `public:store:<id>` left the 60s-revalidate storefront fetch stale.
      // A store that vanished mid-request has nothing to purge.
      if (current) {
        void bustStoreCaches(storeId, current.slug, current.domain).catch(err =>
          logger.warn({ err, storeId }, '[store-layout.put] cache invalidation failed')
        );
      }

      res.json({ success: true, data: { layout: merged } });
    } catch (error) {
      next(error);
    }
  }
);

// `POST /layout/preview` (the form page builder's unsaved-preview token) was removed with the page
// (Ruling VE-6 / VE-18); the visual editor previews through its canvas and the draft preview token.

export default router;
