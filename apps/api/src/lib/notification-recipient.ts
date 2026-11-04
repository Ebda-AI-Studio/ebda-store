/**
 * The recipient key stored in `notification_logs.recipient_phone_hash` (Ruling NZ-AN-1).
 *
 * It used to be an UNSALTED SHA-256 of the phone: Egyptian mobile numbers are a ~4e8 space, so that hash was reversible and
 * therefore personal data. It is now the suite buyer key, HMAC-SHA256(SUITE_BUYER_KEY_SECRET, E.164 phone): not reversible
 * without the secret, and it is exactly the key a shopper erasure already carries (`CustomerSubject.buyerKey`), so the erasure
 * finds and deletes the shopper's log rows by it. No secret or no usable phone = NULL (nothing is stored rather than something
 * reversible).
 */
import { buyerKeyFor, toE164 } from '@ebda/shared';

export async function recipientPhoneKey(phone: string | null | undefined): Promise<string | null> {
  const e164 = toE164(phone);
  if (!e164) return null;
  const secret = process.env.SUITE_BUYER_KEY_SECRET ?? '';
  if (secret.length < 32) return null;
  return (await buyerKeyFor(secret, e164)) ?? null;
}
