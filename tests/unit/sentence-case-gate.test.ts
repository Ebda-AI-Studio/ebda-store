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
    for (const m of src.matchAll(/\bt\(\s*'([^'\n]+)'\s*,/g)) {
      if (titleCaseWords(m[1]).length) bad.push(m[1]);
    }
    expect(bad).toEqual([]);
  });
});
