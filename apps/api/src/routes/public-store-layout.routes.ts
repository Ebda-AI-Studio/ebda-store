/**
 * Public read of a store's layout settings — used by the storefront's
 * <HomeComposition> to decide which sections to render and how. No auth
 * required; the data is layout-only (no PII), and it must load fast on
 * cold-cache page loads.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { resolveLayoutSettings } from '@force/shared';
import type { TemplateId } from '@force/shared';
import { redis } from '../services/redis.service';
import {
  getPublishedDefinition,
  getPreviewDefinition,
  previewTokenKey,
} from '../services/page-builder.service';

const router = Router();

router.get('/stores/:storeId/layout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    // Load store once (template + layoutSettings) so both the draft and
    // committed paths resolve against the store's template baseline without
    // a second round-trip.
    const store = await prisma.store.findFirst({
      where: { id: storeId, status: 'active' },
      select: { layoutSettings: true, template: true },
    });
    if (!store) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Store not found' },
      });
      return;
    }
    const templateId = store.template as TemplateId;

    // Real-time preview path (Ahmad 2026-05-20): when the merchant clicks
    // "Preview unsaved changes" in admin page-builder, the storefront iframe
    // reloads with ?_layoutDraft=<token>. We look up the token in Redis and
    // return the draft layout instead of the committed DB row. Tokens are
    // scoped to storeId so a leaked token can't preview another store.
    const draftToken =
      typeof req.query._layoutDraft === 'string' && req.query._layoutDraft.length > 0
        ? req.query._layoutDraft
        : null;
    if (draftToken) {
      const draft = await redis.get<unknown>(`layout-preview:${storeId}:${draftToken}`, true);
      if (draft) {
        // 2026-05-20: draft payload shape is now a bundle `{ layout,
        // typography?, theme? }` so the storefront can also preview global
        // typography zone edits + theme changes (palette, card-level flags).
        // Legacy clients that posted a bare layout get auto-wrapped server-
        // side; here we accept either shape for safety.
        const draftBundle =
          draft && typeof draft === 'object' && ('layout' in draft || 'typography' in draft)
            ? (draft as {
                layout?: unknown;
                typography?: unknown;
                theme?: unknown;
                settings?: unknown;
              })
            : { layout: draft, typography: undefined, theme: undefined, settings: undefined };
        const layout = resolveLayoutSettings(draftBundle.layout, templateId);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
          success: true,
          data: {
            layout,
            typography: draftBundle.typography,
            theme: draftBundle.theme,
            // settings carries navMenu / footerLinks / utilityBar from the
            // page-builder preview POST so the storefront can render nav/footer
            // changes before the merchant saves them. Only present on fresh
            // drafts that include the settings bundle (2026-06-17+).
            settings: draftBundle.settings,
            isDraft: true,
          },
        });
        return;
      }
      // Token expired or never existed — fall through to committed layout
      // so the preview at least shows the saved state rather than a 404.
    }

    const layout = resolveLayoutSettings(store.layoutSettings, templateId);
    // Visual builder (additive): the page document the storefront renders —
    // the PUBLISHED revision (never a draft) when it agrees with
    // layout_settings, else the layout-derived document — plus its rev for
    // provenance. `layout` is unchanged so a storefront/admin deploy that
    // predates the builder keeps working across the deploy gap.
    const { definition, rev } = await getPublishedDefinition(storeId, layout);
    // Cache lightly at the edge — layout settings change rarely
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    res.json({ success: true, data: { layout, definition, rev } });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /public/stores/:storeId/builder-preview?token=<t>
 * The visual builder canvas: the working DRAFT document for a valid,
 * store-scoped preview token (minted by the authenticated
 * `POST /admin/stores/:storeId/builder/pages/:pageKey/preview-token`).
 * Unknown/expired token -> 404, and never cacheable anywhere.
 */
router.get(
  '/stores/:storeId/builder-preview',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      const { storeId } = req.params;
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Preview not found' } });
        return;
      }
      const entry = await redis.get<{ pageKey?: string }>(previewTokenKey(storeId, token), true);
      if (!entry || typeof entry.pageKey !== 'string') {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Preview not found' } });
        return;
      }
      const doc = await getPreviewDefinition(storeId, entry.pageKey);
      if (!doc) {
        res
          .status(404)
          .json({ success: false, error: { code: 'NOT_FOUND', message: 'Store not found' } });
        return;
      }
      res.json({ success: true, data: doc });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /public/stores/:storeId/testimonials
 * Returns approved store-wide reviews suitable for the home page testimonial
 * row. Filters: minimum rating, optional verified-purchase only. Capped at
 * `limit` (default 6) and ordered by rating DESC, recent first.
 *
 * Empty result is valid — the storefront hides the section when no
 * qualifying reviews exist.
 */
router.get(
  '/stores/:storeId/testimonials',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const minRating = Math.max(
        1,
        Math.min(5, parseInt((req.query.minRating as string) || '4', 10))
      );
      const verifiedOnly = req.query.verifiedOnly === 'true';
      const limit = Math.max(1, Math.min(20, parseInt((req.query.limit as string) || '6', 10)));

      const reviews = await prisma.review.findMany({
        where: {
          storeId,
          status: 'published',
          rating: { gte: minRating },
          ...(verifiedOnly ? { verifiedPurchase: true } : {}),
        },
        include: {
          customer: {
            select: { firstName: true, lastName: true },
          },
        },
        orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      });

      const testimonials = reviews.map(r => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        comment: r.body,
        authorName: r.customer
          ? `${r.customer.firstName ?? ''} ${(r.customer.lastName ?? '').slice(0, 1).toUpperCase()}.`.trim()
          : 'Customer',
        authorCity: null as string | null,
        createdAt: r.createdAt.toISOString(),
      }));

      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
      res.json({ success: true, data: { testimonials } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
