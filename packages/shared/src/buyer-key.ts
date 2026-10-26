/**
 * The suite-wide buyer key (Ebda Store <-> Ebda WhatsApp contract, section 6; CI-1): a lowercase-hex
 * HMAC-SHA256 of the buyer's E.164 phone, keyed with SUITE_BUYER_KEY_SECRET (the same secret in
 * every suite Worker). The raw phone never enters analytics or CI; only this key does.
 *
 * Both functions are the contract's normaliser and hash. A change to either changes every key, so
 * `tests/unit/buyer-key.test.ts` pins the contract's test vector.
 */

const E164 = /^\+[1-9]\d{7,14}$/;
// LRM/RLM, ALM, embeddings/overrides and isolates that WhatsApp's RTL UI adds around numbers.
const BIDI_MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

function asciiDigits(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

/** Bumped when SUITE_BUYER_KEY_SECRET is rotated (CI envelope `keyVersion`). */
export const BUYER_KEY_VERSION = 1;

/**
 * Any phone a shopper typed -> E.164, or null when it cannot be one. THIS IS EBDA WHATSAPP'S
 * `normaliseE164` (src/core/phone.ts), line for line: two normalisers that differ give one customer two
 * keys (audit CODE-10). Do not "improve" it here; change both repos together and re-run the shared
 * vectors (tests/unit/buyer-key-vectors.test.ts).
 *
 * Without a `+`/`00` prefix only Egyptian forms are accepted: national `0...`, `20...` (12 digits) or a
 * 10-digit mobile typed without its leading 0. Anything else returns null rather than guessing a
 * country. (The Store's STORAGE format, `normalizePhoneForStorage`, is a different thing and unchanged,
 * Ruling FDN-PHONE-1; only the buyer-key input goes through this.)
 */
export function toE164(raw: string | null | undefined, defaultCountry: '20' = '20'): string | null {
  if (!raw) return null;
  let s = asciiDigits(raw.replace(BIDI_MARKS, '')).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) s = `+${defaultCountry}${s.slice(1)}`;
    else if (s.startsWith(defaultCountry) && s.length === 12) s = '+' + s;
    else if (/^1\d{9}$/.test(s)) s = `+${defaultCountry}${s}`;
    else return null;
  }
  // A trunk 0 kept after the country code (+20 0100...) is dropped.
  if (s.startsWith(`+${defaultCountry}0`)) {
    s = `+${defaultCountry}${s.slice(defaultCountry.length + 2)}`;
  }
  return E164.test(s) ? s : null;
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
