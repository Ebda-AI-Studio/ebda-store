/**
 * Guards that keep a parity run honest about the PAYMENT path.
 *
 * Two sides that are equally broken diff clean. The 2026-10-03 run reported 16/16 PASS while
 * every `/payments/create` answered 404 (the app role could not read the order under strict
 * RLS), because both sides returned the same 404. So a scenario cannot PASS unless the payment
 * endpoints it drives really answered:
 *
 *  - ANY step on a payment route (`/payments*`, `/webhooks/payment*`) that answered 404 is an
 *    error, wherever it is in the scenario;
 *  - every expectation the scenario declared (`ctx.expect(step, [codes])`) must be met: the
 *    step ran, and every run of it answered one of the codes.
 *
 * Returns the list of problems; empty means the payment path was exercised for real.
 */
export function paymentEndpointProblems(steps, expectations = []) {
  const dead = steps
    .filter(
      s =>
        s.status === 404 &&
        (s.path.startsWith('/payments') || s.path.startsWith('/webhooks/payment'))
    )
    .map(s => `payment endpoint answered 404: ${s.method} ${s.path} (${s.step})`);
  const unmet = expectations.flatMap(e => {
    const ran = steps.filter(s => s.step === e.name);
    if (ran.length === 0) return [`${e.name}: never ran`];
    return ran
      .filter(s => !e.codes.includes(s.status))
      .map(s => `${e.name}: HTTP ${s.status}, expected ${e.codes.join('/')}`);
  });
  return [...dead, ...unmet];
}
