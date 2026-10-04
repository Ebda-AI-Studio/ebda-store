/**
 * The buy-flow parity harness must not be able to PASS on a payment path that never ran.
 *
 * On 2026-10-03 it reported 16/16 PASS while every `POST /payments/create` answered 404: the app
 * role could not read the order under strict RLS, and both sides were equally broken, so they
 * diffed clean. `paymentEndpointProblems` is what now turns that into an ERROR.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM script, no type declarations
import { paymentEndpointProblems } from '../../scripts/buy-flow-parity/lib/guards.mjs';

const step = (name: string, method: string, path: string, status: number) => ({
  step: name,
  method,
  path,
  status,
});

describe('paymentEndpointProblems', () => {
  const ok = [
    step('checkout.payments-config', 'GET', '/payments/config', 200),
    step('checkout.create-payment', 'POST', '/payments/create', 200),
  ];
  const expectations = [
    { name: 'checkout.payments-config', codes: [200] },
    { name: 'checkout.create-payment', codes: [200] },
  ];

  it('is empty when the payment endpoints really answered', () => {
    expect(paymentEndpointProblems(ok, expectations)).toEqual([]);
  });

  it('a payment call that 404s is an error, even when both sides would 404 identically', () => {
    const steps = [
      step('checkout.payments-config', 'GET', '/payments/config', 200),
      step('checkout.create-payment', 'POST', '/payments/create', 404),
    ];
    const problems = paymentEndpointProblems(steps, expectations);
    expect(problems.join('\n')).toContain('payment endpoint answered 404: POST /payments/create');
    expect(problems.join('\n')).toContain('checkout.create-payment: HTTP 404, expected 200');
  });

  it('a webhook route that 404s is an error', () => {
    expect(
      paymentEndpointProblems([
        step('gateway.webhook', 'POST', '/webhooks/payment/paymob?hmac=x', 404),
      ])
    ).toHaveLength(1);
  });

  it('a 404 elsewhere (an unknown product, say) is not a payment problem', () => {
    expect(paymentEndpointProblems([step('x', 'GET', '/public/products/nope', 404)])).toEqual([]);
  });

  it('an expected step that never ran is an error', () => {
    expect(paymentEndpointProblems([ok[0]], expectations)).toEqual([
      'checkout.create-payment: never ran',
    ]);
  });

  it('an expectation lists the codes it accepts: a gateway refusal may be a 502 but never a 200', () => {
    const refusal = [step('checkout.create-payment', 'POST', '/payments/create', 502)];
    expect(
      paymentEndpointProblems(refusal, [{ name: 'checkout.create-payment', codes: [502, 503] }])
    ).toEqual([]);
    const wrong = [step('checkout.create-payment', 'POST', '/payments/create', 200)];
    expect(
      paymentEndpointProblems(wrong, [{ name: 'checkout.create-payment', codes: [502, 503] }])
    ).toHaveLength(1);
  });
});
