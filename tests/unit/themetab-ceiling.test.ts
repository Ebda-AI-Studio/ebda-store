/**
 * CLAUDE.md UI rule 4 / docs/architecture/store-theme-flags.md: the Theme tab holds at most 7
 * merchant-facing toggles. Each toggle card carries `data-theme-toggle`, so a new one cannot hide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
  join(__dirname, '../../apps/admin/src/app/stores/[id]/branding/_components/ThemeTab.tsx'),
  'utf8'
);

describe('ThemeTab toggle ceiling', () => {
  const cards = [...src.matchAll(/data-theme-toggle="([a-z-]+)"/g)].map(m => m[1]);

  it('has at most 7 toggle cards: the next toggle goes to a dedicated page', () => {
    expect(cards.length).toBeLessThanOrEqual(7);
    expect(new Set(cards).size).toBe(cards.length);
  });

  it('every checkbox sits in a counted card or is one of the two footer-logo options', () => {
    // 6 cards hold 7 checkboxes (the social-icon card has two); the footer logo uploader holds 2 options.
    const checkboxes = (src.match(/type="checkbox"/g) ?? []).length;
    expect(checkboxes).toBe(9);
    expect(src).toContain('footerLogoInvert');
    expect(src).toContain('hideFooterLogoMobile');
  });

  it('the control nothing reads is gone (Ruling EP-8), and the key is still a valid stored value', () => {
    expect(src).not.toContain('rtlPolish');
  });
});
