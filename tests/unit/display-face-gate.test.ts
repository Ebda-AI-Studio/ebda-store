/**
 * Quality bar § 10 rule (g) (W4, VT-a): one display face per look, for display text only. Vitrine's
 * Aref Ruqaa set "الشحن إلى", "ملخص الطلب" and the product names in the order summary, because the
 * looks CSS painted EVERY h1-h3 in the display face. Now: h1/h2 and `.font-display` only, and
 * nothing inside a transactional surface (cart, checkout, receipt) below the page h1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../apps/web/src');
const css = readFileSync(path.join(WEB, 'styles/globals.css'), 'utf8');

describe('rule (g): the display face is for display text', () => {
  it('the looks rule never paints h3 in the display face', () => {
    const block = css.slice(css.indexOf('[data-look] {'), css.indexOf('/* Section rhythm'));
    expect(block).not.toMatch(/\[data-look\] h3/);
    expect(css).not.toMatch(/html\[lang='en'\] \[data-look\] h3/);
  });
  it('a transactional surface sets its sub-headings in the body face', () => {
    expect(css).toMatch(
      /html\[lang\] \[data-look\] \[data-transactional\] :is\(h2, h3, h4\)\s*\{\s*font-family: var\(--font-body/
    );
  });
  it.each([
    'app/cart/CartClient.tsx',
    'app/checkout/CheckoutClient.tsx',
    'app/checkout/success/SuccessClient.tsx',
  ])('%s marks its surface transactional', f => {
    expect(readFileSync(path.join(WEB, f), 'utf8')).toContain('data-transactional');
  });
});
