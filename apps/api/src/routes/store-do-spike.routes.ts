/**
 * Operator-only loader for the Phase 0 StoreDO spike (Ruling INFRA-CF-1).
 * Dead unless BOTH hold: the secret STORE_DO_SEED_TOKEN is set (wrangler secret) and the store id is in
 * STORE_DO_ENABLED_IDS. Otherwise every route answers 404, so the surface does not exist in production by default.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { enabledStoreIds, storeDo, unwrapDo } from '../lib/store-backend';
import { AppError } from '../middleware/error-handler';

const router = Router();

function tokenOk(req: Request): boolean {
  const secret = process.env.STORE_DO_SEED_TOKEN;
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

router.use('/:storeId', (req: Request, _res: Response, next: NextFunction) => {
  const { storeId } = req.params;
  if (!enabledStoreIds().has(storeId) || !process.env.STORE_DO_SEED_TOKEN)
    return next(new AppError(404, 'NOT_FOUND', 'Not found'));
  if (!tokenOk(req)) return next(new AppError(403, 'FORBIDDEN', 'Forbidden'));
  next();
});

router.post('/:storeId/seed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: unwrapDo(await storeDo(req.params.storeId).seed(req.body)) });
  } catch (e) {
    next(e);
  }
});

router.get('/:storeId/counts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await storeDo(req.params.storeId).rowCounts() });
  } catch (e) {
    next(e);
  }
});

export default router;
