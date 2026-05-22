import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CartService } from '../services/cart.service';
import { customerUserId } from '../middleware/auth';

const router = Router({ mergeParams: true });

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
});

const bulkSyncSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1),
      })
    )
    .max(100),
});

const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0),
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

    const cart = await CartService.getOrCreate(storeId, sessionId, customerId);

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
      customerId
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

    const cart = await CartService.addItems(storeId, sessionId, data.items, customerId);

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
      customerId
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
router.delete('/items/:itemId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, itemId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);

    const cart = await CartService.removeItem(storeId, sessionId, itemId, customerId);

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /stores/:storeId/cart - Clear cart
router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = customerUserId(req);

    const cart = await CartService.clear(storeId, sessionId, customerId);

    res.json({
      success: true,
      data: { cart },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
