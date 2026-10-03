/**
 * POST /api/v1/webhooks/billing/:provider — subscription-billing webhooks (SP5 task 3).
 *
 * Mounted in index.ts BEFORE the JSON body parser with `express.raw`, so the
 * signature is verified over the exact bytes the gateway signed. Order of
 * operations: verify -> dedupe (provider event id, UNIQUE) -> settle, all
 * inside one DB transaction in the service. Answers:
 *   401 bad/missing signature (nothing is parsed or stored)
 *   200 processed OR a replay (`duplicate: true`) OR ignored event/order
 *   500 processing failed -> the gateway retries, and nothing was marked seen
 */
import { Router, Request, Response, NextFunction } from 'express';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { BillingSignatureError } from '../services/billing';
import { handleBillingWebhook } from '../services/billing/subscription-billing.service';

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
    next(err);
  }
});

export default router;
