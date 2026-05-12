import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

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
 * Key precedence: REVIEW_TOKEN_SECRET → JWT_SECRET. Operators who want
 * rotation isolation should set REVIEW_TOKEN_SECRET separately; most
 * won't bother and JWT_SECRET is fine.
 */
const SECRET = () => process.env.REVIEW_TOKEN_SECRET || config.jwtSecret;

/** 90 days in milliseconds */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function signReviewToken(orderId: string, productId: string): string {
  const data = `${orderId}:${productId}`;
  return createHmac('sha256', SECRET()).update(data).digest('hex');
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

  const expected = signReviewToken(orderId, productId);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
  } catch {
    return false;
  }
}
