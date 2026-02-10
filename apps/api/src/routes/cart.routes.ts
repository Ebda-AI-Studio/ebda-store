import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CartService } from '../services/cart.service';

const router = Router({ mergeParams: true });

// Validation schemas
const addToCartSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).default(1),
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
    const customerId = req.user?.userId;

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
    const customerId = req.user?.userId;
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

// PUT /stores/:storeId/cart/items/:itemId - Update cart item
router.put('/items/:itemId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId, itemId } = req.params;
    const sessionId = getSessionId(req);
    const customerId = req.user?.userId;
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
    const customerId = req.user?.userId;

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
    const customerId = req.user?.userId;

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
