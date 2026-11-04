/**
 * POST /api/v1/webhooks/billing/:provider — subscription-billing webhooks (SP5 task 3).
 *
 * Mounted in index.ts BEFORE the JSON body parser with `express.raw`, so the
 * signature is verified over the exact bytes the gateway signed. Order of
 * operations: verify -> dedupe (provider event id, UNIQUE) -> settle, all
 * inside one DB transaction in the service. Answers:
 *   401 bad/missing signature (nothing is parsed or stored)
 *   404 a provider this deployment does not serve
 *   503 BILLING_NOT_CONFIGURED (billing not set up here), WEBHOOK_UNCONFIRMED (the gateway could
 *       not confirm it yet) or BILLING_WEBHOOK_FAILED (processing failed): the gateway retries,
 *       and nothing was marked seen. Never a 500 (Ruling PROVIDERS-20).
 *   200 processed OR a replay (`duplicate: true`) OR ignored event/order
 */
import { Router, Request, Response, NextFunction } from 'express';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { BillingSignatureError } from '../services/billing';
import { handleBillingWebhook } from '../services/billing/subscription-billing.service';
import { AppError } from '../middleware/error-handler';

const router = Router();

/**
 * BE:S-19: a bad signature is unauthenticated input, and each one used to insert an audit row. The log line stays on every
 * request; the audit row is written for at most BAD_SIG_AUDIT_PER_WINDOW per source per minute (per isolate), so a flood cannot
 * grow `audit_logs`. Cost if wrong: a burst beyond the cap shows in the log line but not as audit rows.
 */
const BAD_SIG_AUDIT_PER_WINDOW = 5;
const BAD_SIG_WINDOW_MS = 60_000;
const badSigSeen = new Map<string, { windowStart: number; count: number }>();
export function allowBadSignatureAudit(source: string, now: number = Date.now()): boolean {
  if (badSigSeen.size > 5_000) badSigSeen.clear(); // bounded memory under a spray of sources
  const e = badSigSeen.get(source);
  if (!e || now - e.windowStart >= BAD_SIG_WINDOW_MS) {
    badSigSeen.set(source, { windowStart: now, count: 1 });
    return true;
  }
  e.count += 1;
  return e.count <= BAD_SIG_AUDIT_PER_WINDOW;
}

router.post('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
  try {
    const result = await handleBillingWebhook(req.params.provider, raw, req.headers);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof BillingSignatureError) {
      logger.warn({ provider: req.params.provider, ip: req.ip }, '[billing-webhook] bad signature');
      if (allowBadSignatureAudit(req.ip ?? 'unknown')) {
        void auditLog({
          action: 'BILLING_WEBHOOK_BAD_SIGNATURE',
          resourceType: 'billing',
          details: { provider: req.params.provider },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }
      res.status(401).json({
        success: false,
        error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' },
      });
      return;
    }
    if (err instanceof AppError) {
      next(err);
      return;
    }
    // A failure inside processing (DB, effects): retriable, logged in full, never a bare 500.
    logger.error({ err, provider: req.params.provider }, '[billing-webhook] processing failed');
    next(new AppError(503, 'BILLING_WEBHOOK_FAILED', 'Webhook not processed; retry later'));
  }
});

export default router;
