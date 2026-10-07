/**
 * WBS→FWB bridge inbound auth (Phase 6 / Option C).
 *
 * WBS calls into FWB to look up products + create carts. Auth is the
 * SAME `wbsApiKey` that FWB issues when a merchant connects WBS through
 * the existing wbs-integration routes — but used in the reverse direction
 * (WBS sends it as `X-WBS-API-KEY` header; FWB looks up the matching
 * store).
 *
 * On success, attaches `req.bridgeStore` with the store row (only safe
 * fields — no decrypted credentials).
 *
 * Refuses to match against stores where `wbsEnabled=false` or
 * `wbsClientId is null` (the merchant disconnected the integration).
 */

import { Request, Response, NextFunction } from 'express';
import { withStore } from '@force/database';
import { wbsBridgeKeys } from '../lib/definer';
import { encryption } from '../services/encryption.service';
import logger from '../lib/logger';

export interface BridgeStore {
  id: string;
  slug: string;
  name: string;
  currency: string;
  wbsClientId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    bridgeStore?: BridgeStore;
  }
}

export async function waBridgeAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = (req.header('x-wbs-api-key') || req.header('X-WBS-API-KEY') || '').toString();

  if (!apiKey || apiKey.length < 8) {
    res.status(401).json({ success: false, error: 'WBS_API_KEY_MISSING' });
    return;
  }

  // Look up by decrypting every connected store's key + comparing. Small
  // tenant count today (<10 stores) — O(n) acceptable. For scale: index
  // a hash of the key into a separate `wbsApiKeyHash` column.
  try {
    const candidates = await wbsBridgeKeys();

    const match = candidates.find(c => {
      if (!c.wbsApiKey) return false;
      try {
        return encryption.decrypt(c.wbsApiKey) === apiKey;
      } catch {
        return false;
      }
    });

    if (!match) {
      logger.warn({ ip: req.ip }, '[wa-bridge-auth] invalid api key');
      res.status(401).json({ success: false, error: 'WBS_API_KEY_INVALID' });
      return;
    }

    const store = await withStore(match.storeId, tx =>
      tx.store.findUnique({
        where: { id: match.storeId },
        select: { id: true, slug: true, name: true, currency: true, wbsClientId: true },
      })
    );

    if (!store) {
      logger.warn({ ip: req.ip }, '[wa-bridge-auth] invalid api key');
      res.status(401).json({ success: false, error: 'WBS_API_KEY_INVALID' });
      return;
    }

    req.bridgeStore = {
      id: store.id,
      slug: store.slug,
      name: store.name,
      currency: store.currency,
      wbsClientId: store.wbsClientId,
    };
    next();
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge-auth] lookup failed');
    res.status(500).json({ success: false, error: 'BRIDGE_AUTH_FAILED' });
  }
}
