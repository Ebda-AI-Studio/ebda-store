/**
 * Operator-only loader for the Phase 0 StoreDO spike (Ruling INFRA-CF-1).
 * Dead unless BOTH hold: the secret STORE_DO_SEED_TOKEN is set (wrangler secret) and the store id is in
 * the store's D1 backend flag. Otherwise every route answers 404, so the surface does not exist in production by default.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { backendFor, storeDo, unwrapDo } from '../lib/store-backend';
import { AppError } from '../middleware/error-handler';

const router = Router();

function tokenOk(req: Request): boolean {
  const secret = process.env.STORE_DO_SEED_TOKEN;
  if (!secret) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

router.use('/:storeId', async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    if (!process.env.STORE_DO_SEED_TOKEN || (await backendFor(storeId)) !== 'do')
      return next(new AppError(404, 'NOT_FOUND', 'Not found'));
    if (!tokenOk(req)) return next(new AppError(403, 'FORBIDDEN', 'Forbidden'));
    next();
  } catch (e) {
    next(e);
  }
});

router.post('/:storeId/seed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stub = storeDo(req.params.storeId);
    const data = unwrapDo(await stub.seed(req.body));
    await stub.ensureBackupAlarm(); // the nightly export is armed by the first load
    res.json({ success: true, data });
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

router.post('/:storeId/backup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: await storeDo(req.params.storeId).backupNow(req.params.storeId),
    });
  } catch (e) {
    next(e);
  }
});

// Restore drill: load a backup day into a FRESH Durable Object instance (never the live one) and report equality.
router.post('/:storeId/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;
    const day = String(req.body?.day ?? '');
    const run = String(req.body?.run ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[a-z0-9]{4,24}$/.test(run))
      throw new AppError(400, 'VALIDATION', 'day (YYYY-MM-DD) and run ([a-z0-9]{4,24}) required');
    const target = storeDo(storeId, `${storeId}-restore-${run}`);
    res.json({ success: true, data: unwrapDo(await target.restoreFrom(storeId, day)) });
  } catch (e) {
    next(e);
  }
});

router.get('/:storeId/bookmark', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: { bookmark: await storeDo(req.params.storeId).pitrBookmark() },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
