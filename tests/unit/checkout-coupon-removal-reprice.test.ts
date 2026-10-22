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

  it('Place Order stays disabled while shipping is being repriced or quoted', () => {
    expect(src).toMatch(
      /isProcessing=\{\s*isProcessing \|\| repricingShipping \|\| shippingQuotePending \|\| quotePending\s*\}/
    );
  });

  it('a failed or pending quote blocks submit and both Continue buttons (#2067)', () => {
    const submit = src.slice(src.indexOf('const handleSubmit = async'));
    const guard = submit.slice(0, submit.indexOf('if (step === 1)'));
    expect(guard).toMatch(/if \(!shippingSettled\) \{/);
    expect(guard).toMatch(/setStep\(1\)/);
    expect(
      src.match(
        /disabled=\{\s*shippingUnavailable \|\|\s*belowMinimumOrder \|\|\s*goldPriceChanged \|\|\s*!shippingSettled\s*\}/g
      )
    ).toHaveLength(2);
    expect(src).toMatch(/quotePending: shippingQuotePending,\s*repricing: repricingShipping/);
  });

  it('calculateShipping reports a failed quote and drops superseded answers', () => {
    const start = src.indexOf('const calculateShipping = useCallback(async (): Promise<boolean>');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}, [selectedArea', start));
    expect(body).toMatch(/if \(!isLatest\(\)\) return false;/);
    expect(body).toMatch(/setShippingError\(true\);\s*return false;/);
    expect(body).toMatch(/finally \{\s*if \(isLatest\(\)\) setShippingQuotePending\(false\);/);
  });

  it('removeCoupon goes through repriceAfterCouponRemoval', () => {
    const start = src.indexOf('const removeCoupon = async () => {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n  };', start));
    expect(body).toMatch(/await repriceAfterCouponRemoval\(/);
  });
});

describe('delivery-window clock wiring (#2047/#2050, source-pinned)', () => {
  const src = readFileSync(
    path.resolve(__dirname, '../../apps/web/src/app/checkout/CheckoutClient.tsx'),
    'utf8'
  );
  it('the picker reads a ticking clock, not a once-per-mount memo', () => {
    expect(src).toMatch(/const \[nowMinutes, setNowMinutes\] = useState\(/);
    expect(src).toMatch(/setInterval\(tick, 30_000\)/);
    expect(src).not.toMatch(/const nowMinutes = useMemo\(/);
  });
  it('submit validates with findStillBookableWindow and syncs the picker on a lapse', () => {
    const submit = src.slice(src.indexOf('const handleSubmit = async'));
    expect(submit).toMatch(/const freshSelectedWindow = findStillBookableWindow\(/);
    const lapse = submit.slice(submit.indexOf('selectedDeliveryWindowId && !freshSelectedWindow'));
    const block = lapse.slice(0, lapse.indexOf('return;'));
    expect(block).toMatch(/setNowMinutes\(submitNowMinutes\)/);
    expect(block).toMatch(/setDeliveryWindowError\(lapsedWindowMessage\)/);
  });
  it('records the day the picker showed when the window was chosen', () => {
    expect(src).toMatch(/setSelectedDeliveryDay\(deliverySelection\.day\)/);
  });
});
