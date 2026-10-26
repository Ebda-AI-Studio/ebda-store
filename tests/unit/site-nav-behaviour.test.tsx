// @vitest-environment jsdom
/**
 * The header-nav behaviour is ONE script (SITE_NAV_JS in packages/shared/src/brand) served as a same-origin static
 * file by marketing, docs, help and status (no inline code). Per site this test checks (1) the site's real page loads
 * the script and the file it serves is exactly the shared text, and (2) the script, run in jsdom against that site's
 * REAL header markup, gives the menus their behaviour: aria-expanded in step, Esc closes and returns focus, a pointer
 * or focus outside closes, opening one menu closes the other, a plain link click closes (a ctrl-click does not).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { fireEvent } from '@testing-library/react';
import { SITE_NAV_JS } from '../../packages/shared/src/brand';
import { renderStatusPage } from '../../apps/status/src/render';
import { Header } from '../../apps/marketing/src/components/Header';
import type { Snapshot } from '../../apps/status/src/types';

const ROOT = path.resolve(__dirname, '../..');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');
const headerOf = (html: string) => /<header class="site-header[\s\S]*?<\/header>/.exec(html)![0];
const snap = {
  overall: 'operational',
  components: [],
  active: [],
  recent: [],
  generatedAt: 0,
} as unknown as Snapshot;

interface Site {
  name: string;
  lang: 'ar' | 'en';
  header: string;
  /** Proof the site loads and serves the shared file. */
  served: () => Promise<void> | void;
}
const sites: Site[] = [];

beforeAll(() => {
  for (const app of ['docs', 'help'])
    execFileSync('npm', ['run', 'build', '-w', `apps/${app}`], { cwd: ROOT, stdio: 'pipe' });
  for (const lang of ['ar', 'en'] as const) {
    const docs = read('apps/docs/out', lang === 'ar' ? 'ar/index.html' : 'index.html');
    const help = read('apps/help/out', lang === 'ar' ? 'index.html' : 'en/index.html');
    const status = renderStatusPage(snap, lang, 'https://status.ebda.app');
    const marketing = renderToStaticMarkup(<Header locale={lang} page="" />);
    sites.push(
      {
        name: 'docs',
        lang,
        header: headerOf(docs),
        served: () => {
          expect(docs).toContain('<script src="/assets/site-nav.js" defer></script>');
          expect(read('apps/docs/out/assets/site-nav.js')).toBe(SITE_NAV_JS);
        },
      },
      {
        name: 'help',
        lang,
        header: headerOf(help),
        served: () => {
          expect(help).toContain('<script src="/assets/site-nav.js" defer></script>');
          expect(read('apps/help/out/assets/site-nav.js')).toBe(SITE_NAV_JS);
        },
      },
      {
        name: 'status',
        lang,
        header: headerOf(status),
        // the Worker route and CSP are asserted in apps/status/test/status.test.ts (they need workerd)
        served: () => {
          expect(status).toContain('<script src="/assets/site-nav.js" defer></script>');
        },
      },
      {
        name: 'marketing',
        lang,
        header: headerOf(marketing),
        served: () => {
          // every page of the site goes through RootShell, which loads the file from public/
          expect(read('apps/marketing/src/components/RootShell.tsx')).toContain(
            '<script src="/site-nav.js" defer />'
          );
          expect(read('apps/marketing/public/site-nav.js')).toBe(SITE_NAV_JS);
        },
      }
    );
  }
}, 240_000);

describe('shared header-nav script', () => {
  it('has no framework, no eval and no network call', () => {
    expect(SITE_NAV_JS).not.toMatch(
      /\beval\b|new Function|fetch\(|XMLHttpRequest|import\(|require\(/
    );
  });

  for (const lang of ['ar', 'en'] as const) {
    for (const name of ['docs', 'help', 'status', 'marketing']) {
      describe(`${name} ${lang}`, () => {
        const site = () => sites.find(s => s.name === name && s.lang === lang)!;
        const mount = () => {
          document.body.innerHTML = `${site().header}<button id="out">outside</button>`;
          new Function(SITE_NAV_JS)();
          const products = document.querySelector<HTMLDetailsElement>('.nav-products details')!;
          const menu = document.querySelector<HTMLDetailsElement>('details.nav-menu')!;
          const open = (d: HTMLDetailsElement) => {
            d.open = true;
            d.dispatchEvent(new Event('toggle'));
          };
          const trig = (d: HTMLDetailsElement) => d.querySelector('summary')!;
          return { products, menu, open, trig };
        };

        it('loads the shared file, and serves exactly that text', async () => {
          await site().served();
        });
        it('keeps aria-expanded in step with the open state', () => {
          const { products, open, trig } = mount();
          expect(trig(products).getAttribute('aria-expanded')).toBe('false');
          open(products);
          expect(trig(products).getAttribute('aria-expanded')).toBe('true');
        });
        it('Esc closes the open menu and returns focus to its trigger', () => {
          const { products, open, trig } = mount();
          open(products);
          fireEvent.keyDown(document, { key: 'Escape' });
          expect(products.open).toBe(false);
          expect(document.activeElement).toBe(trig(products));
        });
        it('opening one menu closes the other', () => {
          const { products, menu, open } = mount();
          open(products);
          open(menu);
          expect(products.open).toBe(false);
          expect(menu.open).toBe(true);
        });
        it('a pointer or focus outside closes it', () => {
          const { products, open } = mount();
          const out = document.getElementById('out')!;
          open(products);
          fireEvent.pointerDown(out);
          expect(products.open).toBe(false);
          open(products);
          out.focus();
          expect(products.open).toBe(false);
        });
        it('a plain link click closes the menu; a ctrl-click leaves it open', () => {
          const { products, open } = mount();
          const link = products.querySelector('a')!;
          open(products);
          fireEvent.click(link, { ctrlKey: true });
          expect(products.open).toBe(true);
          fireEvent.click(link);
          expect(products.open).toBe(false);
        });
      });
    }
  }
});
