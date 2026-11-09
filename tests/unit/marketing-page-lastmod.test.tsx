import { describe, it, expect } from 'vitest';
import lastmod from '../../apps/marketing/src/lib/page-lastmod.json';
import sitemap from '../../apps/marketing/src/app/sitemap';
import { DATED_PAGES, pageHash } from '../../apps/marketing/src/lib/page-markup';
import {
  LEGAL_EXTRA_SLUGS,
  LEGAL_SLUGS,
  SERVICE_PAGES,
  SITE_PAGES,
} from '../../apps/marketing/src/lib/site';

/**
 * Sitemap <lastmod> is real: each dated page's recorded date belongs to a hash of its rendered markup (both
 * locales). Change a page, and this fails until `npm run lastmod -w apps/marketing` re-dates it.
 */
const REG = lastmod as Record<string, { hash: string; date: string }>;

describe('sitemap lastmod is tied to the rendered page', () => {
  it('every non-legal sitemap page is dated, and nothing else is', () => {
    const want = SITE_PAGES.filter(
      p => !([...LEGAL_SLUGS, ...LEGAL_EXTRA_SLUGS] as readonly string[]).includes(p)
    ).map(p => p || 'home');
    // the service-line pages are dated even while unpublished (SERVICES-IA-1): going live needs no lastmod re-run
    for (const p of SERVICE_PAGES) if (!want.includes(p)) want.push(p);
    expect(Object.keys(REG).sort()).toEqual([...want].sort());
    expect(DATED_PAGES.map(p => p || 'home').sort()).toEqual([...want].sort());
  });

  for (const page of DATED_PAGES) {
    const key = page || 'home';
    it(`${key}: recorded hash matches the markup (else run npm run lastmod -w apps/marketing)`, () => {
      expect(REG[key].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(pageHash(page)).toBe(REG[key].hash);
    });
  }

  it('hashing is deterministic (negative control: a different page hashes differently)', () => {
    expect(pageHash('')).toBe(pageHash(''));
    expect(pageHash('')).not.toBe(pageHash('features'));
  });

  it('the sitemap serves the recorded date for dated pages', () => {
    const home = sitemap().find(e => e.url === 'https://ebda.app/');
    expect(home?.lastModified).toEqual(new Date(REG.home.date));
  });
});
