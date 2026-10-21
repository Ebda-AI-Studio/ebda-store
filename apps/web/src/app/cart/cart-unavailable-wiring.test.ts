/**
 * #1766 — wiring that no DOM render in this repo can reach (CartClient and
 * CheckoutClient need the full provider tree). Pinned on source, the same way
 * Ruling M3-4 pins CheckoutClient's refusal wiring; each assertion was
 * mutation-checked against the pre-fix file. The behaviour itself is proven
 * on real values in cart-lines.test.ts and the per-theme render test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cart = readFileSync(join(__dirname, 'CartClient.tsx'), 'utf8');
const checkout = readFileSync(join(__dirname, '../checkout/CheckoutClient.tsx'), 'utf8');

describe('#1766 cart page wiring', () => {
  it('forwards the flag to the theme CartTable', () => {
    expect(cart).toMatch(/unavailable: item\.unavailable,/);
  });
  it('marks the line in the default (no-theme) list and disables its steppers', () => {
    expect(cart).toContain('{item.unavailable && <CartLineUnavailableNotice />}');
    expect(cart).toContain('disabled={item.unavailable || item.quantity <= 1}');
    expect(cart).toContain('disabled={item.unavailable || item.quantity >= 10}');
  });
  it('names the unavailable lines in a page-level alert', () => {
    expect(cart).toContain('data-cart-unavailable-banner');
    expect(cart).toMatch(/productUnavailableCopy\(\s*t,\s*unavailableItems\.length/);
  });
});

describe('#1766 checkout wiring', () => {
  it('keeps unavailable lines out of the summary it totals', () => {
    expect(checkout).toMatch(/cartContextItems\s*\.filter\(item => !item\.unavailable\)/);
  });
  it('refetches the cart on PRODUCT_NO_LONGER_AVAILABLE so /cart shows the marks', () => {
    expect(checkout).toMatch(/void refetchCart\(\)\.catch/);
  });
});

describe('#2117 /cart enforces the banner: checkout CTAs are gated on unavailable lines', () => {
  it('both CTA sites (theme summary + default list) read the combined gate', () => {
    expect(cart).toMatch(
      /const checkoutBlocked = belowMinimumOrder \|\| hasUnavailableLines(?: \|\| !!moqMessage)?;/
    );
    expect(cart).toMatch(/ctaDisabled=\{checkoutBlocked\}/);
    expect(cart).toMatch(/ctaBlockedMessage=\{checkoutBlockedMessage\}/);
    expect(cart).toMatch(/\{checkoutBlocked \? \(\s*<Button/);
    // No CTA site may still gate on the minimum order alone.
    expect(cart).not.toMatch(/ctaDisabled=\{belowMinimumOrder\}/);
    expect(cart).not.toMatch(/\{belowMinimumOrder \? \(/);
  });
});

describe('#2116/#2117 checkout names unavailable lines instead of hiding them', () => {
  it('derives the notice from the UNFILTERED cart lines', () => {
    expect(checkout).toMatch(
      /const unavailableCartItems = cartContextItems\.filter\(item => item\.unavailable\);/
    );
  });
  it('an all-unavailable cart gets its own state, checked BEFORE the empty-cart screen', () => {
    const own = checkout.indexOf('data-checkout-nothing-orderable');
    const empty = checkout.indexOf("t('Your cart is empty'");
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(empty);
  });
  it('renders a banner on the checkout form and blocks submit while any remain', () => {
    expect(checkout).toContain('data-checkout-unavailable-banner');
    const submit = checkout.slice(checkout.indexOf('const handleSubmit = async'));
    const guard = submit.slice(0, submit.indexOf('if (step === 1)'));
    expect(guard).toMatch(
      /if \(unavailableLinesNotice\) \{\s*setCheckoutError\(unavailableLinesNotice\);\s*return;/
    );
  });
});
