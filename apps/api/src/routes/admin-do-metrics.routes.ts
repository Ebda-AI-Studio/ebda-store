import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod/v3';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { auditLog, makeRateLimitStore, rateLimitRedisClient } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { parseInput } from '../lib/parse-input';
import { ALL_METRIC_NAMES, doMetricsEnabled, readMetric } from '../lib/do-metrics-hub';

/**
 * Operator metrics over every store's Durable Object (Ruling DO-METRICS-1, option A).
 *   GET /admin/do-metrics?names=a,b   NUMBERS only: per metric a total and a count per store that has a non-zero value
 * super_admin + MFA only; read-only and count-only by construction (the SQL is a constant allow-list in the DO, a caller sends a NAME);
 * 10 calls per minute per user; an audit row per call; kill switch DO_METRICS_ENABLED=false.
 */
const superAdmin = [authenticate, requireMfaEnrolled, authorize('super_admin')];

export const doMetricsLimiter = rateLimit({
  store: makeRateLimitStore(rateLimitRedisClient, 'do-metrics'),
  windowMs: 60_000,
  max: 10,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many metric reads, wait a minute.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: req => `do-metrics-${req.user?.userId ?? 'anon'}`,
});

const query = z.object({
  names: z
    .string()
    .max(500)
    .optional()
    .transform(v =>
      v
        ? v
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : ALL_METRIC_NAMES
    )
    .refine(
      a =>
        a.length > 0 &&
        a.length <= ALL_METRIC_NAMES.length &&
        a.every(n => ALL_METRIC_NAMES.includes(n)),
      'unknown metric'
    ),
});

export const adminDoMetricsRoutes = Router();

adminDoMetricsRoutes.get(
  '/do-metrics',
  ...superAdmin,
  doMetricsLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!doMetricsEnabled())
        throw new AppError(
          503,
          'do_metrics_disabled',
          'DO metrics are switched off (DO_METRICS_ENABLED=false)'
        );
      const { names } = parseInput(query, req.query);
      const metrics = [];
      for (const name of [...new Set(names)]) metrics.push(await readMetric(name));
      await auditLog({
        action: 'do_metrics.read',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: 'do-metrics',
        details: { names },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ success: true, data: { metrics } });
    } catch (error) {
      next(error);
    }
  }
);
