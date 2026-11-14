import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { makeRateLimitStore, rateLimitRedisClient } from './security';

/**
 * "Scan now" budget (SELF-SERVICE gap A17): one on-demand stock scan per scan kind per store per hour.
 * A scan fans out over the whole catalogue, so the merchant button is rate limited; super_admin (the
 * override) is not. Skipped under vitest like every limiter here (a test that needs a 429 builds the
 * limiter with `skip: () => false`). Redis failure fails OPEN (the scan itself is idempotent per store).
 */
export function createScanNowLimiter(kind: string, opts?: { skip?: (req: Request) => boolean }) {
  return rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, `scan-now-${kind}`),
    windowMs: 60 * 60 * 1000,
    max: 1,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'This scan already ran in the last hour. Try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip:
      opts?.skip ??
      ((req: Request) =>
        process.env.NODE_ENV === 'test' ||
        process.env.VITEST === 'true' ||
        req.user?.role === 'super_admin'),
    keyGenerator: (req: Request) => String(req.params.storeId ?? 'nostore'),
  });
}
