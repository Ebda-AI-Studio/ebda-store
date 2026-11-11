/**
 * #1807 — removing a coupon must not leave free delivery on screen while
 * Place Order is clickable.
 *
 * On a COUPON_NOT_ELIGIBLE refusal the checkout removed the coupon, fired the
 * shipping recompute WITHOUT awaiting it, and re-enabled Place Order at once.
 * A free-shipping coupon had set freeShipping=true, so for the whole
 * round-trip the summary showed free delivery; a fast retry created an order
 * charged a delivery fee the customer was never shown.
 *
 * The ordering lives in `repriceAfterCouponRemoval`, driven here with fakes.
 * The two lines that wire it into the component (the awaited call in the
 * refusal handler, and the gate on PaymentStep) cannot be rendered without a
 * DOM, which this repo does not have (Ruling P2-B2-2), so they are pinned by
 * source below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  code,
  containsCall,
  findCaseClause,
  findFunction,
  hasTopLevelReturn,
  indexOfStatement,
  isIfWithCondition,
  nodesOf,
  parseFile,
  statementsOf,
  thenStatements,
} from './helpers/ast-query';
import {
  repriceAfterCouponRemoval,
  isShippingSettled,
} from '@web/app/checkout/_lib/repriceAfterCouponRemoval';

describe('repriceAfterCouponRemoval', () => {
  it('drops free shipping at once and holds the submit gate until the fee lands', async () => {
    const log: string[] = [];
    let release!: () => void;
    const shippingLanded = new Promise<void>(r => (release = r));

    const done = repriceAfterCouponRemoval({
      setFreeShipping: v => log.push(`freeShipping=${v}`),
      setRepricing: v => log.push(`repricing=${v}`),
      calculateShipping: async () => {
        log.push('calculate:start');
        await shippingLanded;
        log.push('calculate:landed');
      },
    });

    // Before the recompute answers: free shipping is already off and the gate
    // is closed.
    await Promise.resolve();
    expect(log).toEqual(['freeShipping=false', 'repricing=true', 'calculate:start']);

    release();
    await done;
    expect(log.at(-2)).toBe('calculate:landed');
    expect(log.at(-1)).toBe('repricing=false');
  });

  it('reports a quote that resolved WITHOUT landing (the path production takes, #2067)', async () => {
    // calculateShipping never throws in production: a non-2xx answer and a
    // network error both resolve after setting shippingError. The reprice
    // must surface that, not read "resolved" as "fee landed".
    const states: boolean[] = [];
    const landed = await repriceAfterCouponRemoval({
      setFreeShipping: () => {},
      setRepricing: v => states.push(v),
      calculateShipping: async () => false,
    });
    expect(landed).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('re-opens the repricing flag even if the recompute throws', async () => {
    const states: boolean[] = [];
    await expect(
      repriceAfterCouponRemoval({
        setFreeShipping: () => {},
        setRepricing: v => states.push(v),
        calculateShipping: async () => {
          throw new Error('network');
        },
      })
    ).rejects.toThrow('network');
    expect(states).toEqual([true, false]);
  });
});

describe('isShippingSettled (#2067)', () => {
  const base = { shippingError: false, quotePending: false, repricing: false };
  it('is settled only when no quote is pending, failed or repricing', () => {
    expect(isShippingSettled(base)).toBe(true);
    expect(isShippingSettled({ ...base, shippingError: true })).toBe(false);
    expect(isShippingSettled({ ...base, quotePending: true })).toBe(false);
    expect(isShippingSettled({ ...base, repricing: true })).toBe(false);
  });
});

// CheckoutClient is a 3000-line component; this repo has no DOM to render it, so its wiring is pinned structurally:
// every check below is scoped to a real syntax node (a named function, a case clause, an if/try block) via the
// TypeScript AST, never a text window. The component's logic that CAN run (repriceAfterCouponRemoval) runs above.
const csf = parseFile(
  path.resolve(__dirname, '../../apps/web/src/app/checkout/CheckoutClient.tsx')
);
const src = readFileSync(
  path.resolve(__dirname, '../../apps/web/src/app/checkout/CheckoutClient.tsx'),
  'utf8'
);

describe('CheckoutClient wiring (source-pinned: no DOM in this repo)', () => {
  it('the COUPON_NOT_ELIGIBLE refusal awaits the removal and returns to review', () => {
    // AST: the `case 'COUPON_NOT_ELIGIBLE':` clause's own statements
    const clause = findCaseClause(csf, 'COUPON_NOT_ELIGIBLE');
    const awaited = clause.statements.some(
      s =>
        ts.isExpressionStatement(s) &&
        ts.isAwaitExpression(s.expression) &&
        code(s.expression.expression) === 'removeCoupon()'
    );
    expect(awaited, 'removeCoupon() is awaited at the top level of the case').toBe(true);
    expect(clause.statements.some(s => containsCall(s, 'setStep', '1'))).toBe(true);
  });

  it('Place Order stays disabled while shipping is being repriced or quoted', () => {
    expect(src).toMatch(
      /isProcessing=\{\s*isProcessing \|\| repricingShipping \|\| shippingQuotePending \|\| quotePending\s*\}/
    );
  });

  it('a failed or pending quote blocks submit and both Continue buttons (#2067)', () => {
    // AST: a top-level `if (!shippingSettled) { ... setStep(1) ...; return; }` BEFORE the `if (step === 1)` advance
    const sts = statementsOf(findFunction(csf, 'handleSubmit'));
    const guardAt = indexOfStatement(sts, s => isIfWithCondition(s, '!shippingSettled'));
    const advanceAt = indexOfStatement(sts, s => isIfWithCondition(s, 'step === 1'));
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(advanceAt);
    const guardIf = sts[guardAt] as ts.IfStatement;
    expect(containsCall(guardIf, 'setStep', '1')).toBe(true);
    expect(hasTopLevelReturn(thenStatements(guardIf)), 'it returns').toBe(true);
    expect(
      src.match(
        /disabled=\{\s*shippingUnavailable \|\|\s*belowMinimumOrder \|\|\s*goldPriceChanged \|\|\s*!shippingSettled\s*\}/g
      )
    ).toHaveLength(2);
    expect(src).toMatch(/quotePending: shippingQuotePending,\s*repricing: repricingShipping/);
  });

  it('calculateShipping reports a failed quote and drops superseded answers', () => {
    const fn = findFunction(csf, 'calculateShipping');
    const all = nodesOf(fn);
    // `if (!isLatest()) return false;` : a superseded answer is dropped
    expect(
      all.some(
        n =>
          ts.isIfStatement(n) &&
          code(n.expression) === '!isLatest()' &&
          code(n.thenStatement) === 'return false;'
      )
    ).toBe(true);
    // `setShippingError(true); return false;` : adjacent statements of one block (a failed quote is reported)
    expect(
      all.some(
        n =>
          ts.isBlock(n) &&
          n.statements.some(
            (s, i) =>
              containsCall(s, 'setShippingError', 'true') &&
              ts.isExpressionStatement(s) &&
              n.statements[i + 1] !== undefined &&
              code(n.statements[i + 1]) === 'return false;'
          )
      )
    ).toBe(true);
    // finally { if (isLatest()) setShippingQuotePending(false); }
    expect(
      all.some(
        n =>
          ts.isTryStatement(n) &&
          n.finallyBlock !== undefined &&
          n.finallyBlock.statements.some(
            s =>
              ts.isIfStatement(s) &&
              code(s.expression) === 'isLatest()' &&
              containsCall(s.thenStatement, 'setShippingQuotePending', 'false')
          )
      )
    ).toBe(true);
  });

  it('removeCoupon goes through repriceAfterCouponRemoval', () => {
    const fn = findFunction(csf, 'removeCoupon');
    expect(
      statementsOf(fn).some(
        s =>
          ts.isExpressionStatement(s) &&
          ts.isAwaitExpression(s.expression) &&
          ts.isCallExpression(s.expression.expression) &&
          code(s.expression.expression.expression) === 'repriceAfterCouponRemoval'
      ),
      'removeCoupon awaits repriceAfterCouponRemoval at its top level'
    ).toBe(true);
  });
});

describe('delivery-window clock wiring (#2047/#2050, source-pinned)', () => {
  it('the picker reads a ticking clock, not a once-per-mount memo', () => {
    expect(src).toMatch(/const \[nowMinutes, setNowMinutes\] = useState\(/);
    expect(src).toMatch(/setInterval\(tick, 30_000\)/);
    expect(src).not.toMatch(/const nowMinutes = useMemo\(/);
  });
  it('submit validates with findStillBookableWindow and syncs the picker on a lapse', () => {
    const sts = statementsOf(findFunction(csf, 'handleSubmit'));
    const fresh = sts.find(
      (s): s is ts.VariableStatement =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some(
          d =>
            code(d.name) === 'freshSelectedWindow' &&
            d.initializer !== undefined &&
            ts.isCallExpression(d.initializer) &&
            code(d.initializer.expression) === 'findStillBookableWindow'
        )
    );
    expect(
      fresh,
      'handleSubmit computes freshSelectedWindow with findStillBookableWindow'
    ).toBeDefined();
    // the lapse branch: `if (... selectedDeliveryWindowId && !freshSelectedWindow) { sync clock; message; return; }`
    const lapse = sts.find(
      (s): s is ts.IfStatement =>
        ts.isIfStatement(s) &&
        /selectedDeliveryWindowId && !freshSelectedWindow$/.test(code(s.expression))
    );
    expect(lapse, 'lapse branch').toBeDefined();
    const block = thenStatements(lapse!);
    expect(block.some(s => containsCall(s, 'setNowMinutes', 'submitNowMinutes'))).toBe(true);
    expect(block.some(s => containsCall(s, 'setDeliveryWindowError', 'lapsedWindowMessage'))).toBe(
      true
    );
    expect(hasTopLevelReturn(block), 'the lapse branch returns').toBe(true);
  });
  it('records the day the picker showed when the window was chosen', () => {
    expect(src).toMatch(/setSelectedDeliveryDay\(deliverySelection\.day\)/);
  });
});
