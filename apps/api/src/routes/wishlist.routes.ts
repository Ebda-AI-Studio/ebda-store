import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@force/database';
import { authenticate, customerUserId } from '../middleware/auth';
import { userContext } from '../middleware/tenant-context';

const router = Router();

// Helper to get store ID from request header
function getStoreIdFromHeader(req: Request): string | null {
  return (req.headers['x-store-id'] as string) || null;
}

// RLS cutover Phase 1c (docs/plans/2026-07-02-rls-cutover.md) — this router
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
    let wishlist = await prisma.wishlist.findFirst({
      where: { userId, storeId },
      include: {
        items: {
          include: {
            product: {
              include: {
                images: {
                  orderBy: { position: 'asc' },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!wishlist) {
      wishlist = await prisma.wishlist.create({
        data: { userId, storeId },
        include: {
          items: {
            include: {
              product: {
                include: {
                  images: {
                    orderBy: { position: 'asc' },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });
    }

    const items = wishlist.items.map(item => ({
      id: item.id,
      product: {
        id: item.product.id,
        name: item.product.name,
        slug: item.product.slug,
        price: item.product.price / 1000, // Convert fils to KWD
        compareAtPrice: item.product.compareAtPrice
          ? item.product.compareAtPrice / 1000
          : undefined,
        images: item.product.images.map(img => img.url),
        status: item.product.status,
      },
    }));

    res.json({
      success: true,
      data: { items, isPublic: wishlist.isPublic },
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
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId },
    });

    if (!product) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' },
      });
      return;
    }

    // Find or create default wishlist for user in this store
    let wishlist = await prisma.wishlist.findFirst({
      where: { userId, storeId },
    });

    if (!wishlist) {
      wishlist = await prisma.wishlist.create({
        data: { userId, storeId },
      });
    }

    // Check if item already in wishlist
    const existingItem = await prisma.wishlistItem.findFirst({
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
    const item = await prisma.wishlistItem.create({
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
          },
        },
      },
    });

    res.status(201).json({
      success: true,
      data: {
        item: {
          id: item.id,
          product: {
            id: item.product.id,
            name: item.product.name,
            slug: item.product.slug,
            price: item.product.price / 1000,
            compareAtPrice: item.product.compareAtPrice
              ? item.product.compareAtPrice / 1000
              : undefined,
            images: item.product.images.map(img => img.url),
            status: item.product.status,
          },
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
    await prisma.wishlistItem.deleteMany({
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
    const item = await prisma.wishlistItem.findUnique({
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
    await prisma.wishlistItem.delete({
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

    const { isPublic } = req.body;
    if (typeof isPublic !== 'boolean') {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'isPublic must be a boolean' },
      });
      return;
    }

    // Find or create the wishlist and update visibility
    let wishlist = await prisma.wishlist.findFirst({
      where: { userId, storeId },
    });

    if (!wishlist) {
      wishlist = await prisma.wishlist.create({
        data: { userId, storeId, isPublic },
      });
    } else {
      wishlist = await prisma.wishlist.update({
        where: { id: wishlist.id },
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

    const wishlist = await prisma.wishlist.findFirst({
      where: { userId, storeId },
    });

    if (wishlist) {
      await prisma.wishlistItem.deleteMany({
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
