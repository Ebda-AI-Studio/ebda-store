import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand';

const css = readFileSync('apps/admin/src/styles/globals.css', 'utf8');
const layout = readFileSync('apps/admin/src/app/layout.tsx', 'utf8');
const shell = readFileSync('apps/admin/src/components/onboarding/PublicShell.tsx', 'utf8');

// Pin identity where inherited Ebda defaults previously survived rebranding.
describe('Ebda merchant identity', () => {
  it('uses the approved gold hue and dark button ink in both themes', () => {
    const expected = '36.4 36.03% 51.57%'; // BRAND gold converted to HSL, <0.01 channel rounding.
    expect(BRAND.colors.gold).toBe('#B08D57');
    const primary = [...css.matchAll(/--primary:\s*([^;]+);/g)].map(m => m[1]);
    expect(primary).toEqual([expected, expected]);
    expect([...css.matchAll(/--primary-foreground:\s*([^;]+);/g)].map(m => m[1])).toEqual([
      '210 9% 4.3%',
      '210 9% 4.3%',
    ]);
  });
  it('DS-FONT-1: one family (IBM Plex Sans Arabic, Arabic + Latin) is applied to the body, no Geist', () => {
    expect(layout).toContain('IBM_Plex_Sans_Arabic({');
    expect(layout).toMatch(/subsets:\s*\['arabic',\s*'latin'\]/);
    expect(layout).not.toMatch(/\bGeist\(/);
    expect(css).toMatch(/body\s*\{[^}]*font-family: var\(--font-sans\)/);
  });
  it('gives the existing skip link a destination on the public funnel', () => {
    expect(layout).toContain('href="#admin-main-content"');
    expect(shell).toContain('id="admin-main-content"');
  });
});

describe('product and operator names in merchant translations', () => {
  it('names both login wordmarks and identifies the VAT operator', () => {
    const en = JSON.parse(readFileSync('apps/admin/src/i18n/messages/en.json', 'utf8'));
    const ar = JSON.parse(readFileSync('apps/admin/src/i18n/messages/ar.json', 'utf8'));
    expect(en.components.brand.brandAlt).toBe(BRAND.product.nameEn);
    expect(ar.components.brand.brandAlt).toBe(BRAND.product.nameAr);
    expect(JSON.stringify(ar)).not.toContain('ستور ستور');
    expect(en.platformSettings.vat.legalName).toContain(BRAND.company.shortNameEn);
  });
});
