import { buyerKeyFor } from '@ebda/shared';
import logger from '../logger';

/**
 * The buyer key for an erasure: never throws (an erase must not fail because WhatsApp is not
 * configured). No phone, or no suite secret, means there is no key to send.
 */
export async function buyerKeyForErasure(
  phone: string | null | undefined
): Promise<string | undefined> {
  if (!phone) return undefined;
  const secret = process.env.SUITE_BUYER_KEY_SECRET ?? '';
  if (secret.length < 32) return undefined;
  try {
    return (await buyerKeyFor(secret, phone)) ?? undefined;
  } catch (err) {
    logger.warn({ err }, '[wa] buyer key for erasure failed');
    return undefined;
  }
}
