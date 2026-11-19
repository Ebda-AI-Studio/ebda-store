import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { plannedRateLimit } from './security';

/** 30 lookups a minute per client IP on the order-status link (Ruling WA-COD-V2-2): a person opens it a few times, a token guesser is cut off. Skipped under vitest like the other limiters (a test that needs a 429 passes `skip: () => false`). */
export function orderStatusLimiter(skip?: (req: Request) => boolean) {
  // PERF-BATCH-1: planned, so the request-level prefetch can send this hit in the request's one batched AuthState call (same store name, window, key and skip).
  return plannedRateLimit('order-status-link', {
    windowMs: 60 * 1000,
    max: 30,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: skip ?? (() => process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'),
    keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
  });
}
