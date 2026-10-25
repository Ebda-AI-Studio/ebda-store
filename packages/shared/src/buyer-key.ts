/**
 * The suite-wide buyer key (Ebda Store <-> Ebda WhatsApp contract, section 6; CI-1): a lowercase-hex
 * HMAC-SHA256 of the buyer's E.164 phone, keyed with SUITE_BUYER_KEY_SECRET (the same secret in
 * every suite Worker). The raw phone never enters analytics or CI; only this key does.
 *
 * Both functions are the contract's normaliser and hash. A change to either changes every key, so
 * `tests/unit/buyer-key.test.ts` pins the contract's test vector.
 */

const ARABIC_INDIC = /[٠-٩]/g; // ٠-٩
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g; // ۰-۹
const E164 = /^\+[1-9]\d{7,14}$/;

/** Bumped when SUITE_BUYER_KEY_SECRET is rotated (CI envelope `keyVersion`). */
export const BUYER_KEY_VERSION = 1;

/**
 * Any phone a shopper typed -> E.164, or null when it cannot be one. Egypt (+20) is the default
 * country, and ONLY Egyptian mobile shapes are accepted without an explicit country prefix:
 * `01001234567`, `1001234567`, `201001234567`, `+20 100 123 4567`, `+20 0100 123 4567` (trunk 0
 * dropped), `00201001234567` and Arabic-Indic digits all become `+201001234567`. A foreign number
 * must carry `+` or `00` (a UK `07911123456` is NOT turned into an Egyptian number: it is null).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ascii = raw
    .replace(ARABIC_INDIC, d => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, d => String(d.charCodeAt(0) - 0x06f0));
  const trimmed = ascii.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  let e164: string | null = null;
  const explicit = trimmed.startsWith('+')
    ? digits
    : digits.startsWith('00')
      ? digits.slice(2)
      : null;
  if (explicit !== null) {
    // `+20 0100...`: people type the national trunk 0 after the country code; it is not part of E.164.
    e164 = `+${explicit.startsWith('200') ? `20${explicit.slice(3)}` : explicit}`;
  } else if (/^01[0125]\d{8}$/.test(digits)) e164 = `+20${digits.slice(1)}`;
  else if (/^1[0125]\d{8}$/.test(digits)) e164 = `+20${digits}`;
  else if (/^201[0125]\d{8}$/.test(digits)) e164 = `+${digits}`;
  return e164 && E164.test(e164) ? e164 : null;
}

/** `HMAC-SHA256(secret, e164)` as lowercase hex, or null for a phone that is not E.164. */
export async function buyerKeyFor(
  secret: string,
  phone: string | null | undefined
): Promise<string | null> {
  if (!secret) throw new Error('SUITE_BUYER_KEY_SECRET is required to compute a buyer key');
  const e164 = toE164(phone);
  if (!e164) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(e164)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}
