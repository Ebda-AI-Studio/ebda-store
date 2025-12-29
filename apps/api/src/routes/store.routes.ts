import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth';
import { StoreService } from '../services/store.service';

const router = Router();

// Validation schemas
const createStoreSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  domain: z.string().optional(),
  settings: z.record(z.any()).optional(),
});

const updateStoreSchema = createStoreSchema.partial();

// GET /stores - List stores (admin)
router.get('/', authenticate, authorize('admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = req.query;

    const result = await StoreService.list({
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /stores/:id - Get store by ID
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
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
});

// GET /stores/:id/stats - Get store stats
router.get('/:id/stats', authenticate, async (req: Request, res: Response, next: NextFunction) => {
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
});

// POST /stores - Create store (admin only)
router.post('/', authenticate, authorize('admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createStoreSchema.parse(req.body);

    const store = await StoreService.create(req.user!.userId, data);

    res.status(201).json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /stores/:id - Update store (admin only)
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const data = updateStoreSchema.parse(req.body);

    const store = await StoreService.update(id, data);

    res.json({
      success: true,
      data: { store },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /stores/:id - Delete store
router.delete('/:id', authenticate, authorize('super_admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await StoreService.delete(id);

    res.json({
      success: true,
      data: { message: 'Store deleted successfully' },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
