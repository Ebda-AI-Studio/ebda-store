import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { VerticalPage } from '../../apps/marketing/src/components/VerticalPage';
import { VERTICALS, VERTICAL_SLUGS, verticalLooks } from '../../apps/marketing/src/lib/verticals';
import {
  DEMO_STORES,
  FOR_SLUGS,
  LOCALES,
  SITE_PAGES,
  pagePath,
} from '../../apps/marketing/src/lib/site';
import sitemap from '../../apps/marketing/src/app/sitemap';

/** marketing-levelup P2: one ad landing page per vertical, built from the look registry, no invented claims. */
const APP = path.resolve(__dirname, '../../apps/marketing/src/app');

describe('per-vertical ad landing pages (/for/<vertical>/)', () => {
  it('the slugs, the data and the site pages agree', () => {
    expect([...VERTICAL_SLUGS].sort()).toEqual([...FOR_SLUGS].sort());
    for (const s of FOR_SLUGS) expect(SITE_PAGES).toContain(`for/${s}`);
    const templates = VERTICAL_SLUGS.map(s => VERTICALS[s].template).sort();
    expect(templates).toEqual(Object.keys(DEMO_STORES).sort()); // one vertical per template, none missing
  });

  it('every page has a route in both locales, a sitemap entry, and a title and description within SEO limits', () => {
    const urls = sitemap().map(e => e.url);
    for (const s of FOR_SLUGS)
      for (const l of LOCALES) {
        const dir =
          l === 'ar' ? path.join(APP, '(ar)', 'for', s) : path.join(APP, '(en)', 'en', 'for', s);
        expect(existsSync(path.join(dir, 'page.tsx')), `${l} ${s}`).toBe(true);
        expect(urls).toContain(`https://ebda.app${pagePath(l, `for/${s}`)}/`);
        const v = VERTICALS[s][l];
        expect(v.title.length).toBeLessThanOrEqual(60);
        expect(v.desc.length).toBeGreaterThan(60);
        expect(v.desc.length).toBeLessThanOrEqual(200);
      }
  });

  it('renders the headline, the three registry looks linking to the right demo store, and a tagged sign-up link', () => {
    for (const s of FOR_SLUGS)
      for (const l of LOCALES) {
        const html = renderToStaticMarkup(<VerticalPage locale={l} slug={s} />);
        expect(html).toContain(VERTICALS[s][l].h1);
        const looks = verticalLooks(s, l);
        expect(looks).toHaveLength(3);
        for (const lk of looks) {
          expect(html).toContain(lk.idea);
          expect(html).toContain(
            `https://${DEMO_STORES[VERTICALS[s].template].host}.ebda.app/?look=${lk.id}`.replace(
              /&/g,
              '&amp;'
            )
          );
        }
        expect(html).toContain(`utm_campaign=for-${s}`);
      }
  });

  it('names no competitor, provider or invented number', () => {
    for (const s of FOR_SLUGS)
      for (const l of LOCALES) {
        const v = VERTICALS[s][l];
        const t = `${v.h1} ${v.lead} ${v.title} ${v.desc}`;
        expect(t).not.toMatch(
          /shopify|salla|zid|wuilt|youcan|easyorders|expandcart|cloudflare|gemini|سلة|شوبيفاي/i
        );
        expect(t, `${s} ${l}`).not.toMatch(/\d/); // no numbers: nothing to substantiate
      }
  });
});
