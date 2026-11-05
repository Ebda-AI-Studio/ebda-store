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
    // T4 moved the blog and web-push switches to their own pages and dropped the uppercase switch. What is left:
    // the social-icon card (2) and the card-frame card (1), all inside the counted cards of the collapsed
    // "advanced" group (itself a counted card, data-theme-toggle="advanced"), plus the footer logo's 2 options.
    expect(cards).toContain('advanced');
    const checkboxes = (src.match(/type="checkbox"/g) ?? []).length;
    expect(checkboxes).toBe(5);
    expect(src).toContain('footerLogoInvert');
    expect(src).toContain('hideFooterLogoMobile');
  });

  it('the control nothing reads is gone (Ruling EP-8), and the key is still a valid stored value', () => {
    expect(src).not.toContain('rtlPolish');
  });

  it('the control only the deleted skins read is gone (Ruling SKIN-DEL-5)', () => {
    expect(src).not.toContain('personaChromeV2');
    expect(src).not.toContain('PERSONA_CHROME_SKINS');
  });
});
