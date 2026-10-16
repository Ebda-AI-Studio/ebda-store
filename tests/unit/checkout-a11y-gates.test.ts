/**
 * W4 checkout a11y + clarity (independent a11y P2-2/6/7/8/9 and audit IA-12/13). Source gates: the
 * checkout render is a 2,000-line client component, so the rules are pinned where they live.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../apps/web/src');
const read = (f: string) => readFileSync(path.join(WEB, f), 'utf8');
const checkout = read('app/checkout/CheckoutClient.tsx');
const payment = read('app/checkout/PaymentStep.tsx');
const summary = read('app/checkout/OrderSummary.tsx');
const govArea = read('app/checkout/_components/GovernorateAreaSelect.tsx');

describe('P2-8: every checkout field is tied to its error', () => {
  it('fields pass the error to Input (aria-describedby + aria-invalid), no detached error <p>', () => {
    expect(checkout).not.toMatch(/\{formErrors\.\w+ && \(\s*<p role="alert"/);
    for (const f of ['firstName', 'lastName', 'phone', 'street', 'building'])
      expect(checkout, f).toMatch(new RegExp(`error=\\{formErrors\\.${f}\\}`));
  });
  it('Governorate and Area expose aria-invalid and aria-describedby', () => {
    expect(govArea).toMatch(/aria-invalid=/);
    expect(govArea).toMatch(/aria-describedby=/);
  });
});

describe('P2-2 / P2-7 / P2-6', () => {
  it('the checkout has an h1', () => {
    expect(checkout).toMatch(/<h1\b[^>]*data-checkout-title/);
  });
  it('the coupon field is labelled', () => {
    expect(summary).toMatch(/aria-label=\{t\('Coupon code'/);
  });
  it('checkout inputs stay 44px on desktop too', () => {
    expect(checkout).toContain('CHECKOUT_FIELD');
    expect(checkout).toMatch(/const CHECKOUT_FIELD = '[^']*sm:h-11/);
  });
});

describe('P2-9: back links use the mirrored icon, never a text arrow', () => {
  it.each([
    ['CheckoutClient', checkout],
    ['PaymentStep', payment],
  ])('%s', (_n, s) => {
    expect(s).not.toMatch(/['"`][^'"`\n]*(?:[←→]|\\u219[02])[^'"`\n]*['"`]/);
  });
});

describe('IA-12 / IA-13: marking and the confirm button', () => {
  it('no * in field labels (only optional fields are marked)', () => {
    expect(checkout).not.toMatch(/label=\{t\(\s*'[^']*\*'/);
  });
  it('the phone example is the local format the validator names (010...)', () => {
    expect(checkout).not.toContain('REGION.phone.placeholderIntl');
  });
  it('the COD confirm button carries the total', () => {
    expect(payment).toMatch(/t\('Place order', 'تأكيد الطلب'\)\} · \$\{formatPrice\(total\)\}/);
  });
});
