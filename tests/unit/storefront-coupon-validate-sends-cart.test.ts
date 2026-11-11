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
import ts from 'typescript';
import { calleeText, callsIn, parseFile, prop, strVal } from './helpers/ast-statements';
import { couponQuoteBasis, couponQuoteCartItems } from '@web/lib/coupon-quote-basis';

const CALLERS = [
  'apps/web/src/app/cart/CartClient.tsx',
  'apps/web/src/app/checkout/CheckoutClient.tsx',
];

/**
 * The request-body object literal of each `coupons/validate` post in a source file, read off the
 * parsed call (first argument is the route template, second the body), not a text window.
 */
function validateCalls(file: string): ts.ObjectLiteralExpression[] {
  const sf = parseFile(file);
  return callsIn(sf)
    .filter(c => {
      const u = c.arguments[0];
      return (
        !!u &&
        ((ts.isTemplateExpression(u) &&
          u.templateSpans.at(-1)!.literal.text === '/coupons/validate') ||
          strVal(u)?.endsWith('/coupons/validate') === true)
      );
    })
    .map(c => {
      const body = c.arguments[1];
      expect(body && ts.isObjectLiteralExpression(body), `${file}: body is an object literal`).toBe(
        true
      );
      return body as ts.ObjectLiteralExpression;
    });
}

const initOf = (o: ts.ObjectLiteralExpression, name: string) => {
  const p = prop(o, name);
  return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
};

describe('storefront coupon validate callers', () => {
  it('finds all three callers (a moved call must not silently shrink the gate)', () => {
    expect(CALLERS.flatMap(validateCalls)).toHaveLength(3);
  });

  it.each(CALLERS)('%s sends the cart lines on every validate call', file => {
    for (const body of validateCalls(file)) {
      const v = initOf(body, 'cartItems');
      expect(v && ts.isCallExpression(v) && calleeText(v)).toBe('couponQuoteCartItems');
    }
  });

  it('checkout also sends the typed identity, so group/first-order are judged as at order time', () => {
    const [body] = validateCalls('apps/web/src/app/checkout/CheckoutClient.tsx');
    expect(prop(body!, 'phone')).toBeTruthy();
    expect(prop(body!, 'email')).toBeTruthy();
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
