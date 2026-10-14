/**
 * WhatsApp Business API feature gate for the WBS bridge surfaces that
 * `requireFeature` cannot serve (no JWT user / route :id — the store is known
 * only after the bridge API key or the signed cart token is verified).
 *
 * The WhatsApp Business API integration is flagged OFF for every store
 * (Ruling WHATSAPP-OFF-1, 2026-10-14); a super-admin StoreFeature `whatsapp`
 * override enables it per store.
 */

import { featureService } from '../services/feature.service';
import logger from '../lib/logger';

/** Same shape `requireFeature` returns, so WBS sees one consistent refusal. */
export const FEATURE_DISABLED_BODY = {
  success: false,
  error: 'Feature not available',
  code: 'FEATURE_DISABLED',
  feature: 'whatsapp',
} as const;

/** Fail closed: a feature-service error counts as OFF. */
export async function isWhatsappEnabled(storeId: string): Promise<boolean> {
  try {
    return await featureService.isFeatureEnabled(storeId, 'whatsapp');
  } catch (err) {
    logger.error({ err: (err as Error).message, storeId }, '[wa-bridge] feature check failed');
    return false;
  }
}
