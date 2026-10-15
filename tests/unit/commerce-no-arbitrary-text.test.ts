/**
 * design.md bans `text-[Xpx]` (UI rule 7) and PRODUCT.md sets a 12px floor: Arabic at 11px
 * loses its dots on mid-range Android (F5). The B0 commerce components use the type scale
 * tokens only — no arbitrary `text-[…]` utility at all (size or colour; the receipt's fixed
 * paper ink lives in ReceiptPrinter.module.css).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../../apps/web/src/components/commerce');
const files = readdirSync(DIR).filter(f => f.endsWith('.tsx') && !f.includes('.test.'));

describe('apps/web/src/components/commerce/*.tsx', () => {
  it('has components to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });
  it.each(files)('%s uses no arbitrary text-[…] utility', f => {
    const src = readFileSync(join(DIR, f), 'utf8');
    const hits = src
      .split('\n')
      .flatMap((l, i) => (/\btext-\[/.test(l) ? [`${i + 1}: ${l.trim()}`] : []));
    expect(hits).toEqual([]);
  });
});
