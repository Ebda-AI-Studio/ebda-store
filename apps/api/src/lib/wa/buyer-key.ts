import { buyerKeyFor } from '@ebda/shared';

import logger from '../logger';

/**
 * The buyer key for an erasure. No phone, or NO suite secret at all (WhatsApp never configured), means there is no key to
 * send. A secret that IS set but shorter than 32 chars is a broken link, not an absent one: it THROWS (WA-4) so the erasure
 * fails loudly and is retried once the secret is fixed, instead of silently skipping the Chat consent row and the
 * `customer.erased` event (a data-subject erase that never reached Chat).
 */
export async function buyerKeyForErasure(
  phone: string | null | undefined
): Promise<string | undefined> {
  if (!phone) return undefined;
  const secret = process.env.SUITE_BUYER_KEY_SECRET ?? '';
  if (secret.length === 0) {
    logger.warn('[wa] erasure: SUITE_BUYER_KEY_SECRET unset, Ebda Chat is not notified');
    return undefined;
  }
  if (secret.length < 32) {
    logger.error('[wa] erasure refused: SUITE_BUYER_KEY_SECRET is shorter than 32 chars');
    throw new Error(
      'SUITE_BUYER_KEY_SECRET is set but shorter than 32 chars: erasure cannot reach Ebda Chat'
    );
  }
  // No try/catch: a failure here must fail the erasure (and be retried), never silently skip the
  // consent row and the `customer.erased` event (fail-open).
  return (await buyerKeyFor(secret, phone)) ?? undefined;
}
