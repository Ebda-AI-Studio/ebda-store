import { buyerKeyFor } from '@ebda/shared';

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
  // No try/catch: a failure here must fail the erasure (and be retried), never silently skip the
  // consent row and the `customer.erased` event (fail-open).
  return (await buyerKeyFor(secret, phone)) ?? undefined;
}
