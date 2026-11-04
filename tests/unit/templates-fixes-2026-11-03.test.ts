import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Storefront templates audit 2026-11-03 (b): per-template fixes (rulings TPL-*). */
describe('per-template fixes', () => {
  const css = read('apps/web/src/styles/globals.css');

  it('PREMIUM-33: the Night souq hero action takes the brass primary pair', () => {
    expect(css).toMatch(
      /\[data-look='souq\.night'\] a\[data-cta='button'\],[\s\S]*?background-color: hsl\(var\(--primary\)\)/
    );
  });

  it('PREMIUM-34: Bloom card photos sit on a blush matte and multiply into it', () => {
    expect(css).toMatch(
      /\[data-look='jasmine\.bloom'\] \[data-part='card-image'\] \{[^}]*color-mix/
    );
    expect(css).toMatch(
      /\[data-look='jasmine\.bloom'\] \[data-part='card-image'\] img \{[^}]*multiply/
    );
  });

  it('PREMIUM-31: the Dahab hero below lg takes its height from its content (no fixed 44% copy block)', () => {
    const hero = read('apps/web/src/templates/dahab/Hero.tsx');
    expect(hero).not.toContain('h-[44%]');
    expect(hero).not.toContain('h-[56%]');
    expect(hero).toMatch(/const FRAME =\s*'[^']*lg:h-\[min\(84vh,760px\)\]/);
    expect(hero).not.toMatch(/const FRAME =\s*'[^']*\bh-\[min\(88svh/);
  });

  it('PREMIUM-32: the showroom gold pieces round to a 10 EGP step, not 1 EGP', () => {
    const seed = read('scripts/storedemo/seed.mjs');
    expect(seed).toMatch(/roundingStep: 1000,/);
  });

  it('PREMIUM-35: a routine-step product row is not an underlined text link', () => {
    const steps = read('apps/web/src/builder/sections/StepsSection.tsx');
    const row = steps.slice(steps.indexOf('group/row'), steps.indexOf('group/row') + 220);
    expect(row).not.toContain('underline');
  });

  it('every template hero action sits under the one Arabic-tracking reset (:lang(ar) *)', () => {
    expect(css).toMatch(/:lang\(ar\),\s*:lang\(ar\) \*\s*\{\s*letter-spacing: normal !important;/);
    // no hero action sets tracking through an inline style the reset would not beat (it is !important, so it does)
    for (const f of [
      'apps/web/src/templates/base/Hero.tsx',
      'apps/web/src/templates/dahab/Hero.tsx',
      'apps/web/src/templates/shared/HeroBanner.tsx',
    ])
      expect(read(f)).not.toMatch(/letterSpacing:\s*['"`]\d/);
  });
});
