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
    expect([...AI_CRAWLERS]).toHaveLength(4);
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
      expect(byType.Organization.sameAs).toEqual([]);
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
  it('finds all 8 pages', () => expect(pages).toHaveLength(SITE_PAGES.length * 2));
  for (const file of pages) {
    const rel = path.relative(APP, file);
    it(`${rel}`, async () => {
      const dir = path.dirname(file);
      const isEn = rel.startsWith(path.join('(en)', 'en'));
      const page = SITE_PAGES.find(p => p && dir.endsWith(p)) ?? '';
      const mod = await import(file);
      // The home pages inherit metadata from their locale layout.
      const meta = mod.metadata ?? (await import(path.join(dir, 'layout.tsx'))).metadata;
      expect(meta, `${rel} must export metadata`).toBeTruthy();
      expect(meta.title).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.alternates.canonical).toBe(pagePath(isEn ? 'en' : 'ar', page));
      expect(Object.keys(meta.alternates.languages).sort()).toEqual(['ar', 'en', 'x-default']);
      expect(meta.openGraph.images[0].url).toBe('/og.png');
      expect(meta.twitter.card).toBe('summary_large_image');
    });
  }
});
