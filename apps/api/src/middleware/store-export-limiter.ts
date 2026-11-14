import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { makeRateLimitStore, rateLimitRedisClient } from './security';

/**
 * Whole-store export budget (SELF-SERVICE gap A11): one export per store per hour. The bundle reads every table, so it is
 * rate limited per STORE (not per user: two staff cannot double it). Skipped under vitest like every limiter here; a test that
 * needs the 429 builds it with `skip: () => false`. Redis failure fails OPEN (the export is read-only and row-capped).
 */
export function createStoreExportLimiter(opts?: { skip?: (req: Request) => boolean }) {
  return rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'store-export'),
    windowMs: 60 * 60 * 1000,
    max: 1,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Your data export already ran in the last hour. Try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: opts?.skip ?? (() => process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'),
    keyGenerator: (req: Request) => String(req.params.storeId ?? 'nostore'),
  });
}
