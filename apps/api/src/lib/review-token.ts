import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { derivedSecret } from './derived-secret';

/**
 * HMAC-SHA256 token for review deep-links.
 *
 * Token = hex(HMAC-SHA256(orderId + ':' + productId, SECRET))
 *
 * Expiry is NOT embedded in the token itself — the caller passes
 * `sentAt` (Order.reviewRequestSentAt) and we check whether 90 days
 * have passed at verification time. This avoids storing an expiry in
 * the DB and keeps the token compact (64 hex chars).
 *
 * Signing key: REVIEW_TOKEN_SECRET when set, else a purpose-bound key derived
 * from ENCRYPTION_KEY (`lib/derived-secret.ts`, issue 2424). It used to fall
 * back to JWT_SECRET, so rotating the SESSION secret silently killed every
 * review link still inside its 90-day window.
 *
 * Verify keys: the signing key, plus — only when no dedicated secret is set —
 * JWT_SECRET, for links signed before issue 2424 (they age out within 90 days).
 */
function signingKey(): string | Buffer {
  return process.env.REVIEW_TOKEN_SECRET || derivedSecret('ebda:review-link-mac:v1');
}

function verifyKeys(): Array<string | Buffer> {
  const dedicated = process.env.REVIEW_TOKEN_SECRET;
  return dedicated ? [dedicated] : [derivedSecret('ebda:review-link-mac:v1'), config.jwtSecret];
}

function macHex(key: string | Buffer, orderId: string, productId: string): string {
  return createHmac('sha256', key).update(`${orderId}:${productId}`).digest('hex');
}

/** 90 days in milliseconds */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function signReviewToken(orderId: string, productId: string): string {
  return macHex(signingKey(), orderId, productId);
}

/**
 * Verify a review token.
 *
 * @param orderId    - The order this review is for
 * @param productId  - The product being reviewed
 * @param token      - The hex HMAC from the URL query param
 * @param sentAt     - Order.reviewRequestSentAt — used for 90-day expiry
 */
export function verifyReviewToken(
  orderId: string,
  productId: string,
  token: string,
  sentAt: Date
): boolean {
  // 90-day expiry from when the email was sent
  if (Date.now() - sentAt.getTime() > MAX_AGE_MS) return false;

  // 64 hex chars, what macHex emits. Buffer.from(…, 'hex') silently stops at
  // the first non-hex character, so the shape is checked first rather than
  // trusted to the decoder.
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return false;
  const given = Buffer.from(token, 'hex');
  // Constant-time comparison to prevent timing attacks
  return verifyKeys().some(key =>
    timingSafeEqual(given, Buffer.from(macHex(key, orderId, productId), 'hex'))
  );
}
