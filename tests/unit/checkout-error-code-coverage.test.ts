/**
 * Every error code the checkout can receive — from order creation AND from the
 * payment call that follows it (#1826) — is answered with advice that can
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
const PAYMENT_ROUTES = path.join(ROOT, 'apps/api/src/routes/payment.routes.ts');
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
 * The SECOND server call the checkout makes: `POST /payments/create` (#1826).
 *
 * `handleSubmit` creates the order and then asks for a payment. The order leg
 * was the only one enumerated, so the payment leg's refusals —
 * `ORDER_ALREADY_PAID` among them — all fell to "please try again", whose
 * retry re-enters `handleSubmit` from the top and creates the order again.
 * The handler answers with inline `code: '…'` bodies as well as AppErrors, so
 * both shapes are read; bounded to the `/create` route. `PAYMENT_FAILED` is the
 * code the checkout synthesizes itself when the answer carries neither `cod`
 * nor a `paymentUrl`, so it is added when the client still does that.
 */
function codesFromPaymentCreate(): string[] {
  const src = fs.readFileSync(PAYMENT_ROUTES, 'utf-8');
  const start = src.indexOf("'/create',");
  expect(start, 'POST /payments/create not found — this gate is measuring nothing').toBeGreaterThan(
    -1
  );
  const rest = src.slice(start);
  const next = rest.indexOf('\nrouter.', 1);
  const body = next === -1 ? rest : rest.slice(0, next);
  const inline = [...body.matchAll(/code:\s*'([A-Z_]+)'/g)].map(m => m[1]);
  const thrown = [...body.matchAll(/new AppError\(\s*\d+,\s*'([A-Z_]+)'/g)].map(m => m[1]);
  // The fallback code for a failed payment call is synthesized client-side —
  // inline in CheckoutClient originally, in checkout/_lib/paymentResult.ts
  // since #1990 moved the result handling there. Read both.
  const checkout =
    fs.readFileSync(CHECKOUT, 'utf-8') +
    fs.readFileSync(path.resolve(path.dirname(CHECKOUT), '_lib/paymentResult.ts'), 'utf-8');
  const synthesized = /(?:paymentResult|result)\.error\?\.code \|\| 'PAYMENT_FAILED'/.test(checkout)
    ? ['PAYMENT_FAILED']
    : [];
  return [...new Set([...inline, ...thrown, ...synthesized])];
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
  const bundleCodes = callsBundleHandler ? unconditionallyAnsweredBundleCodes(bundleSrc) : [];

  // Pre-switch handlers in checkout/_lib/checkoutErrors.ts that own one code
  // (`if (code !== 'X') return null;` and copy for every other path), counted
  // only when CheckoutClient actually calls them.
  const libSrc = fs.readFileSync(
    path.resolve(path.dirname(CHECKOUT), '_lib/checkoutErrors.ts'),
    'utf-8'
  );
  const libCodes = [
    ...libSrc.matchAll(
      /export function (\w+)\([^)]*\)[^{]*\{\s*if \(code !== '([A-Z_]+)'\) return null;/g
    ),
  ]
    .filter(m => src.includes(`${m[1]}(`))
    .map(m => m[2]);

  return new Set([...cases, ...viaConstant, ...bundleCodes, ...libCodes]);
}

/**
 * Bundle-handler codes whose `if (code === '...') { ... }` branch ALWAYS
 * returns copy — never `null` (#1827).
 *
 * A blind `code === 'X'` regex over checkout-bundle-errors.ts double-counted
 * `INSUFFICIENT_INVENTORY`: that branch returns `null` when the failure
 * message doesn't name a bundle component (a PLAIN PRODUCT stock failure),
 * so the code is answered only if the checkout's OWN switch also has a case
 * for it — crediting the bundle handler alone hides the exact regression
 * this gate exists to catch: delete CheckoutClient's `case
 * 'INSUFFICIENT_INVENTORY'` and this test would still pass while shoppers
 * hitting a plain out-of-stock item got the generic "Something went wrong".
 */
function unconditionallyAnsweredBundleCodes(bundleSrc: string): string[] {
  const codes: string[] = [];
  for (const m of bundleSrc.matchAll(/if \(code === '([A-Z_]+)'\) \{/g)) {
    const blockStart = m.index! + m[0].length;
    let depth = 1;
    let i = blockStart;
    for (; i < bundleSrc.length && depth > 0; i++) {
      if (bundleSrc[i] === '{') depth++;
      else if (bundleSrc[i] === '}') depth--;
    }
    const block = bundleSrc.slice(blockStart, i - 1);
    if (!/return null;/.test(block)) codes.push(m[1]);
  }
  return codes;
}

/**
 * Codes that may fall to the generic message, with the reason.
 *
 * A code belongs here only when "please try again" is HONEST advice — i.e. the
 * failure is transient, or the customer genuinely has no specific action.
 * "I did not write copy for it yet" is not a reason.
 */
const DELIBERATELY_GENERIC: Record<string, string> = {
  QUOTE_NOT_ON_DO:
    'a quote for a store served by its Durable Object (Ruling CF-ORDERS-1): unreachable while every store stays on Postgres (the cutover gate forbids a flip until the engine can quote); remove this entry when the quote is ported',
  // Payment leg (#1826). Both leave the order PENDING — no compensating
  // rollback runs for them — and a retry creates a fresh order that can
  // succeed. The stranded pending order holds its stock until
  // `order-auto-cancel-unpaid` releases it (Ruling M5-4 records why the
  // checkout does not reuse the order id instead).
  NOT_FOUND:
    'the order is not visible to the payment call — only when the auth state changed between the two calls, so a retry (which re-creates the order under the current auth) makes both calls agree',
  PAYMENT_FAILED:
    'the gateway accepted the request but returned no payment URL — transient on the provider side, and a retry mints a new invoice',
};

describe('checkout answers every code the payment call can return (#1826)', () => {
  it('maps them, or names them as deliberately generic', () => {
    const mapped = codesMappedInCheckout();
    const unanswered = codesFromPaymentCreate().filter(
      code => !mapped.has(code) && !(code in DELIBERATELY_GENERIC)
    );
    expect(
      unanswered,
      'these payment-leg codes reach the shopper as "please try again", and that retry creates the order a second time. Add a `case`, or list the code in DELIBERATELY_GENERIC with the reason a retry is honest for it.'
    ).toEqual([]);
  });

  it('finds the payment leg codes — the extractor is not silently empty', () => {
    const codes = codesFromPaymentCreate();
    expect(codes).toContain('ORDER_ALREADY_PAID');
    expect(codes).toContain('COD_NOT_AVAILABLE');
    expect(codes).toContain('PAYMENT_FAILED');
  });

  it('ORDER_ALREADY_PAID is answered — paying twice is the one outcome a retry must not invite', () => {
    expect(codesMappedInCheckout().has('ORDER_ALREADY_PAID')).toBe(true);
    expect('ORDER_ALREADY_PAID' in DELIBERATELY_GENERIC).toBe(false);
  });
});

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
    // B0 Task 5: answered by the pre-switch personalisationRequiredCopy handler.
    expect(mapped.has('PERSONALISATION_REQUIRED')).toBe(true);
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
