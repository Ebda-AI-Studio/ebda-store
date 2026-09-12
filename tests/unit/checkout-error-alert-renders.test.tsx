/**
 * The checkout failure banner RENDERS — which is the assertion the previous
 * round of this work did not make, and the reason a real defect got through.
 *
 * `setStep(1)` unmounts `PaymentStep`, and `PaymentStep` used to own the only
 * `checkoutError` renderer. So a case that set step 1 AND set an error message
 * showed the customer NOTHING: back to the shipping form, no explanation,
 * "Continue to Payment" reproducing it forever. `VALIDATION_ERROR` had that
 * shape already, and the new `PRODUCT_NO_LONGER_AVAILABLE` case would have
 * joined it — on what is now a routine path, since checkout refuses
 * soft-deleted products and carts live for days.
 *
 * My own test for that case asserted the source text contained
 * `case PRODUCT_NO_LONGER_AVAILABLE`. That proves the characters are present.
 * It cannot notice that the message is never painted. Hence this file:
 * `react-dom/server` markup, asserted on.
 *
 * No jsdom/testing-library in this repo (vitest env = 'node'), so the alert
 * was extracted as a pure function of its props — which is also what makes it
 * renderable on both steps.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Identity translator so assertions read the English source strings.
vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', t: (en: string) => en }),
}));

import { CheckoutErrorAlert } from '@web/app/checkout/CheckoutErrorAlert';

const render = (props: { message: string | null; onClear?: () => void }) =>
  renderToStaticMarkup(
    <CheckoutErrorAlert message={props.message} onClear={props.onClear ?? (() => {})} />
  );

describe('CheckoutErrorAlert', () => {
  it('renders the message', () => {
    const html = render({ message: 'An item in your cart is no longer sold.' });
    expect(html).toContain('An item in your cart is no longer sold.');
  });

  it('is an accessible alert, so a screen reader announces it', () => {
    expect(render({ message: 'x' })).toContain('role="alert"');
  });

  it('renders NOTHING when there is no error — no empty banner on a clean load', () => {
    expect(render({ message: null })).toBe('');
  });

  it('carries dir="auto" so an Arabic message is not reversed', () => {
    expect(render({ message: 'مرحبا' })).toContain('dir="auto"');
  });

  it('offers a dismiss control', () => {
    expect(render({ message: 'x' })).toContain('aria-label="Dismiss"');
  });
});

describe('the banner is reachable from BOTH checkout steps', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const R = join(__dirname, '../..');
  const client = readFileSync(join(R, 'apps/web/src/app/checkout/CheckoutClient.tsx'), 'utf8');
  const payment = readFileSync(join(R, 'apps/web/src/app/checkout/PaymentStep.tsx'), 'utf8');

  it('CheckoutClient renders it OUTSIDE the step-2 branch', () => {
    const alertAt = client.indexOf('<CheckoutErrorAlert');
    const step2At = client.indexOf('{step === 2 && (');
    expect(alertAt, '<CheckoutErrorAlert> not rendered').toBeGreaterThan(-1);
    // Rendered before the step-2 block means it is not gated on it.
    expect(alertAt).toBeLessThan(step2At);
  });

  it('PaymentStep no longer owns the only renderer', () => {
    // If the banner moves back inside PaymentStep, every setStep(1) case goes
    // silent again — which is exactly the bug this replaced.
    expect(payment).not.toMatch(/\{checkoutError && \(/);
  });

  it('the setStep(1) cases that were invisible now have a renderer', () => {
    // Both of these set step 1 and then set an error message.
    expect(client).toMatch(/case 'VALIDATION_ERROR':/);
    expect(client).toMatch(/case PRODUCT_NO_LONGER_AVAILABLE/);
    expect(client).toMatch(/<CheckoutErrorAlert/);
  });
});
