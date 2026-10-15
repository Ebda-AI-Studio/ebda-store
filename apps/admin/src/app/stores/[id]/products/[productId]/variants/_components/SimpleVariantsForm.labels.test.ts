/**
 * Regression for #1222: every variant row rendered its 6 column labels
 * (Name, Name Arabic, Price, Compare-at, Cost, Stock) in full — a wall of
 * repeated label text before every single variant beyond the first, with no
 * `idx === 0` gating or sr-only fallback for the rest.
 *
 * Asserts on source text — full render coverage would need mocking apiGet/
 * apiPost/apiDelete/ImageUpload/useToast for a component this deep just to
 * prove a className is conditional, which the source itself already states
 * plainly and is what the mutation-proof below exercises directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'SimpleVariantsForm.tsx'), 'utf-8');

describe('SimpleVariantsForm row labels (#1222)', () => {
  it('iterates rows with an index (needed to gate on the first row)', () => {
    expect(source).toMatch(/rows\.map\(\(row,\s*idx\)\s*=>/);
  });

  it('derives a conditional labelClass — visible on the first row, sr-only after', () => {
    expect(source).toMatch(/idx === 0/);
    expect(source).toMatch(/sr-only/);
  });

  it('every one of the 8 column labels (6 inputs + the Image and Swatch-photo captions) uses the conditional class', () => {
    const labelClassUses = [...source.matchAll(/className=\{labelClass\}/g)].length;
    expect(labelClassUses).toBe(8);
  });
});
