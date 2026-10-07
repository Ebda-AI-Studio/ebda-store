/**
 * WBS→Ebda bridge inbound auth (Phase 6 / Option C).
 *
 * WBS calls into Ebda to look up products + create carts. Auth is the
 * SAME `wbsApiKey` that Ebda issues when a merchant connects WBS through
 * the existing wbs-integration routes — but used in the reverse direction
 * (WBS sends it as `X-WBS-API-KEY` header; Ebda looks up the matching
 * store).
 *
 * On success, attaches `req.bridgeStore` with the store row (only safe
 * fields — no decrypted credentials).
 *
 * Refuses to match against stores where `wbsEnabled=false` or
 * `wbsClientId is null` (the merchant disconnected the integration).
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '@force/database';
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
    const stores = await prisma.store.findMany({
      where: { wbsEnabled: true, wbsApiKey: { not: null } },
      select: {
        id: true,
        slug: true,
        name: true,
        currency: true,
        wbsClientId: true,
        wbsApiKey: true,
      },
    });

    const match = stores.find((s: (typeof stores)[number]) => {
      if (!s.wbsApiKey) return false;
      try {
        return encryption.decrypt(s.wbsApiKey) === apiKey;
      } catch {
        return false;
      }
    });

    if (!match) {
      logger.warn({ ip: req.ip }, '[wa-bridge-auth] invalid api key');
      res.status(401).json({ success: false, error: 'WBS_API_KEY_INVALID' });
      return;
    }

    req.bridgeStore = {
      id: match.id,
      slug: match.slug,
      name: match.name,
      currency: match.currency,
      wbsClientId: match.wbsClientId,
    };
    next();
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[wa-bridge-auth] lookup failed');
    res.status(500).json({ success: false, error: 'BRIDGE_AUTH_FAILED' });
  }
}
