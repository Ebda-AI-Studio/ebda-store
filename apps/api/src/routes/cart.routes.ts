import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { CartService } from '../services/cart.service';
import { customerUserId } from '../middleware/auth';
import { requireCustomerStoreMatch } from '../middleware/customer-store-match';
import { buyerFromRequest } from '../lib/buyer-identity';
import { setBuyerPrivate } from '../lib/edge-cache';
import { requireFeature } from '../middleware/feature-gate';

const router = Router({ mergeParams: true });

// A customer token is bound to ONE store: it cannot create or read a cart under another store's URL (MAP-HIGH). Guests and
// staff pass through; today no cart handler mounts `authenticate`, so this is the guard for the day one does.
router.use(requireCustomerStoreMatch);

// Cart routes are mixed-audience: guests post with `x-session-id` only, while
// signed-in customers also have `req.user`. Pulling `req.user?.userId`
// directly would let an admin token (admin/storefront share API cookie space)
// claim a cart on behalf of an unrelated customerId. customerUserId() returns
// undefined for any non-customer role, downgrading those requests to the
// session-only path instead of attaching a stale userId to the cart.

// Validation schemas
const addToCartSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).default(1),
  variantId: z.string().uuid().optional(),
  // Personalisation text. 400 before cleaning; cleanNote caps the stored text at 200.
  note: z.string().max(400).optional(),
});

const bulkSyncSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1),
        variantId: z.string().uuid().optional(),
        note: z.string().max(400).optional(),
      })
    )
    .max(100),
});

const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0),
});

const addBundleToCartSchema = z.object({
  bundleId: z.string().uuid(),
  quantity: z.number().int().min(1).max(1000).default(1),
});

// Helper to get session ID
const getSessionId = (req: Request): string => {
  const sessionId = req.headers['x-session-id'] as string;
  if (!sessionId) {
    throw Object.assign(new Error('Session ID required'), { statusCode: 400 });
  }
  return sessionId;
};

// GET /stores/:storeId/cart - Get cart
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);

    setBuyerPrivate(res);
    const cart = await CartService.getOrCreate(
      storeId,
      sessionId,
      customerId,
      buyerFromRequest(req)
    );

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/cart/items - Add to cart
router.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);
    const data = addToCartSchema.parse(req.body);

    const cart = await CartService.addItem(
      storeId,
      sessionId,
      data.productId,
      data.quantity,
      customerId,
      data.variantId,
      data.note,
      buyerFromRequest(req)
    );

    res.status(201).json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/cart/sync — bulk merge guest cart into server cart
// post-login. Replaces the N-request `Promise.allSettled(addToCart)` loop with
// one round-trip + one transaction. Max 100 items per request.
router.post('/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);
    const data = bulkSyncSchema.parse(req.body);

    const cart = await CartService.addItems(
      storeId,
      sessionId,
      data.items,
      customerId,
      buyerFromRequest(req)
    );

    res.status(200).json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /stores/:storeId/cart/items/:itemId - Update cart item
router.put('/items/:itemId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, itemId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);
    const data = updateCartItemSchema.parse(req.body);

    const cart = await CartService.updateItem(
      storeId,
      sessionId,
      itemId,
      data.quantity,
      customerId,
      buyerFromRequest(req)
    );

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /stores/:storeId/cart/items/:itemId - Remove from cart
// POST /stores/:storeId/cart/acknowledge-prices - the shopper tapped "متابعة" on "السعر اتحدّث" (Ruling B5-17).
// The body is an EMPTY strict object: the new quote is the server's current price, never a client value.
router.post('/acknowledge-prices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const { storeId } = req.params;
    setBuyerPrivate(res);
    const result = await CartService.acknowledgePrices(
      storeId,
      getSessionId(req),
      customerUserId(req)
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.delete('/items/:itemId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, itemId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);

    const cart = await CartService.removeItem(
      storeId,
      sessionId,
      itemId,
      customerId,
      buyerFromRequest(req)
    );

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// POST /stores/:storeId/cart/bundles - Add a bundle to the cart
//
// Gated on the `bundles` feature (no plan baseline — super-admin
// StoreFeature override only), same as every bundle route in
// bundle.routes.ts. This is a guest-cart surface (no `authenticate`), so
// `requireFeature` runs on its own here rather than as part of an
// admin-only middleware chain — it resolves storeId from the route param
// and works for anonymous requests (see feature-gate.ts).
//
// A refusal for a business rule (bundle inactive/expired/sold out, or not
// enough component stock to make the requested quantity) is a flat
// `{ error: '<code>' }` 422 — deliberately NOT the generic AppError
// envelope (`{ success:false, error:{code,...} }`). This is its own
// convention, independent of bundle.routes.ts's admin-CRUD errors (which
// moved onto the standard AppError envelope in RULING T9-a) — the
// storefront cart is a different consumer with its own contract/tests
// (tests/integration/cart-bundles.test.ts), and this shape is unchanged. A
// genuine 404 (unknown bundle / wrong store) still flows through
// `resolveBundle` -> `next(error)` -> the normal error handler.
router.post(
  '/bundles',
  requireFeature('bundles'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const sessionId = getSessionId(req);
      const customerId = customerUserId(req);
      const data = addBundleToCartSchema.parse(req.body);

      const result = await CartService.addBundle(
        storeId,
        sessionId,
        data.bundleId,
        data.quantity,
        customerId,
        buyerFromRequest(req)
      );

      if (!result.ok) {
        res.status(422).json({ error: result.error });
        return;
      }

      res.status(201).json({
        success: true,
        data: { cart: result.cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/cart/bundles/:id - Remove a bundle from the cart
// `:id` is the CartBundle row id (mirrors `:itemId` on the item routes
// above being the CartItem row id, not the productId).
router.delete(
  '/bundles/:id',
  requireFeature('bundles'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const sessionId = getSessionId(req);
      const customerId = customerUserId(req);

      const cart = await CartService.removeBundle(
        storeId,
        sessionId,
        id,
        customerId,
        buyerFromRequest(req)
      );

      res.json({
        success: true,
        data: { cart },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/cart - Clear cart
router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);

    const cart = await CartService.clear(storeId, sessionId, customerId, buyerFromRequest(req));

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
