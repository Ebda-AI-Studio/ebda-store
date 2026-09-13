/**
 * Every error code the checkout can receive is answered with advice that can
 * work.
 *
 * THE RECURRING DEFECT
 *
 * `CheckoutClient` switches on the API's error code and falls to a `default`
 * that says "Something went wrong while processing your order. Please try again
 * or contact support if the problem persists." For a TRANSIENT failure that is
 * right. For a deterministic refusal it is a dead end: the customer retries,
 * the server refuses identically, and nothing tells them which action recovers
 * them.
 *
 * This has now happened three times, each time the same way — the API gained a
 * code and the switch did not:
 *
 *   - `PRODUCT_NO_LONGER_AVAILABLE` (#1408), added when the checkout lookup was
 *     scoped to `deletedAt: null`, which turned a near-dead guard into a
 *     routine refusal.
 *   - `COUPON_NOT_ELIGIBLE` (#1369), reached for the first time by
 *     free-shipping coupons — and worse than unmapped, because the coupon
 *     stayed applied and in sessionStorage, so every retry and every reload
 *     rebuilt the identical failing payload.
 *   - and the original opaque Prisma error the first of those replaced.
 *
 * Three reports of one mechanism is a class, not a coincidence. Nothing made
 * the class visible: each fix mapped its own code and left the next one to be
 * found by a customer.
 *
 * WHAT THIS ASSERTS
 *
 * The codes `OrderService.create` can throw, derived from the source rather
 * than from a list someone maintains by hand, are each either mapped in the
 * switch or named below as deliberately generic. Adding a `throw new
 * AppError(4xx, 'SOMETHING_NEW', …)` to the checkout create path fails this
 * test until someone decides which it is.
 *
 * This is an ENUMERATION gate, and it says so: it proves the case EXISTS, not
 * that it renders. What the copy actually says is asserted in
 * `apps/web/src/lib/product-cart-errors.test.ts`, and that the message
 * survives the step change is asserted in
 * `tests/unit/checkout-error-alert-renders.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const ORDER_SERVICE = path.join(ROOT, 'apps/api/src/services/order.service.ts');
const CHECKOUT = path.join(ROOT, 'apps/web/src/app/checkout/CheckoutClient.tsx');

/**
 * `OrderService.create` — the method the storefront checkout calls. Bounded at
 * the next `static async`, so codes thrown by `createAdminOrder` (`NO_ITEMS`,
 * `PRODUCT_NOT_FOUND`) are correctly out of scope: that method has no
 * storefront caller, and pretending the checkout must answer it would make
 * this gate lie in the other direction.
 */
function codesThrownByOrderCreate(): string[] {
  const src = fs.readFileSync(ORDER_SERVICE, 'utf-8');
  const start = src.indexOf('static async create(');
  expect(start, 'OrderService.create not found — this gate is measuring nothing').toBeGreaterThan(
    -1
  );
  const rest = src.slice(start + 1);
  const nextMethod = rest.search(/\n {2}(?:static )?async [a-zA-Z]/);
  const body = nextMethod === -1 ? rest : rest.slice(0, nextMethod);
  return [...new Set([...body.matchAll(/new AppError\(\s*\d+,\s*'([A-Z_]+)'/g)].map(m => m[1]))];
}

/**
 * Codes the checkout answers — from BOTH handlers, not just the switch.
 *
 * `checkoutBundleErrorCopy` runs before the switch and returns early, so a code
 * it covers is answered even though the switch has no `case` for it. An
 * earlier version of this gate looked only at the switch and reported
 * `BUNDLE_NOT_PURCHASABLE` as unanswered — a gate failing good work, and the
 * kind of false positive that gets a gate deleted rather than fixed.
 */
function codesMappedInCheckout(): Set<string> {
  const src = fs.readFileSync(CHECKOUT, 'utf-8');
  const start = src.indexOf('switch (code)');
  expect(start, 'the checkout error switch moved — this gate is measuring nothing').toBeGreaterThan(
    -1
  );
  const body = src.slice(start, src.indexOf('\n      }', start));
  const cases = [...body.matchAll(/case '([A-Z_]+)'/g)].map(m => m[1]);
  // `PRODUCT_NO_LONGER_AVAILABLE` is matched through the imported constant, not
  // a string literal, so it would look unmapped to the regex above.
  const viaConstant = /case PRODUCT_NO_LONGER_AVAILABLE:/.test(body)
    ? ['PRODUCT_NO_LONGER_AVAILABLE']
    : [];

  // The pre-switch bundle handler, only when the checkout actually calls it.
  const bundleSrc = fs.readFileSync(
    path.join(ROOT, 'apps/web/src/lib/checkout-bundle-errors.ts'),
    'utf-8'
  );
  const callsBundleHandler = /checkoutBundleErrorCopy\(/.test(src);
  const bundleCodes = callsBundleHandler
    ? [...bundleSrc.matchAll(/code === '([A-Z_]+)'/g)].map(m => m[1])
    : [];

  return new Set([...cases, ...viaConstant, ...bundleCodes]);
}

/**
 * Codes that may fall to the generic message, with the reason.
 *
 * A code belongs here only when "please try again" is HONEST advice — i.e. the
 * failure is transient, or the customer genuinely has no specific action.
 * "I did not write copy for it yet" is not a reason.
 */
const DELIBERATELY_GENERIC: Record<string, string> = {};

describe('checkout answers every code order creation can throw', () => {
  it('maps them, or names them as deliberately generic', () => {
    const mapped = codesMappedInCheckout();
    const unanswered = codesThrownByOrderCreate().filter(
      code => !mapped.has(code) && !(code in DELIBERATELY_GENERIC)
    );

    expect(
      unanswered,
      'these codes reach the shopper as "Something went wrong… please try again" — advice that can never succeed for a deterministic refusal. Add a `case` with bilingual copy naming the recovering action, or list the code in DELIBERATELY_GENERIC with the reason retrying is honest for it.'
    ).toEqual([]);
  });

  it('the two codes this class was found through are mapped', () => {
    // The positive control. A parser that returned an empty set would satisfy
    // the assertion above while measuring nothing.
    const mapped = codesMappedInCheckout();
    expect(mapped.has('PRODUCT_NO_LONGER_AVAILABLE')).toBe(true);
    expect(mapped.has('COUPON_NOT_ELIGIBLE')).toBe(true);
  });

  it('actually finds codes in the service — the extractor is not silently empty', () => {
    // The other half of the positive control: if `codesThrownByOrderCreate`
    // returned [], every code would look answered forever.
    const thrown = codesThrownByOrderCreate();
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown).toContain('COUPON_NOT_ELIGIBLE');
  });

  it('does not demand answers for admin-only codes', () => {
    // `createAdminOrder` throws NO_ITEMS and PRODUCT_NOT_FOUND. They have no
    // storefront caller, so requiring checkout copy for them would be this
    // gate failing good work.
    const thrown = codesThrownByOrderCreate();
    expect(thrown).not.toContain('NO_ITEMS');
    expect(thrown).not.toContain('PRODUCT_NOT_FOUND');
  });
});
