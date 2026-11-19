/**
 * The studio's social profiles come from the foundation's EBDA.social, never retyped: the marketing footer (ar + en),
 * the support-site footer HTML and the Organization JSON-LD sameAs all render exactly that list (BRAND-IG-1).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EBDA } from '../../packages/shared/src/foundation/brand';
import { SOCIAL_SAME_AS, siteFooter, siteFooterHtml } from '../../packages/shared/src/brand';
import { studioJsonLd, jsonLd } from '../../apps/marketing/src/lib/seo';
import { Footer } from '../../apps/marketing/src/components/Footer';

const profiles = EBDA.social.accounts.filter(a => a.id !== 'whatsapp');
const CLOSED = /instagram\.com\/ebdaaistudio|ebdaai_studio/;

describe('social profiles come from EBDA.social', () => {
  it('Instagram is ebdaai.studio and the closed / third-party handles appear nowhere', () => {
    expect(SOCIAL_SAME_AS).toContain('https://www.instagram.com/ebdaai.studio/');
    expect(JSON.stringify(SOCIAL_SAME_AS)).not.toMatch(CLOSED);
    expect(SOCIAL_SAME_AS).toEqual(profiles.map(a => a.url));
  });
  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: footer data, support-site HTML and marketing footer render every profile with an aria-label`, () => {
      const f = siteFooter(lang);
      expect(f.brand.social.map(a => a.href)).toEqual(profiles.map(a => a.url));
      for (const a of f.brand.social) expect(a.ariaLabel).toContain(a.label);
      const html = siteFooterHtml(lang, '', 2026);
      const react = renderToStaticMarkup(Footer({ locale: lang }));
      for (const out of [html, react]) {
        for (const a of profiles) expect(out, `${lang} ${a.id}`).toContain(`href="${a.url}"`);
        expect(out).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"/);
        expect(out).toMatch(/aria-label="[^"]+"/);
        expect(out).not.toMatch(CLOSED);
      }
    });
    it(`${lang}: the studio and store Organization nodes carry sameAs from the same list`, () => {
      for (const ld of [studioJsonLd(lang), jsonLd(lang)]) {
        const orgs = (ld['@graph'] as { '@type': string; sameAs?: string[] }[]).filter(
          n => n.sameAs && n['@type'] === 'Organization'
        );
        expect(
          orgs.some(o => JSON.stringify(o.sameAs) === JSON.stringify(SOCIAL_SAME_AS)),
          `${lang}`
        ).toBe(true);
      }
    });
  }
});
