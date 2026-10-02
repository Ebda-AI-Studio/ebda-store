/**
 * Review deep-link token (issue 2424 class sweep): the link in a review-request
 * email lives 90 days and must not die when the SESSION secret is rotated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const cfg = vi.hoisted(() => ({
  jwtSecret: 'test-jwt-secret',
  encryptionKey: 'test-encryption-key-0123456789abcdef',
}));
vi.mock('@api/config', () => ({ config: cfg }));

import { signReviewToken, verifyReviewToken } from '@api/lib/review-token';

const ORDER = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const now = () => new Date();

afterEach(() => {
  delete process.env.REVIEW_TOKEN_SECRET;
  cfg.jwtSecret = 'test-jwt-secret';
  cfg.encryptionKey = 'test-encryption-key-0123456789abcdef';
});

const legacy = (secret: string) =>
  createHmac('sha256', secret).update(`${ORDER}:${PRODUCT}`).digest('hex');

describe('review link token', () => {
  it('round-trips, and binds the order and the product', () => {
    const token = signReviewToken(ORDER, PRODUCT);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyReviewToken(ORDER, PRODUCT, token, now())).toBe(true);
    expect(verifyReviewToken(PRODUCT, ORDER, token, now())).toBe(false);
  });

  it('a new link survives a JWT_SECRET rotation', () => {
    const token = signReviewToken(ORDER, PRODUCT);
    cfg.jwtSecret = 'rotated-session-secret';
    expect(verifyReviewToken(ORDER, PRODUCT, token, now())).toBe(true);
  });

  it('a new link is not keyed on JWT_SECRET', () => {
    expect(signReviewToken(ORDER, PRODUCT)).not.toBe(legacy(cfg.jwtSecret));
  });

  it('a link signed before the change (JWT_SECRET) still verifies', () => {
    expect(verifyReviewToken(ORDER, PRODUCT, legacy(cfg.jwtSecret), now())).toBe(true);
  });

  it('with REVIEW_TOKEN_SECRET set, only that secret verifies', () => {
    process.env.REVIEW_TOKEN_SECRET = 'dedicated';
    expect(verifyReviewToken(ORDER, PRODUCT, legacy('dedicated'), now())).toBe(true);
    expect(verifyReviewToken(ORDER, PRODUCT, legacy(cfg.jwtSecret), now())).toBe(false);
  });

  it('rejects an expired link, a tampered token and malformed input', () => {
    const token = signReviewToken(ORDER, PRODUCT);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    expect(verifyReviewToken(ORDER, PRODUCT, token, old)).toBe(false);
    const flipped = token.slice(0, 10) + (token[10] === 'a' ? 'b' : 'a') + token.slice(11);
    expect(verifyReviewToken(ORDER, PRODUCT, flipped, now())).toBe(false);
    // A non-hex tail: Buffer.from(…, 'hex') would stop at it and decode a
    // shorter buffer, so the shape check must reject it first.
    for (const bad of ['', 'zz', token.slice(0, 62) + 'zz', `${token}00`]) {
      expect(verifyReviewToken(ORDER, PRODUCT, bad, now())).toBe(false);
    }
  });
});
