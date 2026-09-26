/**
 * #1368 / #1379 — every storefront call to the coupon validate route must send
 * the cart lines.
 *
 * The route evaluates a coupon's targeting (product/category scope, minimum
 * quantity, customer group, first order) ONLY when `cartItems` is present.
 * All three storefront callers posted `{ code, orderTotal }` alone, so a scoped
 * or first-order-only code — free-shipping ones included — was shown as
 * applied, the summary zeroed delivery, and OrderService.create then refused
 * the order with COUPON_NOT_ELIGIBLE. The defect was a missing field at the
 * call sites, so the gate is on the call sites: each one is found by the
 * route string and must carry `cartItems`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { couponQuoteBasis, couponQuoteCartItems } from '@web/lib/coupon-quote-basis';

const ROOT = path.resolve(__dirname, '../..');
const CALLERS = [
  'apps/web/src/app/cart/CartClient.tsx',
  'apps/web/src/app/checkout/CheckoutClient.tsx',
];

/** The argument text of each `coupons/validate` post in a source file. */
function validateCalls(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const out: string[] = [];
  let at = src.indexOf('/coupons/validate`');
  while (at !== -1) {
    // The request body is the object literal that follows the URL, up to
    // the call's closing `);`.
    out.push(src.slice(at, src.indexOf(');', at)));
    at = src.indexOf('/coupons/validate`', at + 1);
  }
  return out;
}

describe('storefront coupon validate callers', () => {
  it('finds all three callers (a moved call must not silently shrink the gate)', () => {
    expect(CALLERS.flatMap(validateCalls)).toHaveLength(3);
  });

  it.each(CALLERS)('%s sends the cart lines on every validate call', file => {
    for (const call of validateCalls(file)) {
      expect(call).toMatch(/cartItems:\s*couponQuoteCartItems\(/);
    }
  });

  it('checkout also sends the typed identity, so group/first-order are judged as at order time', () => {
    const [call] = validateCalls('apps/web/src/app/checkout/CheckoutClient.tsx');
    expect(call).toMatch(/phone:/);
    expect(call).toMatch(/email:/);
  });
});

describe('couponQuoteCartItems', () => {
  it('sums to exactly the orderTotal basis sent alongside it', () => {
    const items = [
      { productId: 'a', price: 1250, quantity: 3 },
      { productId: 'b', price: 990, quantity: 1 },
    ];
    const lines = couponQuoteCartItems(items);
    expect(lines).toEqual([
      { productId: 'a', quantity: 3, lineTotal: 3750 },
      { productId: 'b', quantity: 1, lineTotal: 990 },
    ]);
    expect(lines.reduce((s, l) => s + l.lineTotal, 0)).toBe(couponQuoteBasis(items));
  });
});
