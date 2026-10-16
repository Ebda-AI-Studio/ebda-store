/**
 * IA-16 (independent audit): at 1280 "You Might Also Like", "Shopping Cart" and
 * "Need Help?" sat beside "New in" and "Shop by category". English UI copy on the
 * purchase path (the manifest files plus the PDP and the recommendation rows) is
 * sentence case: only the first word and proper nouns are capitalised.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '../../apps/web/src');
const manifest = JSON.parse(
  readFileSync(join(__dirname, '../../docs/ebda/templates/purchase-path.json'), 'utf8')
) as { files: string[] };
const FILES = [
  ...manifest.files,
  'app/products/[slug]/ProductDetailClient.tsx',
  'components/YouMightAlsoLike.tsx',
  'components/CartRecommendations.tsx',
  'components/FrequentlyBoughtTogether.tsx',
];
/** Proper nouns and acronyms that keep their capital mid-phrase. */
const PROPER =
  /^(InstaPay|WhatsApp|Fawry|Paymob|Kashier|Visa|Mastercard|Meeza|Vodafone|Cash|Apple|Google|Pay|COD|SKU|EGP|ID|OK|Egypt|Egyptian|Cairo)$/;

/** Words capitalised mid-sentence (each sentence checked on its own). */
export function titleCaseWords(s: string): string[] {
  return s.split(/(?<=[.?!:—])\s+/).flatMap(sentence =>
    sentence
      .split(/\s+/)
      .slice(1)
      .filter(w => /^[A-Z][a-z]/.test(w) && !PROPER.test(w.replace(/[^A-Za-z]/g, '')))
  );
}

describe('sentence case on the purchase path', () => {
  it('the checker flags title case and spares proper nouns', () => {
    expect(titleCaseWords('You Might Also Like')).toEqual(['Might', 'Also', 'Like']);
    expect(titleCaseWords('Pay with InstaPay')).toEqual([]);
    expect(titleCaseWords('New in')).toEqual([]);
    expect(titleCaseWords('Your cart is empty. Please add items.')).toEqual([]);
  });

  it.each(FILES)('%s', f => {
    const src = readFileSync(join(WEB, f), 'utf8');
    const bad: string[] = [];
    // t('English', ...) calls and literal English title props (title="You might also like").
    for (const m of src.matchAll(/\bt\(\s*'([^'\n]+)'\s*,|\btitle="([^"\n]+)"/g)) {
      const en = m[1] ?? m[2];
      if (titleCaseWords(en).length) bad.push(en);
    }
    expect(bad).toEqual([]);
  });
});

// VT-c (independent audit): "قد يعجبك أيضاً" sat 32px inside the page gutter at 390: the
// carousel brings its own px-4/6/8 gutter inside the PDP container's identical one.
describe('related row keeps the page gutter (VT-c)', () => {
  it('YouMightAlsoLike cancels the PDP container gutter the carousel repeats', () => {
    const src = readFileSync(join(WEB, 'components/YouMightAlsoLike.tsx'), 'utf8');
    const pdp = readFileSync(join(WEB, 'app/products/[slug]/ProductDetailClient.tsx'), 'utf8');
    const carousel = readFileSync(join(WEB, 'templates/shared/ProductCarousel.tsx'), 'utf8');
    expect(pdp).toContain('mx-auto max-w-7xl px-4 sm:px-6 lg:px-8');
    expect(carousel).toContain('<section className="px-4 sm:px-6 lg:px-8"');
    expect(src).toMatch(/<div className="mt-16 -mx-4 sm:-mx-6 lg:-mx-8">\s*\{\/\*/);
  });
});

// Taste re-audit P2-7: "Our Story" (the story block's default heading), "Secure Checkout" (the
// checkout chip's default) and "Promo code" in the cart vs "Coupon code" at checkout.
describe('defaults are sentence case and one thing has one name (P2-7)', () => {
  it('story heading and checkout chip defaults', () => {
    expect(readFileSync(join(WEB, 'templates/shared/BrandStoryBlock.tsx'), 'utf8')).toContain(
      "headingEn = 'Our story'"
    );
    expect(readFileSync(join(WEB, 'app/checkout/CheckoutClient.tsx'), 'utf8')).toContain(
      "?? 'Secure checkout'"
    );
  });
  it('the cart and checkout both say Coupon code', () => {
    const cart = readFileSync(join(WEB, 'app/cart/CartClient.tsx'), 'utf8');
    expect(cart).not.toMatch(/'Promo code'/);
    expect(cart).toMatch(/'Coupon code'/);
  });
});
