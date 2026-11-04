/**
 * Header nav: one label per destination (no "Features" twice), and every nav/footer link resolves from EVERY
 * marketing page: a `#section` link only exists on the home page, so off the home it must be absolute (`/#x`).
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Home } from '../../apps/marketing/src/components/Home';
import { ContactPage } from '../../apps/marketing/src/components/ContactPage';
import { WhatsAppPage } from '../../apps/marketing/src/components/WhatsAppPage';
import { StudioHomePage } from '../../apps/marketing/src/components/StudioHome';
import { FeaturesPage } from '../../apps/marketing/src/components/FeaturesPage';
import { ComparePage } from '../../apps/marketing/src/components/ComparePage';
import { AboutPage } from '../../apps/marketing/src/components/AboutPage';
import { CreditsPage } from '../../apps/marketing/src/components/CreditsPage';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import { COMPARE_SLUGS, LOCALES, STORE_HOME, pagePath } from '../../apps/marketing/src/lib/site';

const APP = path.resolve(__dirname, '../../apps/marketing/src/app');
const LEGAL = ['legal', 'privacy', 'terms', 'merchant-agreement', 'acceptable-use'] as const;

const PUBLIC = path.resolve(__dirname, '../../apps/marketing/public');
const LEGAL_ALL = [
  ...LEGAL,
  'refund',
  'legal/data-deletion',
  'legal/whatsapp-terms',
  'legal/whatsapp-privacy',
  'legal/whatsapp-dpa',
] as const;

function pagesFor(l: 'ar' | 'en'): Record<string, string> {
  const out: Record<string, string> = {
    '': renderToStaticMarkup(<StudioHomePage locale={l} />),
    store: renderToStaticMarkup(<Home locale={l} />),
    features: renderToStaticMarkup(<FeaturesPage locale={l} />),
    whatsapp: renderToStaticMarkup(<WhatsAppPage locale={l} />),
    about: renderToStaticMarkup(<AboutPage locale={l} />),
    contact: renderToStaticMarkup(<ContactPage locale={l} />),
    credits: renderToStaticMarkup(<CreditsPage locale={l} />),
  };
  for (const s of COMPARE_SLUGS)
    out[`compare/${s}`] = renderToStaticMarkup(<ComparePage locale={l} slug={s} />);
  for (const p of LEGAL_ALL) out[p] = renderToStaticMarkup(<LegalPage locale={l} page={p} />);
  return out;
}

const hrefs = (html: string, re: RegExp) =>
  [...(html.match(re)?.[0] ?? '').matchAll(/<a [^>]*?href="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map(m => ({
    href: m[1],
    label: m[2].replace(/<[^>]+>/g, '').trim(),
  }));
const ids = (html: string) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));

describe('header nav and footer links', () => {
  for (const l of LOCALES) {
    const pages = pagesFor(l);
    // the pages that own the anchors a header or footer link may point at
    const anchorIds: Record<string, Set<string>> = {
      [pagePath(l, '').replace(/\/$/, '')]: ids(pages['']),
      [STORE_HOME[l]]: ids(pages.store),
      [pagePath(l, 'whatsapp')]: ids(pages.whatsapp),
    };
    for (const [name, html] of Object.entries(pages)) {
      it(`${l} ${name || 'studio home'}: the studio bar, product bar and footer links all resolve`, () => {
        const nav = hrefs(html, /<ul class="nav-links">.*?<\/ul>(?=<details class="nav-menu">)/s);
        const menu = hrefs(html, /<details class="nav-menu">.*?<\/details>/s);
        const product = hrefs(html, /<div class="product-bar">.*?<\/div><\/div>/s);
        const footer = hrefs(html, /<footer class="site-footer.*?<\/footer>/s);
        expect(nav.length).toBeGreaterThan(3);
        expect(footer.length).toBeGreaterThan(20);
        const labels = nav.map(n => n.label);
        expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
        for (const { href } of [...nav, ...menu, ...product, ...footer]) {
          if (href.startsWith('mailto:') || /^https?:/.test(href)) continue;
          const [route, hash] = href.split('#');
          const bare = route.replace(/\/$/, '') || '/';
          if (hash !== undefined) {
            const owner = anchorIds[bare === '/' ? '' : bare];
            expect(owner, `${href}: no page owns an anchor at ${bare}`).toBeTruthy();
            expect(owner!.has(hash), `${href}: #${hash} exists on ${bare}`).toBe(true);
            continue;
          }
          if (/\.[a-z]+$/.test(route)) {
            expect(existsSync(path.join(PUBLIC, route)), `${href} is a public file`).toBe(true);
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

describe('studio home (Ruling MKT-HOME-1)', () => {
  for (const l of LOCALES) {
    const html = renderToStaticMarkup(<StudioHomePage locale={l} />);
    it(`${l}: Ebda Store first with its own sign-up, then Ebda Chat with its app; no CRM/ERP; no Store sections in the nav`, () => {
      const store = html.indexOf('data-win="8"');
      const chat = html.indexOf('data-win="12"');
      expect(store).toBeGreaterThan(-1);
      expect(chat).toBeGreaterThan(store);
      expect(html).toContain('href="https://store.ebda.app/signup"');
      expect(html).toContain(`href="${STORE_HOME[l]}"`);
      expect(html).toContain(`href="${pagePath(l, 'whatsapp')}"`);
      expect(html).not.toMatch(/CRM|ERP/);
      expect(html).not.toMatch(/href="(\/en)?\/?#(story|looks|pricing|faq)"/);
      expect(html).toContain('/hash-forward.js');
    });
  }
});
