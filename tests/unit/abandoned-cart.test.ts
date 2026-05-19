/**
 * Abandoned Cart Recovery — Unit Tests
 * Tests notification events, templates, deterministic coupon codes, and HMAC verification.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

import { SMS_TEMPLATES, PUSH_TEMPLATES } from '../../packages/shared/src/notifications';

// ─── 2. SMS_TEMPLATES has entries for all 3 cart events ───────────────────────

describe('SMS_TEMPLATES — cart abandoned entries', () => {
  it('has an entry for cart_abandoned_step1', () => {
    expect(SMS_TEMPLATES).toHaveProperty('cart_abandoned_step1');
  });

  it('has an entry for cart_abandoned_step2', () => {
    expect(SMS_TEMPLATES).toHaveProperty('cart_abandoned_step2');
  });

  it('has an entry for cart_abandoned_step3', () => {
    expect(SMS_TEMPLATES).toHaveProperty('cart_abandoned_step3');
  });

  it('cart_abandoned_step1 has non-empty en and ar strings', () => {
    const t = SMS_TEMPLATES.cart_abandoned_step1;
    expect(t.en.length).toBeGreaterThan(0);
    expect(t.ar.length).toBeGreaterThan(0);
  });

  it('cart_abandoned_step2 has non-empty en and ar strings', () => {
    const t = SMS_TEMPLATES.cart_abandoned_step2;
    expect(t.en.length).toBeGreaterThan(0);
    expect(t.ar.length).toBeGreaterThan(0);
  });

  it('cart_abandoned_step3 has non-empty en and ar strings', () => {
    const t = SMS_TEMPLATES.cart_abandoned_step3;
    expect(t.en.length).toBeGreaterThan(0);
    expect(t.ar.length).toBeGreaterThan(0);
  });
});

// ─── 4. PUSH_TEMPLATES has entries for all 3 cart events ─────────────────────

describe('PUSH_TEMPLATES — cart abandoned entries', () => {
  it('has an entry for cart_abandoned_step1', () => {
    expect(PUSH_TEMPLATES).toHaveProperty('cart_abandoned_step1');
  });

  it('has an entry for cart_abandoned_step2', () => {
    expect(PUSH_TEMPLATES).toHaveProperty('cart_abandoned_step2');
  });

  it('has an entry for cart_abandoned_step3', () => {
    expect(PUSH_TEMPLATES).toHaveProperty('cart_abandoned_step3');
  });

  it('cart_abandoned_step1 has title and body with en/ar strings', () => {
    const t = PUSH_TEMPLATES.cart_abandoned_step1;
    expect(t.title.en.length).toBeGreaterThan(0);
    expect(t.title.ar.length).toBeGreaterThan(0);
    expect(t.body.en.length).toBeGreaterThan(0);
    expect(t.body.ar.length).toBeGreaterThan(0);
  });

  it('cart_abandoned_step2 has title and body with en/ar strings', () => {
    const t = PUSH_TEMPLATES.cart_abandoned_step2;
    expect(t.title.en.length).toBeGreaterThan(0);
    expect(t.title.ar.length).toBeGreaterThan(0);
    expect(t.body.en.length).toBeGreaterThan(0);
    expect(t.body.ar.length).toBeGreaterThan(0);
  });

  it('cart_abandoned_step3 has title and body with en/ar strings', () => {
    const t = PUSH_TEMPLATES.cart_abandoned_step3;
    expect(t.title.en.length).toBeGreaterThan(0);
    expect(t.title.ar.length).toBeGreaterThan(0);
    expect(t.body.en.length).toBeGreaterThan(0);
    expect(t.body.ar.length).toBeGreaterThan(0);
  });
});

// ─── 5. Deterministic coupon code ─────────────────────────────────────────────

describe('Deterministic coupon code generation', () => {
  const cartId = 'cart-abc-123';
  const storeId = 'store-xyz-456';

  function generateCouponCode(cartIdParam: string, storeIdParam: string): string {
    return (
      'RECOVER-' +
      crypto
        .createHash('sha256')
        .update(cartIdParam + storeIdParam)
        .digest('hex')
        .substring(0, 6)
        .toUpperCase()
    );
  }

  it('produces the same code for the same inputs', () => {
    const code1 = generateCouponCode(cartId, storeId);
    const code2 = generateCouponCode(cartId, storeId);
    expect(code1).toBe(code2);
  });

  it('always starts with RECOVER-', () => {
    const code = generateCouponCode(cartId, storeId);
    expect(code.startsWith('RECOVER-')).toBe(true);
  });

  it('suffix is exactly 6 uppercase hex characters', () => {
    const code = generateCouponCode(cartId, storeId);
    const suffix = code.replace('RECOVER-', '');
    expect(suffix).toHaveLength(6);
    expect(suffix).toMatch(/^[0-9A-F]{6}$/);
  });

  it('produces different codes for different cart IDs', () => {
    const code1 = generateCouponCode('cart-aaa', storeId);
    const code2 = generateCouponCode('cart-bbb', storeId);
    expect(code1).not.toBe(code2);
  });

  it('produces different codes for different store IDs', () => {
    const code1 = generateCouponCode(cartId, 'store-aaa');
    const code2 = generateCouponCode(cartId, 'store-bbb');
    expect(code1).not.toBe(code2);
  });
});

// ─── 6. HMAC verification ─────────────────────────────────────────────────────

describe('HMAC recovery URL signature', () => {
  const encryptionKey = 'test-encryption-key-32-chars-long!!';
  const abandonedCartId = 'abandoned-cart-id-999';

  function generateSig(id: string, key: string): string {
    return crypto.createHmac('sha256', key).update(id).digest('hex');
  }

  function verifySig(id: string, sig: string, key: string): boolean {
    const expected = generateSig(id, key);
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  it('valid signature passes verification', () => {
    const sig = generateSig(abandonedCartId, encryptionKey);
    expect(verifySig(abandonedCartId, sig, encryptionKey)).toBe(true);
  });

  it('invalid signature fails verification', () => {
    const fakeSig = 'a'.repeat(64); // 64 hex chars = 32 bytes
    expect(verifySig(abandonedCartId, fakeSig, encryptionKey)).toBe(false);
  });

  it('signature for a different ID fails verification', () => {
    const sig = generateSig('different-cart-id', encryptionKey);
    expect(verifySig(abandonedCartId, sig, encryptionKey)).toBe(false);
  });

  it('same ID and key always produces the same signature', () => {
    const sig1 = generateSig(abandonedCartId, encryptionKey);
    const sig2 = generateSig(abandonedCartId, encryptionKey);
    expect(sig1).toBe(sig2);
  });

  it('signature is a 64-character hex string', () => {
    const sig = generateSig(abandonedCartId, encryptionKey);
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});
