import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.CART_RESTORE_SECRET = 'unit-test-cart-restore-secret';
});

import {
  signCartRestoreToken,
  verifyCartRestoreToken,
  CART_RESTORE_TTL_MS,
} from '@api/lib/cart-restore-token';

const S = '11111111-1111-4111-8111-111111111111';
const C = '33333333-3333-4333-8333-333333333333';
const T = '22222222-2222-4222-8222-222222222222';
const now = 1_800_000_000_000;

describe('cart restore token', () => {
  it('round-trips store + cart and carries no PII', () => {
    const token = signCartRestoreToken(S, C, now);
    expect(verifyCartRestoreToken(token, now + 1000)).toEqual({ storeId: S, cartId: C });
    expect(token).not.toMatch(/@/);
    expect(token.length).toBeLessThan(200);
  });

  it('expires', () => {
    const token = signCartRestoreToken(S, C, now);
    expect(verifyCartRestoreToken(token, now + CART_RESTORE_TTL_MS - 1)).not.toBeNull();
    expect(verifyCartRestoreToken(token, now + CART_RESTORE_TTL_MS + 1)).toBeNull();
  });

  it('is bound to its store and cart: swapping either part invalidates it', () => {
    const [s, c, exp, sig] = signCartRestoreToken(S, C, now).split('.');
    expect(verifyCartRestoreToken([T, c, exp, sig].join('.'), now)).toBeNull();
    expect(verifyCartRestoreToken([s, T, exp, sig].join('.'), now)).toBeNull();
    expect(
      verifyCartRestoreToken([s, c, String(Number(exp) + 999999), sig].join('.'), now)
    ).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    for (const bad of [undefined, null, 5, '', 'a.b.c', 'x'.repeat(500), `${S}.${C}.1.zzz`]) {
      expect(verifyCartRestoreToken(bad as never, now)).toBeNull();
    }
  });

  it('a campaign unsubscribe-style MAC does not verify here (domain separation)', () => {
    const [s, c, exp] = signCartRestoreToken(S, C, now).split('.');
    expect(verifyCartRestoreToken([s, c, exp, 'A'.repeat(43)].join('.'), now)).toBeNull();
  });
});
