import { describe, it, expect } from 'vitest';
import { isSessionIntentPath } from '../../apps/web/src/lib/session-intent';

describe('isSessionIntentPath (audit 2026-11-03 #15)', () => {
  it.each([
    '/cart',
    '/ar/cart',
    '/en/checkout',
    '/account/orders',
    '/s/my-shop/ar/account/profile',
    '/ar/wishlist',
    '/ar/auth/login',
    '/ar/returns',
  ])('%s is an intent route', p => expect(isSessionIntentPath(p)).toBe(true));

  it.each([
    '/',
    '/ar',
    '/ar/products',
    '/ar/products/cart-cover',
    '/ar/products/account',
    '/en/blog/checkout-tips',
    '/ar/categories/wishlist',
    '/ar/search',
    null,
    undefined,
  ])('%s is not', p => expect(isSessionIntentPath(p as string)).toBe(false));
});
