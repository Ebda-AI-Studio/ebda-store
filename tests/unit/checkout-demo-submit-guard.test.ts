import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** Wiring test (house style for the huge CheckoutClient): the demo guard sits in handleSubmit after the step-1 advance and before any order call. */
describe('CheckoutClient.handleSubmit on a demo store', () => {
  const src = readFileSync('apps/web/src/app/checkout/CheckoutClient.tsx', 'utf8');
  const submit = src.slice(src.indexOf('const handleSubmit = async'));
  it('returns before createOrder, after step 1 may advance', () => {
    const advance = submit.indexOf('setStep(2);');
    const guard = submit.indexOf('if (store.isDemo) {');
    const order = submit.indexOf('api.createOrder(');
    expect(advance).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(advance);
    expect(order).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(order);
    expect(submit.slice(guard, guard + 260)).toContain('return;');
  });
});
