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

/** Accepts the current step and one step either side (clock skew). Returns the matched step or null. */
export async function verifyTotp(
  secret: string,
  code: string,
  atMs = Date.now()
): Promise<number | null> {
  if (!/^\d{6}$/.test(code ?? '')) return null;
  const step = Math.floor(atMs / 30_000);
  for (const s of [step, step - 1, step + 1]) {
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

/** Format `v1.<iv>.<ciphertext+tag>` (base64url). */
export async function seal(keyB64: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aes(keyB64),
      new TextEncoder().encode(plain)
    )
  );
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function unseal(keyB64: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unsupported sealed format');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(iv) },
    await aes(keyB64),
    b64urlDecode(ct)
  );
  return new TextDecoder().decode(pt);
}

/** The code a device would show at `atMs` (exported for tests and the enrolment self-check). */
export const totpAt = async (secret: string, atMs = Date.now()): Promise<string> =>
  hotp(secret, Math.floor(atMs / 30_000));
