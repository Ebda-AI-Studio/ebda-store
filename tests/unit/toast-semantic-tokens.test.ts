/**
 * The cart toast's check icon and the added-to-cart button take the semantic tokens
 * (success / destructive / warning / info), never a hard-coded palette colour: a store's look can
 * restyle a token, and a palette `green-500` ignores it (Ahmad 2026-10-16: no off-palette colours).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../..');
const FILES = [
  'packages/ui/src/components/Toast/index.tsx',
  'packages/ui/src/components/AddToCartButton.tsx',
];
const PALETTE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/g;

describe('toast + add-to-cart state colours are semantic tokens', () => {
  for (const f of FILES)
    it(`${f} has no palette colour class`, () => {
      expect(readFileSync(join(ROOT, f), 'utf8').match(PALETTE) ?? []).toEqual([]);
    });

  it('the success toast uses the success token and its ink', () => {
    const src = readFileSync(join(ROOT, FILES[0]), 'utf8');
    expect(src).toContain("icon: 'text-success-ink bg-success/20'");
    expect(src).toContain("progress: 'bg-success'");
  });
});
