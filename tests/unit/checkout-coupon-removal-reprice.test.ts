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
import { repriceAfterCouponRemoval } from '@web/app/checkout/_lib/repriceAfterCouponRemoval';

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

  it('re-opens the gate even when the recompute fails', async () => {
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

describe('CheckoutClient wiring (source-pinned: no DOM in this repo)', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../apps/web/src/app/checkout/CheckoutClient.tsx'),
    'utf8'
  );

  it('the COUPON_NOT_ELIGIBLE refusal awaits the removal and returns to review', () => {
    const start = src.indexOf("case 'COUPON_NOT_ELIGIBLE':");
    const body = src.slice(start, src.indexOf('break;', start));
    expect(body).toMatch(/await removeCoupon\(\);/);
    expect(body).toMatch(/setStep\(1\);/);
  });

  it('Place Order stays disabled while shipping is being repriced', () => {
    expect(src).toMatch(/isProcessing=\{isProcessing \|\| repricingShipping\}/);
  });

  it('removeCoupon goes through repriceAfterCouponRemoval', () => {
    const start = src.indexOf('const removeCoupon = async () => {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n  };', start));
    expect(body).toMatch(/await repriceAfterCouponRemoval\(/);
  });
});
