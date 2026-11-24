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
import ts from 'typescript';
import { parseSource, findAll, isStr, callsTo, props, nameOf } from './helpers/ts-ast';

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
  // AST, not a text window: only `new AppError(n, 'CODE')` NODES inside the `create` method
  // count, so a comment or string that merely mentions one cannot make a code look thrown.
  const sf = parseSource(ORDER_SERVICE);
  const create = findAll(
    sf,
    (n): n is ts.MethodDeclaration => ts.isMethodDeclaration(n) && nameOf(n) === 'create'
  )[0];
  expect(create, 'OrderService.create not found — this gate is measuring nothing').toBeDefined();
  return [...new Set(appErrorCodes(create))];
}

/** Second argument (the code) of every `new AppError(status, 'CODE', …)` under `root`. */
function appErrorCodes(root: ts.Node): string[] {
  return findAll(
    root,
    (n): n is ts.NewExpression => ts.isNewExpression(n) && n.expression.getText() === 'AppError'
  )
    .map(n => n.arguments?.[1])
    .filter(isStr)
    .map(a => a.text)
    .filter(c => /^[A-Z_]+$/.test(c));
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
  const sf = parseSource(PAYMENT_ROUTES);
  const route = callsTo(sf, 'router.post').find(
    c => isStr(c.arguments[0]) && c.arguments[0].text === '/create'
  );
  expect(route, 'POST /payments/create not found — this gate is measuring nothing').toBeDefined();
  const inline = props(route!, 'code')
    .map(p => p.initializer)
    .filter(isStr)
    .map(i => i.text)
    .filter(c => /^[A-Z_]+$/.test(c));
  const thrown = appErrorCodes(route!);
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
  const sw = findAll(
    parseSource(CHECKOUT, src),
    (n): n is ts.SwitchStatement => ts.isSwitchStatement(n) && n.expression.getText() === 'code'
  )[0];
  expect(sw, 'the checkout error switch moved — this gate is measuring nothing').toBeDefined();
  const clauses = sw.caseBlock.clauses.filter(ts.isCaseClause).map(c => c.expression);
  const cases = clauses.filter(isStr).map(c => c.text);
  // `PRODUCT_NO_LONGER_AVAILABLE` is matched through the imported constant, not
  // a string literal, so it would look unmapped to the string-literal filter above.
  const viaConstant = clauses.some(
    c => ts.isIdentifier(c) && c.text === 'PRODUCT_NO_LONGER_AVAILABLE'
  )
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
  const libSf = parseSource(path.resolve(path.dirname(CHECKOUT), '_lib/checkoutErrors.ts'));
  const isReturnNull = (n: ts.Statement) =>
    ts.isReturnStatement(n) && n.expression?.kind === ts.SyntaxKind.NullKeyword;
  const libCodes = findAll(libSf, ts.isFunctionDeclaration)
    .map(fn => {
      const first = fn.body?.statements[0];
      const cond = first && ts.isIfStatement(first) ? first.expression : undefined;
      if (!first || !cond || !ts.isIfStatement(first)) return null;
      if (!ts.isBinaryExpression(cond) || cond.left.getText() !== 'code' || !isStr(cond.right))
        return null;
      if (cond.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return null;
      if (!isReturnNull(first.thenStatement)) return null;
      return fn.name && src.includes(`${fn.name.text}(`) ? cond.right.text : null;
    })
    .filter((c): c is string => c !== null);

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
  // AST: an `if (code === 'X') { … }` whose block holds no `return null` statement.
  const sf = parseSource('checkout-bundle-errors.ts', bundleSrc);
  const codes: string[] = [];
  for (const stmt of findAll(sf, ts.isIfStatement)) {
    const c = stmt.expression;
    if (
      !(ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
    )
      continue;
    if (c.left.getText() !== 'code' || !isStr(c.right) || !ts.isBlock(stmt.thenStatement)) continue;
    const returnsNull = findAll(stmt.thenStatement, (n): n is ts.ReturnStatement =>
      ts.isReturnStatement(n)
    ).some(r => r.expression?.kind === ts.SyntaxKind.NullKeyword);
    if (!returnsNull) codes.push(c.right.text);
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
  // Ruling T01-SHIP-1: the shipping-fee lookup failed (a database blip). Nothing was written, so a retry gets the real fee.
  SHIPPING_UNAVAILABLE:
    'the delivery fee could not be worked out for a moment — transient, the order was refused before any write, and a retry succeeds once the lookup answers',
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
