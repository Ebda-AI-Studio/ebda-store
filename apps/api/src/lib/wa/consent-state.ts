/**
 * `customer.consent_changed` (envelope v1.1): emitted on EVERY write of a buyer's WhatsApp marketing
 * consent (checkout tick, account settings, admin change, STOP, erasure -> false), by ONE database
 * observer like `store.plan_changed`, so no write path can change consent without Ebda Chat
 * hearing of it. The observer only names the (store, buyer); the job re-reads the CURRENT row, so
 * the message always carries the truth and a retry cannot send a stale value.
 */
import type { ModelWriteEvent } from '@ebda/database';
import { readStoreDb } from '../jobs/store-db';
import { whatsappOptInWording } from '@ebda/shared';
import { sendEventAfterCommit } from '../inngest/send-after-commit';
import logger from '../logger';
import type { StoreEventInput } from './events';

export const CONSENT_CHANGED_EVENT = 'wa/consent-changed';

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Which (store, buyer) a write to the consent table concerns. Pure; the guard test drives it. */
export function consentChangeTarget(
  e: ModelWriteEvent
): { storeId: string; buyerKey: string } | null {
  if (e.model !== 'StoreWhatsAppConsent') return null;
  const args = (e.args ?? {}) as {
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
    create?: Record<string, unknown>;
  };
  const result = (e.result ?? {}) as Record<string, unknown>;
  const compound = args.where?.storeId_buyerKey as Record<string, unknown> | undefined;
  const storeId =
    str(compound?.storeId) ??
    str(args.where?.storeId) ??
    str(args.data?.storeId) ??
    str(args.create?.storeId) ??
    str(result.storeId);
  const buyerKey =
    str(compound?.buyerKey) ??
    str(args.where?.buyerKey) ??
    str(args.data?.buyerKey) ??
    str(args.create?.buyerKey) ??
    str(result.buyerKey);
  return storeId && buyerKey ? { storeId, buyerKey } : null;
}

export function onConsentWrite(e: ModelWriteEvent): void {
  if (e.model !== 'StoreWhatsAppConsent') return;
  const t = consentChangeTarget(e);
  if (!t) {
    // A bulk write we cannot attribute would be a silent consent change: make it loud.
    logger.error(
      { operation: e.operation },
      '[wa] consent write without store+buyer key, not announced'
    );
    return;
  }
  void sendEventAfterCommit(
    'wa-consent-changed',
    { name: CONSENT_CHANGED_EVENT, data: t },
    { ifUnhookable: 'send' }
  ).catch(err => logger.error({ err, storeId: t.storeId }, '[wa] consent change notify failed'));
}

/** The envelope input for the buyer's CURRENT consent (absent row = false, e.g. after erasure). */
export async function consentChangedInput(
  storeId: string,
  buyerKey: string,
  now: Date = new Date()
): Promise<{ input: StoreEventInput; seed: string; occurredAt: Date }> {
  const row = await readStoreDb(storeId, db =>
    db.storeWhatsAppConsent.findUnique({
      where: { storeId_buyerKey: { storeId, buyerKey } },
      select: { granted: true, grantedAt: true, revokedAt: true, updatedAt: true, locale: true },
    })
  );
  const marketingOptIn = row?.granted === true;
  const at = (marketingOptIn ? row?.grantedAt : row?.revokedAt) ?? row?.updatedAt ?? now;
  return {
    seed: `consent:${storeId}:${buyerKey}:${marketingOptIn}:${at.getTime()}`,
    occurredAt: at,
    input: {
      type: 'customer.consent_changed',
      storeId,
      data: {
        buyerKey,
        marketingOptIn,
        at: at.toISOString(),
        // v1.5: the exact words the buyer ticked, in the locale shown (only for an opt-in whose locale
        // the Store recorded; a withdrawal has no wording).
        ...(marketingOptIn && (row?.locale === 'ar' || row?.locale === 'en')
          ? { wording: { text: whatsappOptInWording(row.locale), locale: row.locale } }
          : {}),
      },
    },
  };
}
