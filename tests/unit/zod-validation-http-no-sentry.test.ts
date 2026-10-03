/**
 * FORCE-API-2C / 1B / 25 (issue 2472) — end to end through the real middleware
 * chain, in the production order (Sentry gate, then errorHandler): a ZodError
 * thrown by `schema.parse(req.body)` answers 400 with the standard error shape
 * and never reaches Sentry. The unit-level classifier is pinned in
 * error-status-parity.test.ts; this pins the chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

const captureException = vi.fn();
vi.mock('@sentry/node', () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  init: vi.fn(),
  setUser: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@sentry/profiling-node', () => ({ nodeProfilingIntegration: vi.fn() }));

import { errorHandler } from '../../apps/api/src/middleware/error-handler';
import { SentryService } from '../../apps/api/src/services/sentry.service';

// The three reported shapes: public.routes (orderId/productId/token required),
// auth.routes (storeId uuid), auth.routes (password regex).
const reviewSchema = z.object({ orderId: z.string(), productId: z.string(), token: z.string() });
const loginSchema = z.object({ storeId: z.string().uuid() });
const registerSchema = z.object({
  password: z.string().regex(/[A-Z]/, 'needs an uppercase letter'),
});

function app() {
  const a = express();
  a.use(express.json());
  a.post('/review', (req, _res, next) => {
    try {
      reviewSchema.parse(req.body);
    } catch (e) {
      next(e);
    }
  });
  a.post('/login', (req, _res, next) => {
    try {
      loginSchema.parse(req.body);
    } catch (e) {
      next(e);
    }
  });
  a.post('/register', (req, _res, next) => {
    try {
      registerSchema.parse(req.body);
    } catch (e) {
      next(e);
    }
  });
  a.get('/crash', (_req, _res, next) => next(new Error('real server fault')));
  a.use(SentryService.errorHandler());
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  captureException.mockClear();
  (SentryService as unknown as { isInitialized: boolean }).isInitialized = true;
});

describe('client validation errors: 400, standard shape, not reported', () => {
  it.each([
    ['/review', {}],
    ['/login', { storeId: 'not-a-uuid' }],
    ['/register', { password: 'lowercase' }],
  ])('%s', async (path, body) => {
    const res = await request(app()).post(path).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' },
    });
    expect(Object.keys(res.body.error.details).length).toBeGreaterThan(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('control: a real server fault IS reported (the gate is not simply off)', async () => {
    const res = await request(app()).get('/crash');
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
