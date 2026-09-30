/**
 * issue 2314 — the dedicated /api/v1/inngest bucket counts only CALLER-fault
 * answers. It used to count every answer ≥400, so during an incident the 5xx
 * from genuinely failing steps (Inngest retries them, from one small shared IP
 * pool) filled the bucket, and the limiter's own 429s kept it full: healthy
 * signed callbacks were refused for the rest of the window.
 *
 * Driven through the real express-rate-limit with the production predicate.
 * (`inngestLimiter` itself is skipped under tests via skipForLoadTestOrTests.)
 * Mutation-proof: returning `statusCode < 400` from the predicate (the old
 * behaviour) reddens "a burst of 5xx never locks out signed traffic".
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { inngestRequestWasSuccessful } from '@api/middleware/security';

function appWith(max: number) {
  const app = express();
  app.use(
    rateLimit({
      windowMs: 60_000,
      max,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => inngestRequestWasSuccessful(res.statusCode),
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  app.post('/status/:code', (req, res) => res.status(Number(req.params.code)).end());
  return app;
}

describe('inngestLimiter predicate (issue 2314)', () => {
  it.each([
    [200, true],
    [206, true],
    [500, true],
    [503, true],
    [429, true],
    [401, false],
    [400, false],
    [405, false],
    [413, false],
  ])('status %i counts as success=%s', (code, ok) => {
    expect(inngestRequestWasSuccessful(code)).toBe(ok);
  });

  it('a burst of 5xx never locks out signed traffic', async () => {
    const app = appWith(3);
    for (let i = 0; i < 10; i++) await request(app).post('/status/500').expect(500);
    await request(app).post('/status/200').expect(200);
  });

  it('forged (401) traffic is still capped', async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) await request(app).post('/status/401').expect(401);
    await request(app).post('/status/200').expect(429);
  });
});
