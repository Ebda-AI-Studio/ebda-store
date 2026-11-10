/**
 * Every marketing page ships structured data (pre-QA sweep 2026-11-09, finding 4: 26 of 64 pages had none).
 * The walk reads the route DIRECTORY, not a list: a page added later without JSON-LD fails here.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// RootShell loads its fonts through next/font, which only exists inside the Next compiler.
vi.mock('next/font/google', () => {
  const font = () => ({ className: '', variable: '', style: {} });
  return { Geist: font, Geist_Mono: font, IBM_Plex_Sans_Arabic: font };
});
// the /services routes answer notFound() unless the lines are built (SERVICES-IA-1); the flag is read when the page renders
vi.hoisted(() => vi.stubEnv('EBDA_SERVICE_LINES', 'on'));
afterAll(() => vi.unstubAllEnvs());

import { pageJsonLd } from '../../apps/marketing/src/lib/seo';
import { SITE_URL } from '../../apps/marketing/src/lib/site';

const APP = path.resolve(__dirname, '../../apps/marketing/src/app');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const SCRIPT = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
const nodesOf = (doc: Record<string, unknown>) =>
  (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc]) as Record<string, unknown>[];

describe('every marketing page renders JSON-LD', () => {
  const pages = walk(APP).filter(f => /[\\/]page\.tsx$/.test(f) && !f.includes('_not-found'));
  it('finds the route files', () => expect(pages.length).toBeGreaterThanOrEqual(64));
  for (const file of pages) {
    const rel = path.relative(APP, file);
    it(rel, async () => {
      const { default: Page } = await import(file);
      const html = renderToStaticMarkup(<Page />);
      const blocks = [...html.matchAll(SCRIPT)].map(m => m[1]);
      expect(blocks.length, `${rel} has no application/ld+json script`).toBeGreaterThan(0);
      const docs = blocks.map(b => JSON.parse(b) as Record<string, unknown>);
      for (const d of docs) expect(d['@context']).toBe('https://schema.org');
      for (const n of docs.flatMap(nodesOf))
        expect(n['@type'], `${rel} has an untyped node`).toBeTruthy();
      // every page is tied to the studio Organization, under the one id the whole site shares (defined, or pointed at as provider/publisher)
      expect(blocks.join(''), `${rel} does not name the studio Organization`).toContain(
        `${SITE_URL}/#organization`
      );
    });
  }
});

describe('pageJsonLd', () => {
  it('describes the page itself: its url, language, name and the site it belongs to', () => {
    const doc = pageJsonLd('en', 'contact', 'Contact us', 'How to reach the studio.', {
      type: 'ContactPage',
    });
    const page = nodesOf(doc).find(n => n['@type'] === 'ContactPage')!;
    expect(page).toMatchObject({
      '@id': 'https://ebda.app/en/contact/#webpage',
      url: 'https://ebda.app/en/contact/',
      name: 'Contact us',
      description: 'How to reach the studio.',
      inLanguage: 'en',
      isPartOf: { '@id': 'https://ebda.app/#website' },
      publisher: { '@id': 'https://ebda.app/#organization' },
    });
  });

  it('defaults to WebPage, and carries the document date when given one', () => {
    const doc = pageJsonLd('ar', 'privacy', 'سياسة الخصوصية', 'نص', {
      dateModified: '2026-10-20',
    });
    const page = nodesOf(doc).find(n => n['@type'] === 'WebPage')!;
    expect(page.url).toBe('https://ebda.app/privacy/');
    expect(page.inLanguage).toBe('ar');
    expect(page.dateModified).toBe('2026-10-20');
  });

  it('every id a node points at is defined in the same graph', () => {
    const nodes = nodesOf(pageJsonLd('ar', 'credits', 'ا', 'ب'));
    const defined = new Set(nodes.map(n => n['@id']));
    for (const n of nodes)
      for (const v of Object.values(n))
        if (
          v &&
          typeof v === 'object' &&
          !Array.isArray(v) &&
          '@id' in v &&
          Object.keys(v).length === 1
        )
          expect(defined, `dangling ${(v as { '@id': string })['@id']}`).toContain(
            (v as { '@id': string })['@id']
          );
  });
});
