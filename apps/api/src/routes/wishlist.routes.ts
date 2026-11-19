import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { prisma } from '@ebda/database';
import { authenticate, customerUserId } from '../middleware/auth';
import { userContext } from '../middleware/tenant-context';

import { LISTING_SWATCH_OPTIONS_SELECT } from '../lib/listing-swatch-select';
import { WISHLIST_CARD_VARIANTS_SELECT, wishlistCardProduct } from '../lib/wishlist-card';
import { gateBackorderPayload } from '../lib/effective-inventory';
import { featureService } from '../services/feature.service';
const router = Router();

/**
 * The wishlist client of the request's store (NEON-ZERO-1 N-3): a Durable Object store's wishlist lives in its DO, a Postgres
 * store's is the unchanged `prisma` proxy. The store comes from the `x-store-id` header; the two delete routes the storefront
 * can call without it (known gap above) stay on Postgres, as before.
 */
async function wishlistDb(req: Request) {
  const id = getStoreIdFromHeader(req);
  return (id ? await storeWriter(id) : prisma) as unknown as typeof prisma;
}

// Helper to get store ID from request header
function getStoreIdFromHeader(req: Request): string | null {
  return (req.headers['x-store-id'] as string) || null;
}

// RLS cutover Phase 1c (docs/plans/done/2026-07-02-rls-cutover.md) — this router
// is mounted BARE at `/wishlist` (routes/index.ts) with no `:storeId` in its
// mount path — wishlist's store comes from the `x-store-id` HEADER, not the
// URL — so `tenantContext` could never reach it. `wishlists` /
// `wishlist_items` already carry a STORE-scoped RLS policy (from
// 20260404000000_add_rls_policies / 20260609000000_complete_force_rls_coverage
// — `store_id = current_store_id()`, allow-contextless), but nothing ever
// set `app.current_store_id` for this router's traffic, so that policy has
// been fail-open (no DB backstop) for every wishlist request.
//
// `router.use(authenticate)` + `router.use(userContext(...))` replace the
// per-route `authenticate` middleware below (every route already required it
// individually — behavior-neutral hoist). `userContext` is passed
// `customerUserId`, NOT a bare `req.user?.userId` — see the comment below on
// why every wishlist handler uses that resolver — plus `getStoreIdFromHeader`
// so `app.current_store_id` (the field the existing policies actually check)
// gets set from the same header the handlers already read, alongside
// `app.current_user_id` for defense-in-depth against any future user-scoped
// policy on these tables. INERT today (bypass role skips every policy);
// wraps handlers in the same interactive-tx pattern already used by
// `tenantContext`-wrapped routers.
//
// Known gap (not a regression): the two routes below that don't read the
// `x-store-id` header (`DELETE /product/:productId`, `DELETE /:itemId`)
// still get `app.current_user_id` set, but no store context — same
// allow-contextless fail-open as today for just those two calls. Tightening
// that needs the frontend to always send the header on those calls too
// (follow-up, out of scope here).
router.use(authenticate);
router.use(userContext(customerUserId, req => getStoreIdFromHeader(req)));

// Get user's wishlist items
//
// All handlers in this file use customerUserId(req) instead of req.user?.userId
// because the API cookie space is shared between admin and storefront. Reading
// req.user?.userId verbatim would let a logged-in merchant write into a
// wishlist row keyed on their userId — the next customer who happens to share
// that userId on the storefront would then see the merchant's wishlist. The
// helper returns undefined for any non-customer role, which we 401 here.
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = customerUserId(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const storeId = getStoreIdFromHeader(req);
    if (!storeId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_STORE', message: 'Store ID is required' },
      });
      return;
    }

    // Find or create default wishlist for user in this store
    let wishlist = await (
      await wishlistDb(req)
    ).wishlist.findFirst({
      where: { userId, storeId },
      include: {
        items: {
          // B2B-7b: a product made wholesale-only after it was wishlisted drops out of the anonymous-storefront view
          where: { product: { audience: 'public' } },
          include: {
            product: {
              include: {
                images: {
                  orderBy: { position: 'asc' },
                  take: 1,
                },
                // Colour dots on the wishlist cards (same payload as the listing).
                options: LISTING_SWATCH_OPTIONS_SELECT,
                // Card CTA: "choose options" vs quick-add vs sold-out (C-01).
                variants: WISHLIST_CARD_VARIANTS_SELECT,
              },
            },
          },
        },
      },
    });

    if (!wishlist) {
      wishlist = await (
        await wishlistDb(req)
      ).wishlist.create({
        data: { userId, storeId },
        include: {
          items: {
            // B2B-7b: a product made wholesale-only after it was wishlisted drops out of the anonymous-storefront view
            where: { product: { audience: 'public' } },
            include: {
              product: {
                include: {
                  images: {
                    orderBy: { position: 'asc' },
                    take: 1,
                  },
                  options: LISTING_SWATCH_OPTIONS_SELECT,
                  variants: WISHLIST_CARD_VARIANTS_SELECT,
                },
              },
            },
          },
        },
      });
    }

    const items = wishlist.items.map(item => ({
      id: item.id,
      product: wishlistCardProduct(item.product),
    }));

    const backorderOn = await featureService.isFeatureEnabled(storeId, 'inventory.backorder');
    res.json({
      success: true,
      data: { items: gateBackorderPayload(items, backorderOn), isPublic: wishlist.isPublic },
    });
  } catch (error) {
    next(error);
  }
});

// Add item to wishlist
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = customerUserId(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const storeId = getStoreIdFromHeader(req);
    if (!storeId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_STORE', message: 'Store ID is required' },
      });
      return;
    }

    const parsed = z.object({ productId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Product ID is required' },
      });
      return;
    }
    const { productId } = parsed.data;

    // Verify product exists and belongs to this store
    const product = await (
      await storeDb(storeId)
    ).product.findFirst({
      // B2B-7b: a wholesale-only product cannot be wishlisted from the anonymous storefront (404, no existence oracle)
      where: { id: productId, storeId, audience: 'public' },
    });

    if (!product) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' },
      });
      return;
    }

    // Find or create default wishlist for user in this store
    let wishlist = await (
      await wishlistDb(req)
    ).wishlist.findFirst({
      where: { userId, storeId },
    });

    if (!wishlist) {
      wishlist = await (
        await wishlistDb(req)
      ).wishlist.create({
        data: { userId, storeId },
      });
    }

    // Check if item already in wishlist
    const existingItem = await (
      await wishlistDb(req)
    ).wishlistItem.findFirst({
      where: {
        wishlistId: wishlist.id,
        productId,
      },
    });

    if (existingItem) {
      res.status(400).json({
        success: false,
        error: { code: 'DUPLICATE', message: 'Product already in wishlist' },
      });
      return;
    }

    // Add item to wishlist
    const item = await (
      await wishlistDb(req)
    ).wishlistItem.create({
      data: {
        wishlistId: wishlist.id,
        productId,
      },
      include: {
        product: {
          include: {
            images: {
              orderBy: { position: 'asc' },
              take: 1,
            },
            options: LISTING_SWATCH_OPTIONS_SELECT,
            variants: WISHLIST_CARD_VARIANTS_SELECT,
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      data: {
        item: {
          id: item.id,
          product: gateBackorderPayload(
            wishlistCardProduct(item.product),
            await featureService.isFeatureEnabled(storeId, 'inventory.backorder')
          ),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Remove item from wishlist
// DELETE /product/:productId — remove by product id (PDP toggle only knows the
// productId, not the wishlist-item id). Idempotent: deletes any of the user's
// wishlist items for this product. Defined before /:itemId (different segment
// count, but explicit ordering avoids ambiguity).
router.delete('/product/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = customerUserId(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }
    const { productId } = req.params;
    await (
      await wishlistDb(req)
    ).wishlistItem.deleteMany({
      where: { productId, wishlist: { userId } },
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/:itemId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = customerUserId(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { itemId } = req.params;

    // Find the item and verify ownership
    const item = await (
      await wishlistDb(req)
    ).wishlistItem.findUnique({
      where: { id: itemId },
      include: {
        wishlist: true,
      },
    });

    if (!item) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Wishlist item not found' },
      });
      return;
    }

    if (item.wishlist.userId !== userId) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized to remove this item' },
      });
      return;
    }

    // Delete the item
    await (
      await wishlistDb(req)
    ).wishlistItem.delete({
      where: { id: itemId },
    });

    res.json({
      success: true,
      message: 'Item removed from wishlist',
    });
  } catch (error) {
    next(error);
  }
});

// Toggle wishlist visibility (public/private)
router.put('/visibility', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = customerUserId(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const storeId = getStoreIdFromHeader(req);
    if (!storeId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_STORE', message: 'Store ID is required' },
      });
      return;
    }

    const parsedBody = z.object({ isPublic: z.boolean() }).safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'isPublic must be a boolean' },
      });
      return;
    }
    const { isPublic } = parsedBody.data;

    // Find or create the wishlist and update visibility
    let wishlist = await (
      await wishlistDb(req)
    ).wishlist.findFirst({
      where: { userId, storeId },
    });

    if (!wishlist) {
      wishlist = await (
        await wishlistDb(req)
      ).wishlist.create({
        data: { userId, storeId, isPublic },
      });
    } else {
      wishlist = await (
        await wishlistDb(req)
      ).wishlist.update({
        where: { id: wishlist.id, storeId },
        data: { isPublic },
      });
    }

    res.json({
      success: true,
      data: { isPublic: wishlist.isPublic },
    });
  } catch (error) {
    next(error);
  }
});

// Clear all items from wishlist
router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = customerUserId(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const storeId = getStoreIdFromHeader(req);
    if (!storeId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_STORE', message: 'Store ID is required' },
      });
      return;
    }

    const wishlist = await (
      await wishlistDb(req)
    ).wishlist.findFirst({
      where: { userId, storeId },
    });

    if (wishlist) {
      await (
        await wishlistDb(req)
      ).wishlistItem.deleteMany({
        where: { wishlistId: wishlist.id },
      });
    }

    res.json({
      success: true,
      message: 'Wishlist cleared',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
