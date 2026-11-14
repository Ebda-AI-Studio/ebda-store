import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { makeRateLimitStore, rateLimitRedisClient } from './security';

/**
 * "Test and turn on" budget (SELF-SERVICE gap A7): each preview calls the provider with the store's own
 * credentials and may spend one AI explanation, so it is limited per store + provider. super_admin (the
 * override) is not limited. Skipped under vitest like every limiter here (a test that needs a 429 builds the
 * limiter with `skip: () => false`). Redis failure fails OPEN (the provider's own rate limit is the backstop).
 */
// pq-allow(unused-export): test seam, imported by tests/unit/self-service-provider-activation.test.ts
export function createProviderActivationLimiter(opts?: {
  skip?: (req: Request) => boolean;
  max?: number;
}) {
  return rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'provider-activation-preview'),
    windowMs: 10 * 60 * 1000,
    max: opts?.max ?? 10,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many connection tests for this provider. Wait a few minutes and try again.',
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
    keyGenerator: (req: Request) =>
      `${req.params.storeId ?? 'nostore'}:${req.params.provider ?? 'none'}`,
  });
}

export const providerActivationLimiter = createProviderActivationLimiter();
