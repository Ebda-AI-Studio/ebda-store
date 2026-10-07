/**
 * Bot Analytics Proxy Routes — Ebda ↔ WBS Bridge
 *
 * Proxies the bot conversion funnel analytics from WBS to the Ebda admin.
 * The admin frontend calls Ebda (same-origin JWT auth), Ebda decrypts the
 * store's wbsApiKey and forwards the request to WBS.
 *
 * Why proxy rather than calling WBS directly from the browser:
 *   - wbsApiKey is encrypted at rest and must never be sent to the browser
 *   - Security boundary: all WBS calls originate from Railway, not from
 *     the merchant's browser (prevents CSRF + key exfiltration)
 *
 * Route:
 *   GET /stores/:id/bot-analytics?from=<ISO>&to=<ISO>
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireFeature } from '../middleware/feature-gate';
import { encryption } from '../services/encryption.service';
import { config } from '../config';
import logger from '../lib/logger';

const router = Router({ mergeParams: true });

// ─── GET /stores/:id/bot-analytics ──────────────────────────────────────────

router.get(
  '/:id/bot-analytics',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  requireFeature('whatsapp'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id: storeId } = req.params;
      const { from, to } = req.query;

      // Fetch the store's WBS API key
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { wbsApiKey: true, wbsEnabled: true },
      });

      if (!store) {
        res.status(404).json({ success: false, error: { code: 'STORE_NOT_FOUND' } });
        return;
      }

      if (!store.wbsEnabled || !store.wbsApiKey) {
        res.status(400).json({
          success: false,
          error: { code: 'WBS_NOT_CONNECTED' },
          message: 'This store does not have a WBS integration configured.',
        });
        return;
      }

      // Decrypt the API key before forwarding
      let apiKey: string;
      try {
        apiKey = encryption.decrypt(store.wbsApiKey);
      } catch {
        res.status(500).json({
          success: false,
          error: { code: 'KEY_DECRYPT_FAILED' },
          message: 'Could not decrypt WBS API key.',
        });
        return;
      }

      // Build WBS URL with date params
      const wbsUrl = new URL(`${config.wbsBaseUrl}/api/v1/external/bot-analytics`);
      if (from && typeof from === 'string') wbsUrl.searchParams.set('from', from);
      if (to && typeof to === 'string') wbsUrl.searchParams.set('to', to);

      let wbsFetchRes: Awaited<ReturnType<typeof fetch>>;
      try {
        wbsFetchRes = await fetch(wbsUrl.toString(), {
          method: 'GET',
          headers: { 'x-wbs-api-key': apiKey },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        logger.error({ err: (err as Error).message, storeId }, '[BOT-ANALYTICS] WBS unreachable');
        res.status(502).json({
          success: false,
          error: { code: 'WBS_UNREACHABLE' },
          message: 'Could not reach WBS backend.',
        });
        return;
      }

      // Forward WBS response as-is (aggregates only — no PII)
      const body = await wbsFetchRes.json();
      const wbsStatus = wbsFetchRes.status;
      const wbsOk = wbsFetchRes.ok;

      if (!wbsOk) {
        logger.warn({ storeId, status: wbsStatus, body }, '[BOT-ANALYTICS] WBS returned error');
        res.status(wbsStatus).json({
          success: false,
          error: { code: 'WBS_ERROR', message: 'WBS request failed' },
        });
        return;
      }

      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
