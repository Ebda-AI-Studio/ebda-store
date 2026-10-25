/**
 * Header nav: one label per destination (no "Features" twice), and every nav/footer link resolves from EVERY
 * marketing page: a `#section` link only exists on the home page, so off the home it must be absolute (`/#x`).
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Home } from '../../apps/marketing/src/components/Home';
import { FeaturesPage } from '../../apps/marketing/src/components/FeaturesPage';
import { ComparePage } from '../../apps/marketing/src/components/ComparePage';
import { AboutPage } from '../../apps/marketing/src/components/AboutPage';
import { CreditsPage } from '../../apps/marketing/src/components/CreditsPage';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import { COMPARE_SLUGS, HOME, LOCALES, pagePath } from '../../apps/marketing/src/lib/site';

const APP = path.resolve(__dirname, '../../apps/marketing/src/app');
const LEGAL = ['legal', 'privacy', 'terms', 'merchant-agreement', 'acceptable-use'] as const;

function pagesFor(l: 'ar' | 'en'): Record<string, string> {
  const out: Record<string, string> = {
    home: renderToStaticMarkup(<Home locale={l} />),
    features: renderToStaticMarkup(<FeaturesPage locale={l} />),
    about: renderToStaticMarkup(<AboutPage locale={l} />),
    credits: renderToStaticMarkup(<CreditsPage locale={l} />),
  };
  for (const s of COMPARE_SLUGS)
    out[`compare/${s}`] = renderToStaticMarkup(<ComparePage locale={l} slug={s} />);
  for (const p of LEGAL) out[p] = renderToStaticMarkup(<LegalPage locale={l} page={p} />);
  return out;
}

const hrefs = (html: string, re: RegExp) =>
  [...(html.match(re)?.[0] ?? '').matchAll(/<a [^>]*?href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map(m => ({
    href: m[1],
    label: m[2].replace(/<[^>]+>/g, '').trim(),
  }));

describe('header nav and footer links', () => {
  for (const l of LOCALES) {
    const pages = pagesFor(l);
    const homeIds = new Set([...pages.home.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
    for (const [name, html] of Object.entries(pages)) {
      it(`${l} ${name}: nav labels are unique and every nav + footer href resolves`, () => {
        const nav = hrefs(html, /<ul class="nav-links">.*?<\/ul>(?=<details class="nav-menu">)/s);
        const menu = hrefs(html, /<details class="nav-menu">.*?<\/details>/s);
        const footer = hrefs(html, /<footer class="site-footer.*?<\/footer>/s);
        expect(nav.length).toBeGreaterThan(3);
        const labels = nav.map(n => n.label);
        expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
        // the one Features item points at the real page, in the desktop nav, mobile menu and footer
        const featuresHref = pagePath(l, 'features');
        for (const set of [nav, menu, footer]) {
          const f = set.filter(x => x.href === featuresHref);
          expect(f, `${name}: one link to ${featuresHref}`).toHaveLength(1);
        }
        expect(nav.filter(n => n.href.includes('#features'))).toEqual([]);
        for (const { href } of [...nav, ...menu, ...footer]) {
          if (href.startsWith('mailto:') || /^https?:/.test(href)) continue;
          if (href.startsWith('#')) {
            // an in-page anchor only works on the page that has the id: the home
            expect(name, `${href} on ${name}`).toBe('home');
            expect(homeIds.has(href.slice(1)), href).toBe(true);
            continue;
          }
          const [route, hash] = href.split('#');
          if (hash !== undefined) {
            expect(route.replace(/\/$/, ''), href).toBe(HOME[l].replace(/\/$/, ''));
            expect(homeIds.has(hash), `${href} id exists on the home`).toBe(true);
            continue;
          }
          const rel = route
            .replace(/^\/en(\/|$)/, '')
            .replace(/^\//, '')
            .replace(/\/$/, '');
          const toLocale = route === '/en' || route.startsWith('/en/') ? 'en' : 'ar';
          const file =
            toLocale === 'ar'
              ? path.join(APP, '(ar)', rel, 'page.tsx')
              : path.join(APP, '(en)/en', rel, 'page.tsx');
          expect(existsSync(file), `${href} -> ${file}`).toBe(true);
        }
      });
    }
  }
});
