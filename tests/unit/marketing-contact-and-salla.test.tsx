import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContactPage } from '../../apps/marketing/src/components/ContactPage';
import { SOCIAL_SAME_AS } from '../../packages/shared/src/brand';
import sitemap from '../../apps/marketing/src/app/sitemap';
import { COMPARE_SLUGS, SITE_PAGES } from '../../apps/marketing/src/lib/site';

const MK = path.resolve(__dirname, '../../apps/marketing');

describe('/contact (6c)', () => {
  for (const l of ['ar', 'en'] as const) {
    it(`${l}: reaches email, WhatsApp, help, status and security, with real links`, () => {
      const html = renderToStaticMarkup(<ContactPage locale={l} />);
      expect(html).toContain('mailto:ahlan@ebda.app');
      expect(html).toContain('https://wa.me/');
      expect(html).toContain('mailto:security@ebda.app');
      expect(html).toContain('/.well-known/security.txt');
      expect(html).toContain('https://help.ebda.app');
      expect(html).toContain('https://status.ebda.app');
      for (const url of SOCIAL_SAME_AS) expect(html).toContain(url);
      expect(html.match(/<h1/g)).toHaveLength(1);
    });
  }
  it('is a sitemap page in both locales and linked from the footer', () => {
    const urls = sitemap().map(e => e.url);
    expect(urls).toContain('https://ebda.app/contact/');
    expect(urls).toContain('https://ebda.app/en/contact/');
    expect(SITE_PAGES).toContain('contact');
  });
});

describe('Salla compare page is gone (Ruling MKT-COMPARE-1)', () => {
  it('no route, no slug, not in the sitemap, 301 to /features in both locales', () => {
    expect(COMPARE_SLUGS as readonly string[]).not.toContain('salla');
    expect(existsSync(path.join(MK, 'src/app/(ar)/compare/salla'))).toBe(false);
    expect(existsSync(path.join(MK, 'src/app/(en)/en/compare/salla'))).toBe(false);
    expect(sitemap().some(e => e.url.includes('salla'))).toBe(false);
    const r = readFileSync(path.join(MK, 'public/_redirects'), 'utf8');
    expect(r).toMatch(/^\/compare\/salla\/?\s+\/features\/\s+301$/m);
    expect(r).toMatch(/^\/en\/compare\/salla\/?\s+\/en\/features\/\s+301$/m);
  });
  it('llms files no longer list it', () => {
    for (const f of ['llms.txt', 'llms-full.txt'])
      expect(readFileSync(path.join(MK, 'public', f), 'utf8')).not.toMatch(/compare\/salla/);
  });
});
