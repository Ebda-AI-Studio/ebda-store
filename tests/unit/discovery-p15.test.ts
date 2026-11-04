/**
 * Audit group P15 (discovery): help, docs and status carry a social card and structured data; the marketing site
 * redirects /pricing and /compare in one hop.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { renderPage } from '../../packages/site-kit/src/build/shell.mjs';
import { renderStatusPage } from '../../apps/status/src/render';
import type { Snapshot } from '../../apps/status/src/types';

const ROOT = path.resolve(__dirname, '../..');
const jsonLd = (html: string) => {
  const m = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  expect(m, 'one JSON-LD block').toHaveLength(1);
  return JSON.parse(m[0][1]) as {
    '@context': string;
    '@graph': { '@type': string; [k: string]: unknown }[];
  };
};
const meta = (html: string, key: string) =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];
const types = (html: string) => jsonLd(html)['@graph'].map(n => n['@type']);

const page = (over: Record<string, unknown> = {}) =>
  renderPage({
    lang: 'en',
    title: 'Create a store | Ebda AI Studio Help',
    description: 'How to create your first store.',
    canonical: 'https://help.ebda.app/en/create-a-store/',
    siteLabel: 'Help',
    homeHref: '/en/',
    active: 'help',
    search: { action: '/search', label: 'Search', placeholder: 'Search' },
    main: '<p>x</p>',
    footer: '<footer></footer>',
    skipLabel: 'Skip',
    ...over,
  }) as string;

describe('help and docs pages (site-kit shell)', () => {
  it('an article page has the shared social card and Article + BreadcrumbList JSON-LD', () => {
    const html = page();
    expect(meta(html, 'og:image')).toBe('https://ebda.app/og.png');
    expect(meta(html, 'og:image:width')).toBe('1200');
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'twitter:title')).toBe('Create a store | Ebda AI Studio Help');
    expect(meta(html, 'twitter:image')).toBe('https://ebda.app/og.png');
    expect(meta(html, 'og:locale')).toBe('en_US');
    expect(types(html)).toEqual(['Organization', 'BreadcrumbList', 'Article']);
    const g = jsonLd(html)['@graph'];
    const crumbs = (g[1].itemListElement as { position: number; name: string; item: string }[]).map(
      c => [c.position, c.item]
    );
    expect(crumbs).toEqual([
      [1, 'https://help.ebda.app/en/'],
      [2, 'https://help.ebda.app/en/create-a-store/'],
    ]);
    expect(g[2].headline).toBe('Create a store');
    expect(g[2].inLanguage).toBe('en');
  });
  it('the home page gets a WebSite node, not an Article', () => {
    const html = page({ canonical: 'https://help.ebda.app/en/', title: 'Help' });
    expect(types(html)).toEqual(['Organization', 'WebSite']);
  });
  it('the search page (it carries a script) gets no Article', () => {
    const html = page({ scripts: ['/assets/search.js'] });
    expect(types(html)).toEqual(['Organization']);
  });
  it('Arabic pages use ar_EG and the Arabic studio name', () => {
    const html = page({ lang: 'ar' });
    expect(meta(html, 'og:locale')).toBe('ar_EG');
    expect(JSON.stringify(jsonLd(html)['@graph'][0])).toContain('ابدأ ستوديو');
  });
  it('JSON-LD cannot close its own script element', () => {
    const html = page({ title: 'a </script><b> | Help' });
    expect(html.match(/<\/script>/g)!.length).toBe(html.match(/<script/g)!.length);
  });
});

describe('status page', () => {
  const snap = {
    overall: 'operational',
    components: [],
    active: [],
    recent: [],
    generatedAt: 0,
  } as unknown as Snapshot;
  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: og + twitter card and a WebSite JSON-LD`, () => {
      const html = renderStatusPage(snap, lang, 'https://status.ebda.app');
      expect(meta(html, 'og:image')).toBe('https://ebda.app/og.png');
      expect(meta(html, 'og:url')).toBe(
        lang === 'ar' ? 'https://status.ebda.app/' : 'https://status.ebda.app/en'
      );
      expect(meta(html, 'og:locale')).toBe(lang === 'ar' ? 'ar_EG' : 'en_US');
      expect(meta(html, 'twitter:card')).toBe('summary_large_image');
      expect(types(html)).toEqual(['Organization', 'WebSite']);
    });
  }
});

describe('marketing redirects (audit M-164; one hop with the trailing slash, audit 2026-11-03 P1-9)', () => {
  const rules = readFileSync(path.join(ROOT, 'apps/marketing/public/_redirects'), 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.trim().split(/\s+/));
  const from = new Set(rules.map(r => r[0]));
  it.each([
    ['/pricing', '/store/#pricing'],
    ['/pricing/', '/store/#pricing'],
    ['/en/pricing', '/en/store/#pricing'],
    ['/en/pricing/', '/en/store/#pricing'],
    ['/compare', '/store/#pricing'],
    ['/compare/', '/store/#pricing'],
    ['/en/compare', '/en/store/#pricing'],
    ['/en/compare/', '/en/store/#pricing'],
  ])('%s -> %s in one permanent hop', (src, dest) => {
    expect(rules.find(r => r[0] === src)).toEqual([src, dest, '301']);
    // one hop: the destination (without its fragment) is never itself a redirect source
    expect(from.has(dest.split('#')[0])).toBe(false);
  });
  it('the real compare pages are not shadowed', () => {
    for (const slug of ['zid', 'shopify', 'wuilt', 'youcan', 'easyorders', 'expandcart'])
      expect(from.has(`/compare/${slug}/`)).toBe(false);
  });
});
