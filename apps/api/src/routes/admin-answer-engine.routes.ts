import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { auditLog } from '../middleware/security';
import {
  getProviderConfigs,
  upsertProviderConfig,
  isPaidAnswerEngine,
} from '../services/answer-engine/config.service';

/**
 * Super-admin answer-engine provider config routes (Task 5).
 *
 * Mounted at `/admin` in routes/index.ts, giving:
 *   GET /admin/answer-engine/providers
 *   PUT /admin/answer-engine/providers/:engine
 *
 * `AnswerEngineProviderConfig` is a platform-level table (no store_id, no
 * RLS). This is the ONLY route on the platform that writes a secret
 * (Perplexity/OpenAI API key) at super_admin tier, so it enforces the same
 * chain as the other MFA-gated super_admin routers (feature.routes.ts,
 * insights.routes.ts): `authenticate → requireMfaEnrolled → requireRole(['super_admin'])`
 * on every route. It stays mounted before admin.routes.ts (see routes/index.ts)
 * for reachability, but is self-contained on MFA regardless of mount order.
 */

const router = Router();

router.use(authenticate);

const engineParamSchema = z.enum(['perplexity', 'openai']);

const upsertBodySchema = z.object({
  apiKey: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});

/**
 * GET /admin/answer-engine/providers
 * List perplexity + openai configs, masked. Never returns plaintext or the
 * encrypted blob.
 */
router.get(
  '/answer-engine/providers',
  requireMfaEnrolled,
  requireRole(['super_admin']),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const configs = await getProviderConfigs();
      res.json({ success: true, data: { configs } });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /admin/answer-engine/providers/:engine
 * Upsert a single engine's enabled toggle and/or API key. A key containing
 * the `****` mask sentinel is treated as "unchanged" — the stored secret is
 * never overwritten with mask text.
 */
router.put(
  '/answer-engine/providers/:engine',
  requireMfaEnrolled,
  requireRole(['super_admin']),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const engineParse = engineParamSchema.safeParse(req.params.engine);
      if (!engineParse.success) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_ENGINE',
            message: `Unsupported answer-engine provider: ${req.params.engine}`,
          },
        });
        return;
      }
      const engine = engineParse.data;
      if (!isPaidAnswerEngine(engine)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_ENGINE',
            message: `Unsupported answer-engine provider: ${engine}`,
          },
        });
        return;
      }

      const body = upsertBodySchema.parse(req.body);
      const config = await upsertProviderConfig(engine, body);

      // Audit the toggle/key change WITHOUT ever logging the key itself —
      // only whether a key was supplied and the resulting enabled state.
      await auditLog({
        action: 'answer_engine_provider_config.updated',
        userId: req.user!.userId,
        resourceType: 'setting',
        resourceId: engine,
        details: {
          engine,
          enabled: config.enabled,
          keyChanged: body.apiKey !== undefined && !body.apiKey.includes('****'),
        },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({ success: true, data: { config } });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
