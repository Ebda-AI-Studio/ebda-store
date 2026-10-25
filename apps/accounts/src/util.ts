const enc = new TextEncoder();

export const b64urlEncode = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 256 bits of CSPRNG, URL-safe. */
export const randomToken = (): string => b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

/** Uniform 6-digit code (rejection sampling: no modulo bias). */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_000_000_000) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

/** Constant-time string equality (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const nowMs = (): number => Date.now();
export const iso = (ms: number = Date.now()): string => new Date(ms).toISOString();
export const csv = (s: string | undefined): string[] =>
  (s ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
