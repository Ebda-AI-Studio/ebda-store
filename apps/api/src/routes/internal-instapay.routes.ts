/**
 * POST /internal/instapay/auto-confirm/not-received - the brain's one-tap "not received" (Ruling INSTAPAY-AUTO-1, plan S7).
 *
 * Mounted in app.ts BEFORE the JSON parser with `express.raw`, so the HMAC is verified over the exact bytes the brain signed and BEFORE any
 * parsing effect. The signature direction is `revert` (a captured `notify` signature never verifies here). Answers:
 *   401 bad / missing / stale (+-5 min) signature (nothing parsed, nothing written)
 *   400 a body that is not { id: uuid, actor, tappedAt }
 *   404 unknown payment            409 NOT_AUTO_CONFIRMED (human-confirmed or still waiting)
 *   429 flood (per IP and global; the brain retries)
 *   200 { result: 'reverted' | 'already_reverted' }  - a replay of a valid tap is a 200 `already_reverted`, never a second revert.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod/v3';
import { verifyBridge } from '@ebda/shared';
import logger from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import { internalBridgeLimiter } from '../middleware/security';
import { revertAutoConfirmed } from '../services/billing/instapay-auto-confirm.service';

const router = Router();

const PER_IP = 20;
const GLOBAL = 120;
const WINDOW_MS = 60_000;
const hits = new Map<string, { start: number; n: number }>();
/** per-isolate flood guard: a signed tap is rare (one per payment per day); anything beyond this is noise or an attack. */
// pq-allow(unused-export): the flood guard is reset by its unit test
export function allowInternalCall(key: string, limit: number, now: number = Date.now()): boolean {
  if (hits.size > 5_000) hits.clear();
  const e = hits.get(key);
  if (!e || now - e.start >= WINDOW_MS) {
    hits.set(key, { start: now, n: 1 });
    return true;
  }
  e.n += 1;
  return e.n <= limit;
}

const body = z.object({
  id: z.string().uuid(),
  actor: z.string().trim().min(1).max(60),
  tappedAt: z.number().finite(),
});

router.post(
  '/auto-confirm/not-received',
  internalBridgeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        !allowInternalCall(`ip:${req.ip ?? 'unknown'}`, PER_IP) ||
        !allowInternalCall('global', GLOBAL)
      ) {
        res
          .status(429)
          .json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      const ts = Number(req.header('X-Bridge-Ts'));
      const sig = req.header('X-Bridge-Sig') ?? '';
      const ok = await verifyBridge(
        process.env.INSTAPAY_BRIDGE_SECRET ?? '',
        raw,
        ts,
        sig,
        Date.now(),
        'revert'
      );
      if (!ok) {
        logger.warn('[instapay-auto] not-received call with a bad signature'); // no caller IP in logs (review M7)
        res.status(401).json({
          success: false,
          error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' },
        });
        return;
      }
      let parsed;
      try {
        parsed = body.parse(JSON.parse(raw));
      } catch {
        res.status(400).json({
          success: false,
          error: { code: 'BAD_BODY', message: 'id, actor and tappedAt are required' },
        });
        return;
      }
      // the actor on the audit trail is what the SIGNED body says it is (the brain only ever sends its authenticated owner)
      const out = await revertAutoConfirmed({
        id: parsed.id,
        actor: parsed.actor,
        reason: 'not received (one tap from the daily digest)',
      });
      res.status(200).json({ success: true, result: out.result, graceUntil: out.graceUntil });
    } catch (err) {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({
          success: false,
          code: err.code,
          error: { code: err.code, message: err.message },
        });
        return;
      }
      next(err);
    }
  }
);

export default router;
