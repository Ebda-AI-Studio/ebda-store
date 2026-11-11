/**
 * Rate-limiter failure posture (adversarial audit P2, Task 12).
 *
 * Every limiter uses a Redis-backed store (makeRateLimitStore) and
 * express-rate-limit v8 defaults `passOnStoreError` to FALSE — so a Redis
 * blip (store.increment rejects once ioredis exhausts its retries) rethrew
 * and 500'd EVERY rate-limited route: auth, public reads, cart, payments,
 * uploads, AI. Redis was a single point of failure for the whole write
 * surface, while the cache layer deliberately fails open.
 *
 * DELIBERATE TRADEOFF under test: fail-OPEN (availability over strict
 * limiting during a Redis outage) — `passOnStoreError: true` on every
 * limiter, matching the cache posture.
 *
 * Two layers:
 *  1. behavioral — the exact posture we ship (Redis store + passOnStoreError)
 *     serves the request when the store errors, and the v8 default (control)
 *     500s, pinning the library semantics this fix relies on;
 *  2. source gate — every `rateLimit({` config in security.ts and app.ts
 *     carries `passOnStoreError: true`, so a future limiter cannot silently
 *     regress to fail-closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { makeRateLimitStore } from '@api/middleware/security';

const SIMULATED_OUTAGE = 'Connection is closed.';

const failingRedisClient = {
  call: () => Promise.reject(new Error(SIMULATED_OUTAGE)),
};

/**
 * `rate-limit-redis` calls `loadIncrementScript()` from its own constructor and
 * never attaches a handler to the result, so simulating a dead Redis leaks an
 * unhandled rejection from inside the library — one vitest reports as an error
 * even though every assertion passes, which is enough to fail the pre-push gate.
 *
 * Swallow ONLY the simulated outage and re-throw anything else, so this cannot
 * quietly absorb a real failure introduced later.
 */
function ignoreSimulatedOutage(reason: unknown) {
  if (reason instanceof Error && reason.message === SIMULATED_OUTAGE) return;
  throw reason;
}

beforeAll(() => process.on('unhandledRejection', ignoreSimulatedOutage));
afterAll(() => void process.off('unhandledRejection', ignoreSimulatedOutage));

function appWith(limiter: ReturnType<typeof rateLimit>) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  // Mirror the API's error handler shape: unhandled limiter errors -> 500.
  app.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ ok: false });
    }
  );
  return app;
}

describe('rate-limiter failure posture — fail-open on store error', () => {
  it('a limiter with passOnStoreError serves the request when the Redis store errors', async () => {
    const limiter = rateLimit({
      windowMs: 60_000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeRateLimitStore(failingRedisClient, 'test-fail-open'),
      passOnStoreError: true,
    });
    const res = await request(appWith(limiter)).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('control: the v8 default (fail-closed) 500s the same request — the posture must be explicit', async () => {
    const limiter = rateLimit({
      windowMs: 60_000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeRateLimitStore(failingRedisClient, 'test-fail-closed'),
    });
    const res = await request(appWith(limiter)).get('/ping');
    expect(res.status).toBe(500);
  });

  it('every rateLimit() / plannedRateLimit() config in security.ts and app.ts declares passOnStoreError: true', () => {
    for (const rel of ['apps/api/src/middleware/security.ts', 'apps/api/src/app.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      // Each `rateLimit({ ... })` block must contain the posture flag. Blocks
      // are delimited well enough by the next `});` at the call's nesting —
      // count occurrences instead of parsing: one flag per config.
      // PERF-BATCH-1: `plannedRateLimit('<name>', { ... })` configs count too; the helper's own
      // `rateLimit({ ...options, ... })` forwards the caller's config and is not one.
      const configs =
        (src.match(/rateLimit\(\{(?! \.\.\.options)/g)?.length ?? 0) +
        (src.match(/plannedRateLimit\(['`]/g)?.length ?? 0);
      const flags = src.match(/passOnStoreError: true/g)?.length ?? 0;
      expect(
        flags,
        `${rel}: every rateLimit({ config needs passOnStoreError: true (found ${flags}/${configs})`
      ).toBeGreaterThanOrEqual(configs);
      expect(configs).toBeGreaterThan(0);
    }
  });
});
