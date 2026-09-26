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
