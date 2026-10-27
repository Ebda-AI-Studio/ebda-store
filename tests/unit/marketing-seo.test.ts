/**
 * apps/marketing SEO surface: sitemap (both locales, hreflang, ebda.app only), robots,
 * JSON-LD (parses, offers come from PLANS) and per-page metadata with a canonical.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import sitemap from '../../apps/marketing/src/app/sitemap';
import robots, { AI_CRAWLERS } from '../../apps/marketing/src/app/robots';
import { jsonLd } from '../../apps/marketing/src/lib/seo';
import { PLANS } from '../../apps/marketing/src/lib/plans';
import { SITE_PAGES, pagePath } from '../../apps/marketing/src/lib/site';

const APP = path.resolve(__dirname, '../../apps/marketing/src/app');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('sitemap', () => {
  const entries = sitemap();
  it('has every page in both locales (ar default + en)', () => {
    expect(entries).toHaveLength(SITE_PAGES.length * 2);
    const urls = entries.map(e => e.url);
    expect(urls).toContain('https://ebda.app/');
    expect(urls).toContain('https://ebda.app/en/');
    for (const p of ['legal', 'privacy', 'terms']) {
      expect(urls).toContain(`https://ebda.app/${p}/`);
      expect(urls).toContain(`https://ebda.app/en/${p}/`);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
  it('every entry carries ar, en and x-default alternates and a lastModified', () => {
    for (const e of entries) {
      expect(Object.keys(e.alternates!.languages!).sort()).toEqual(['ar', 'en', 'x-default']);
      expect(e.alternates!.languages!['x-default']).toBe(e.alternates!.languages!.ar);
      expect(e.lastModified).toBeInstanceOf(Date);
    }
  });
  it('only ebda.app marketing URLs (no admin/api/media hosts)', () => {
    const hrefs = entries.flatMap(e => [e.url, ...Object.values(e.alternates!.languages!)]);
    for (const h of hrefs) {
      const u = new URL(h as string);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('ebda.app');
    }
  });
});

describe('robots', () => {
  const r = robots();
  it('allows everything, names the AI crawlers, disallows nothing, points at the sitemap', () => {
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const agents = rules.map(x => x.userAgent);
    for (const bot of ['*', 'GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'])
      expect(agents).toContain(bot);
    expect(new Set(AI_CRAWLERS).size).toBe(AI_CRAWLERS.length); // no duplicate rule
    for (const x of rules) {
      expect(x.allow).toBe('/');
      expect(x.disallow).toBeUndefined();
    }
    expect(r.sitemap).toBe('https://ebda.app/sitemap.xml');
  });
});

describe('JSON-LD', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`${locale}: round-trips through JSON and derives offers from PLANS`, () => {
      const g = JSON.parse(JSON.stringify(jsonLd(locale)))['@graph'];
      const byType = Object.fromEntries(g.map((n: { '@type': string }) => [n['@type'], n]));
      const byId = Object.fromEntries(g.map((n: { '@id'?: string }) => [n['@id'], n]));
      // the studio is the organization / publisher; "Ebda Store" is the product brand organization
      // whose parent is the studio; the site and the app are the product
      byType.Organization = byId['https://ebda.app/#organization'];
      expect(byType.Organization.sameAs).toEqual([]);
      expect(byType.Organization.name).toBe('Ebda AI Studio');
      const brand = byId['https://ebda.app/#store'];
      expect(brand['@type']).toBe('Organization');
      expect(brand.name).toBe('Ebda Store');
      expect(brand.parentOrganization['@id']).toBe(byType.Organization['@id']);
      expect(brand.alternateName).toContain('ابدأ ستور');
      expect(brand.alternateName).toContain('Ebda Store — ابدأ ستور, by Ebda AI Studio (ebda.app)');
      expect(brand['@id']).toBe('https://ebda.app/#store');
      expect(brand.url).toBe('https://ebda.app/#store');
      expect(byType.SoftwareApplication.brand['@id']).toBe(brand['@id']);
      expect(byType.SoftwareApplication.featureList.length).toBeGreaterThan(10);
      const product = locale === 'ar' ? 'ابدأ ستور' : 'Ebda Store';
      expect(byType.WebSite.name).toBe(product);
      expect(byType.SoftwareApplication.name).toBe(product);
      expect(byType.WebSite.publisher['@id']).toBe(byType.Organization['@id']);
      expect(byType.SoftwareApplication.publisher['@id']).toBe(byType.Organization['@id']);
      expect(byType.Organization.logo).toMatch(/^https:\/\/ebda\.app\//);
      const offers = byType.SoftwareApplication.offers;
      expect(offers.map((o: { price: string }) => o.price)).toEqual(
        PLANS.map(p => (p.price!.amountMinor / 100).toFixed(2))
      );
      expect(offers.map((o: { price: string }) => o.price)).toEqual([
        '1490.00',
        '3490.00',
        '9990.00',
      ]);
      for (const o of offers) expect(o.priceCurrency).toBe('EGP');
      expect(byType.FAQPage.mainEntity.length).toBeGreaterThan(0);
      for (const q of byType.FAQPage.mainEntity) {
        expect(q.name).toBeTruthy();
        expect(q.acceptedAnswer.text).toBeTruthy();
      }
    });
  }
});

describe('every page exports metadata with a canonical', () => {
  const pages = walk(APP).filter(f => /[\\/]page\.tsx$/.test(f) && !f.includes('_not-found'));
  it('finds every page, once per locale', () => expect(pages).toHaveLength(SITE_PAGES.length * 2));
  for (const file of pages) {
    const rel = path.relative(APP, file);
    it(`${rel}`, async () => {
      const dir = path.dirname(file);
      const isEn = rel.startsWith(path.join('(en)', 'en'));
      // longest match first: 'legal/whatsapp-privacy' must not resolve to 'privacy'
      const page =
        [...SITE_PAGES].sort((a, b) => b.length - a.length).find(p => p && dir.endsWith(p)) ?? '';
      const mod = await import(file);
      // The home pages inherit metadata from their locale layout.
      const meta = mod.metadata ?? (await import(path.join(dir, 'layout.tsx'))).metadata;
      expect(meta, `${rel} must export metadata`).toBeTruthy();
      // the PRODUCT is named in the title, OG and Twitter; the studio is only the publisher. The /whatsapp page is
      // the second product (Ebda WhatsApp): its own name, brand line and OG image, never the Store's.
      const wa = page === 'whatsapp';
      const product = wa
        ? isEn
          ? 'Ebda WhatsApp'
          : 'ابدأ واتساب'
        : isEn
          ? 'Ebda Store'
          : 'ابدأ ستور';
      expect(meta.title).toContain(product);
      expect(meta.openGraph.title).not.toMatch(/Ebda AI Studio\s*$/);
      expect(meta.openGraph.title).toBe(meta.title);
      // brand disambiguation (not ebda3i.com or any other "Ebda"): the one brand line is in the OG
      // description; inner titles end in the short tail and stay SERP-length
      expect(meta.openGraph.description).toContain(
        wa
          ? 'Ebda WhatsApp — ابدأ واتساب, by Ebda AI Studio (ebda.app)'
          : 'Ebda Store — ابدأ ستور, by Ebda AI Studio (ebda.app)'
      );
      if (page) expect(meta.title.endsWith(`| ${product} (ebda.app)`)).toBe(true);
      expect(meta.title.length).toBeLessThanOrEqual(page ? 90 : 60);
      expect(meta.twitter.title).toBe(meta.title);
      expect(meta.openGraph.siteName).toBe(product);
      expect(meta.description).toBeTruthy();
      expect(meta.alternates.canonical).toBe(pagePath(isEn ? 'en' : 'ar', page));
      expect(Object.keys(meta.alternates.languages).sort()).toEqual(['ar', 'en', 'x-default']);
      expect(meta.openGraph.images[0].url).toBe(wa ? '/og-whatsapp.png' : '/og.png');
      expect(meta.twitter.card).toBe('summary_large_image');
    });
  }
});
