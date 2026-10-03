import crypto from 'crypto';

/** Constant-time comparison of two hex/utf8 strings; length mismatch is just `false`. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(secret: string, message: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}
