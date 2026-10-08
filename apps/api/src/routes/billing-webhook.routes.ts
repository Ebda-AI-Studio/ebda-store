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

router.post('/:provider', async (req: Request, res: Response, next: NextFunction) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
  try {
    const result = await handleBillingWebhook(req.params.provider, raw, req.headers);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof BillingSignatureError) {
      logger.warn({ provider: req.params.provider, ip: req.ip }, '[billing-webhook] bad signature');
      auditLog({
        action: 'BILLING_WEBHOOK_BAD_SIGNATURE',
        resourceType: 'billing',
        details: { provider: req.params.provider },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
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
