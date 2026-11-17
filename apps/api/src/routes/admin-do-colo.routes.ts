import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { AppError } from '../middleware/error-handler';
import { CACHEGEN_SHARD, authStateColos } from '../cf/auth-state-client';

/**
 * Placement echo (Ruling PERF-AUTHSTATE-1, MEASUREMENT only, off by default): `GET /admin/do-colo` answers where this Worker and a
 * sample of AuthState instances run (Cloudflare location codes) and the round-trip time of one empty call to each, so a
 * cross-continent Durable Object shows up as a fact. super_admin + MFA, gated by DO_COLO_ECHO=on (404 otherwise); numbers and
 * location codes only. Remove the flag value after the investigation.
 */
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

async function workerColo(): Promise<string | null> {
  try {
    const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(2_000),
    });
    return /^colo=([A-Z]{3})$/m.exec(await r.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

export const adminDoColoRoutes = Router();

adminDoColoRoutes.get(
  '/do-colo',
  ...superAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.DO_COLO_ECHO !== 'on') throw new AppError(404, 'not_found', 'not found');
      // the 32 auth/limiter shards, the global cachegen instance and four of the 64 per-store cachegen shards
      const shards = [
        ...Array.from({ length: 32 }, (_, i) => i),
        CACHEGEN_SHARD,
        CACHEGEN_SHARD - 1,
        CACHEGEN_SHARD - 2,
        CACHEGEN_SHARD - 3,
        CACHEGEN_SHARD - 4,
      ];
      const [worker, instances] = await Promise.all([workerColo(), authStateColos(shards)]);
      res.json({ success: true, data: { worker, instances } });
    } catch (error) {
      next(error);
    }
  }
);
