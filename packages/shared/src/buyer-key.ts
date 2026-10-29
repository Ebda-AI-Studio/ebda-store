/**
 * The suite-wide buyer key (Ebda Store <-> Ebda WhatsApp contract, section 6; CI-1): a lowercase-hex
 * HMAC-SHA256 of the buyer's E.164 phone, keyed with SUITE_BUYER_KEY_SECRET (the same secret in
 * every suite Worker). The raw phone never enters analytics or CI; only this key does.
 *
 * Both functions are the contract's normaliser and hash. A change to either changes every key, so
 * `tests/unit/buyer-key.test.ts` pins the contract's test vector.
 */

import { buyerKey } from './foundation/buyer';

export { BUYER_KEY_PROBE_INPUT, MIN_PROBE_SECRET_LENGTH, buyerKeyProbe } from './foundation/buyer';
import { isEgyptianNational, normaliseE164 } from './foundation/phone';

export { isEgyptianNational };

/** Bumped when SUITE_BUYER_KEY_SECRET is rotated (CI envelope `keyVersion`). */
export const BUYER_KEY_VERSION = 1;

/**
 * Any phone a shopper typed -> E.164, or null when it cannot be one. This is the foundation's `normaliseE164`
 * (vendored, foundation.lock.json): two normalisers that differ give one customer two keys (audit CODE-10), so the
 * Store no longer carries its own copy. Change it in ebda-foundation and re-run the shared vectors
 * (tests/unit/foundation-parity.test.ts, tests/unit/buyer-key-vectors.test.ts).
 *
 * Without a `+`/`00` prefix only Egyptian forms are accepted (Ruling PHONE-2). (The Store's STORAGE format,
 * `normalizePhoneForStorage`, is a different thing and unchanged, Ruling FDN-PHONE-1; only the buyer-key input goes through this.)
 */
export function toE164(raw: string | null | undefined, defaultCountry: '20' = '20'): string | null {
  if (!raw) return null;
  return normaliseE164(raw, defaultCountry);
}

/** `HMAC-SHA256(secret, e164)` as lowercase hex, or null for a phone that is not E.164. */
export async function buyerKeyFor(
  secret: string,
  phone: string | null | undefined
): Promise<string | null> {
  if (!secret) throw new Error('SUITE_BUYER_KEY_SECRET is required to compute a buyer key');
  const e164 = toE164(phone);
  if (!e164) return null;
  return buyerKey(secret, e164);
}
