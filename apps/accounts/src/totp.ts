/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) on WebCrypto, plus AES-256-GCM sealing of the secret at rest. */
import { b64urlDecode, b64urlEncode, safeEqual } from './util';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function b32decode(s: string): Uint8Array {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    b32decode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Accepts the current step and one step either side (clock skew). Returns the matched step or null; the caller must then claim the step atomically (data.claimTotpStep). */
export async function verifyTotp(
  secret: string,
  code: string,
  atMs = Date.now(),
  lastAcceptedStep: number | null = null
): Promise<number | null> {
  if (!/^\d{6}$/.test(code ?? '')) return null;
  const step = Math.floor(atMs / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    // A step at or before the last accepted one was already used: a replayed code is refused.
    if (lastAcceptedStep !== null && s <= lastAcceptedStep) continue;
    if (safeEqual(await hotp(secret, s), code)) return s;
  }
  return null;
}

export const totpUri = (label: string, secret: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

async function aes(keyB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('MFA_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Sealed format `v3.<kid>.<iv>.<ciphertext+tag>` (base64url), AES-GCM with AAD `v3|kid|userId`. `kid` = first 8 hex chars of sha256(key bytes), so a ciphertext names the
 * key that made it and a keyring (`MFA_KEY` current, `MFA_KEY_PREV` previous) can open it during a rotation. The legacy
 * `v1.<iv>.<ciphertext+tag>` (no kid) is still opened by trying each key in the ring, and is re-sealed as v2 by the re-encrypt job.
 */
export async function keyId(keyB64: string): Promise<string> {
  const raw = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return [...d.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** AAD binds the ciphertext to its key id AND its owner: a sealed secret copied onto another user's row (or another kid) fails to open. */
const aad = (kid: string, userId: string) => new TextEncoder().encode(`v3|${kid}|${userId}`);

export async function seal(keyB64: string, plain: string, userId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kid = await keyId(keyB64);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(kid, userId) },
      await aes(keyB64),
      new TextEncoder().encode(plain)
    )
  );
  return `v3.${kid}.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

async function open(
  keyB64: string,
  ivB64: string,
  ctB64: string,
  additionalData?: Uint8Array
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(ivB64), ...(additionalData ? { additionalData } : {}) },
    await aes(keyB64),
    b64urlDecode(ctB64)
  );
  return new TextDecoder().decode(pt);
}

/** The keys that may OPEN a sealed secret: current first, then the previous one while a rotation is in flight. */
export interface MfaKeyring {
  MFA_KEY?: string;
  MFA_KEY_PREV?: string;
  /** 'true' once the re-encrypt job reports 0 remaining: refuse the legacy v1/v2 formats (they carry no owner binding). */
  MFA_REJECT_LEGACY?: string;
}
const ring = (k: MfaKeyring): string[] =>
  [k.MFA_KEY, k.MFA_KEY_PREV].filter((x): x is string => !!x);

/** Seal with the CURRENT key, bound to the owner. */
export async function sealCurrent(k: MfaKeyring, plain: string, userId: string): Promise<string> {
  if (!k.MFA_KEY) throw new Error('MFA_KEY is not configured');
  return seal(k.MFA_KEY, plain, userId);
}

/**
 * Open with whichever key in the ring made it. v3 = by kid, AAD-bound to the owner. v2 = by kid, NO AAD (legacy, never shipped to
 * production but may exist in a mixed rollout). v1 = no kid, no AAD (tried against each ring key). Both legacy formats are
 * refused once `MFA_REJECT_LEGACY=true`, so a ciphertext copied between rows cannot skip the owner binding after the migration.
 */
export async function unsealAny(k: MfaKeyring, sealed: string, userId: string): Promise<string> {
  const parts = sealed.split('.');
  const keys = ring(k);
  const legacyOk = k.MFA_REJECT_LEGACY !== 'true';
  if (parts[0] === 'v3' && parts.length === 4) {
    for (const key of keys) {
      if ((await keyId(key)) === parts[1])
        return open(key, parts[2], parts[3], aad(parts[1], userId));
    }
    throw new Error('sealed secret names a key that is not in the keyring');
  }
  if (parts[0] === 'v2' && parts.length === 4 && legacyOk) {
    for (const key of keys) {
      if ((await keyId(key)) === parts[1]) return open(key, parts[2], parts[3]);
    }
    throw new Error('sealed secret names a key that is not in the keyring');
  }
  if (parts[0] === 'v1' && parts.length === 3 && legacyOk) {
    let last: unknown = new Error('no key');
    for (const key of keys) {
      try {
        return await open(key, parts[1], parts[2]);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
  throw new Error('unsupported sealed format');
}

/** Is this secret NOT a v3 on the current key (legacy v1/v2, or another kid)? */
export async function needsReseal(k: MfaKeyring, sealed: string): Promise<boolean> {
  if (!k.MFA_KEY) return false;
  return !sealed.startsWith(`v3.${await keyId(k.MFA_KEY)}.`);
}

/** The code a device would show at `atMs` (exported for tests and the enrolment self-check). */
export const totpAt = async (secret: string, atMs = Date.now()): Promise<string> =>
  hotp(secret, Math.floor(atMs / 30_000));
