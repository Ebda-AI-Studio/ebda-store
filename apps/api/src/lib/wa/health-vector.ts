/**
 * `buyerKeyVector` on GET /health: lets Ebda WhatsApp (and anyone with the secret) prove both Workers hold
 * the SAME SUITE_BUYER_KEY_SECRET without ever sending it. It is the first 16 hex chars of
 * HMAC-SHA256(key = the secret as UTF-8, message = "suite-buyer-key-probe:v1"). The probe message is a
 * constant, so the value is NOT derived from any phone, order or customer, and 64 bits of an HMAC output
 * reveal nothing usable about the key. Absent (never a placeholder) when the secret is not set.
 */
export const BUYER_KEY_PROBE_MESSAGE = 'suite-buyer-key-probe:v1';

/**
 * The probe is public, so it is an offline guessing oracle for a WEAK secret (WA-HEALTH-VECTOR-1 addendum):
 * a human-chosen secret could be brute-forced against the published 64 bits. The production secret is 256-bit
 * random (64 hex chars), so the field is emitted ONLY for a secret of at least this many characters.
 */
export const MIN_PROBE_SECRET_LENGTH = 64;

export async function buyerKeyVector(secret: string | undefined): Promise<string | null> {
  if (!secret || secret.length < MIN_PROBE_SECRET_LENGTH) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(BUYER_KEY_PROBE_MESSAGE))
  );
  return [...sig]
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
