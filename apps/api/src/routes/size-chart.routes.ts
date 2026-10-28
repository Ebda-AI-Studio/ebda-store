import { Router, Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod/v3';
import { sizeChartSchema, type SizeChart } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { auditLog, writeLimiter } from '../middleware/security';
import { requireStoreAccess } from '../middleware/store-access';
import { SizeChartService } from '../services/size-chart.service';

/**
 * Size charts (B0 Task 9): /stores/:storeId/size-charts, mounted under `tenantContext` beside
 * the category routes. Same permission vocabulary as categories: reads for
 * store_admin/super_admin/staff, writes need `products:write` (store_admin, super_admin, staff).
 */
const router = Router({ mergeParams: true });

const idParam = z.string().uuid();

const readChain = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
] as const;

const writeChain = [
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requirePermission('products:write'),
  requireStoreAccess,
  writeLimiter,
] as const;

/**
 * `sizeChartSchema` lives in @ebda/shared. Where that package resolves `zod` to a different module
 * instance than this file (measured under vitest; tsx shares one), its ZodError fails the error
 * handler's `instanceof` check and a bad chart surfaced as a 500. Re-throwing the issues as this
 * module's ZodError makes it the standard 400 regardless of module resolution.
 */
function parseChart(body: unknown): SizeChart {
  const parsed = sizeChartSchema.safeParse(body);
  if (!parsed.success) throw new ZodError(parsed.error.issues as z.ZodIssue[]);
  return parsed.data;
}

function parseId(req: Request, res: Response): string | null {
  const parsed = idParam.safeParse(req.params.id);
  if (parsed.success) return parsed.data;
  res
    .status(404)
    .json({ success: false, error: { code: 'NOT_FOUND', message: 'Size chart not found' } });
  return null;
}

router.get('/', ...readChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const charts = await SizeChartService.list(req.params.storeId);
    res.json({ success: true, data: { sizeCharts: charts } });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', ...readChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseId(req, res);
    if (!id) return;
    const chart = await SizeChartService.get(req.params.storeId, id);
    res.json({ success: true, data: { sizeChart: chart } });
  } catch (error) {
    next(error);
  }
});

router.post('/', ...writeChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const data = parseChart(req.body);
    const chart = await SizeChartService.create(storeId, data);
    await auditLog({
      action: 'sizeChart.created',
      userId: req.user!.userId,
      resourceType: 'size_chart',
      resourceId: chart.id,
      details: { name: chart.name || chart.nameAr },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ success: true, data: chart });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', ...writeChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const id = parseId(req, res);
    if (!id) return;
    const data = parseChart(req.body);
    const chart = await SizeChartService.update(storeId, id, data);
    await auditLog({
      action: 'sizeChart.updated',
      userId: req.user!.userId,
      resourceType: 'size_chart',
      resourceId: id,
      details: { name: chart.name || chart.nameAr },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: chart });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', ...writeChain, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const id = parseId(req, res);
    if (!id) return;
    await SizeChartService.delete(storeId, id);
    await auditLog({
      action: 'sizeChart.deleted',
      userId: req.user!.userId,
      resourceType: 'size_chart',
      resourceId: id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ success: true, data: { id } });
  } catch (error) {
    next(error);
  }
});

export default router;
