/**
 * Store layout settings — admin GET/PUT for the layout-toggle page +
 * a public read used by the storefront when rendering the home composition.
 *
 * The shape is `StoreLayoutSettings` from @force/shared; an empty `{}` blob
 * resolves to packaged Pecannbee-flow defaults via `resolveLayoutSettings`,
 * so existing tenants don't need a backfill before this ships.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { resolveLayoutSettings, storeLayoutSchema, heroSlideSchema } from '@force/shared';
import type { TemplateId } from '@force/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { getAuthUser } from '../utils/store-helpers';
import { cleanupRemovedJsonUrls } from '../services/r2-cleanup.service';
import { redis } from '../services/redis.service';
import { bustStoreCaches } from '../services/store.service';
import { publishLegacyLayout } from '../services/page-builder.service';
import logger from '../lib/logger';
import { randomBytes } from 'node:crypto';

const router = Router({ mergeParams: true });

// The layout Zod schema lives in @force/shared (`builder/layout-schema.ts`) so
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
        select: { layoutSettings: true, template: true },
      });
      const layout = resolveLayoutSettings(
        store?.layoutSettings ?? {},
        store?.template as TemplateId | undefined
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
      const patch = layoutSchema.parse(req.body);

      const current = await prisma.store.findUnique({
        where: { id: storeId },
        select: { layoutSettings: true, template: true, slug: true, domain: true },
      });
      const previousLayout = current?.layoutSettings ?? {};
      const currentTemplate = current?.template as TemplateId | undefined;
      const merged = resolveLayoutSettings(
        {
          ...resolveLayoutSettings(previousLayout, currentTemplate),
          ...patch,
        },
        currentTemplate
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

      await prisma.store.update({
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

/**
 * POST /admin/stores/:storeId/layout/preview
 *
 * Real-time-preview endpoint added 2026-05-20 (Ahmad). Stores the merchant's
 * UNSAVED layout in Redis under a short-lived token (1h TTL) and returns the
 * token. The admin page-builder posts the in-memory layout here, then reloads
 * the storefront iframe with `?_layoutDraft=<token>` — storefront reads the
 * draft from Redis instead of DB. Merchant can iterate visually without
 * committing; the actual save still goes through PUT /layout above.
 *
 * Auth: same as PUT (store owner OR super_admin). Tokens are scoped to the
 * caller's store; storeId is verified before the Redis write.
 */
router.post(
  '/preview',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      // Body shape evolved 2026-05-20: accept either the bare layout (legacy
      // single-key shape) OR a `{ layout, typography?, theme? }` bundle. The
      // bundle form lets the page-builder preview global typography zone
      // changes (per-section colors / fonts / text-decoration) + theme
      // updates (primary/accent palette, showBrandBadge, etc.) — without it,
      // those merchant tweaks didn't show until Save committed them. The
      // storefront applies the draft through resolveLayoutSettings which
      // tolerates malformed input gracefully; stricter validation would slow
      // the iteration loop.
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: 'Preview payload required' },
        });
        return;
      }
      // Heuristic: a bundle has at least one of layout/typography/theme keys.
      // A bare layout has the section keys directly (hero, categories, ...).
      // Detect bundle by presence of any of the 3 known top-level keys.
      const isBundle = 'layout' in body || 'typography' in body || 'theme' in body;
      const bundle = isBundle ? body : { layout: body, typography: undefined, theme: undefined };
      if (!bundle.layout || typeof bundle.layout !== 'object') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: 'Layout payload required' },
        });
        return;
      }
      // crypto.randomBytes, not Math.random: the read path
      // (public-store-layout.routes.ts) is unauthenticated, and the previous
      // Date.now()+Math.random() token carried roughly 41 bits — brute-forceable
      // within the 1h TTL. The Redis key is storeId-scoped so a guessed token
      // never crosses tenants, but it did expose that store's unsaved draft.
      const token = randomBytes(24).toString('base64url');
      // Redis key includes storeId so a cross-tenant token paste can't leak.
      await redis.set(`layout-preview:${storeId}:${token}`, bundle, 3600);
      res.json({ success: true, data: { token } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
