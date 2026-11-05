import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { acquireSiteBuildLock } from '../helpers/site-build-lock';
import { renderStatusPage } from '../../apps/status/src/render';
import {
  SITE_NAV_PANEL_CSS,
  siteNavCta,
  siteNavLabels,
  siteNavLogin,
  siteNavProducts,
  siteNavResources,
  siteNavStudio,
} from '../../packages/shared/src/brand';
import { COPY } from '../../apps/marketing/src/lib/content';
import type { Snapshot } from '../../apps/status/src/types';

/**
 * docs, help and status show the SAME header navigation (one shared module, packages/shared/src/brand/index.ts):
 * the same Products menu and five links, in the same order and labels in ar and en, a nav landmark, the mobile menu,
 * and aria-current on the link of the site you are on. The three pages are rendered by their real builders.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');
const navOf = (html: string) => /<nav class="top-nav"[\s\S]*?<\/nav>/.exec(html)![0];
const links = (nav: string) =>
  [
    ...nav.matchAll(/<a href="([^"]+)"(?: class="[^"]*")?( aria-current="page")?>([\s\S]*?)<\/a>/g),
  ].map(m => ({
    href: m[1],
    current: !!m[2],
    text: m[3]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  }));

const snap: Snapshot = {
  overall: 'operational',
  components: [],
  active: [],
  recent: [],
  generatedAt: 0,
} as unknown as Snapshot;

describe('shared header nav on docs, help and status', () => {
  let release: () => void = () => {};
  // the help/docs builds wipe and rewrite out/; another test file building them in parallel would delete our pages mid-read
  beforeAll(async () => {
    release = await acquireSiteBuildLock();
    for (const app of ['docs', 'help'])
      execFileSync('npm', ['run', 'build', '-w', `apps/${app}`], { cwd: ROOT, stdio: 'pipe' });
  }, 840_000);
  afterAll(() => release());

  for (const lang of ['ar', 'en'] as const) {
    describe(lang, () => {
      const pages = () => ({
        docs: read('apps/docs/out', lang === 'ar' ? 'ar/index.html' : 'index.html'),
        help: read('apps/help/out', lang === 'ar' ? 'index.html' : 'en/index.html'),
        status: renderStatusPage(snap, lang, 'https://status.ebda.app'),
      });

      it('renders the identical nav (links, order, labels, menus) once aria-current is set aside', () => {
        const p = pages();
        const strip = (h: string) => navOf(h).replace(/ aria-current="page"/g, '');
        expect(strip(p.docs)).toBe(strip(p.help));
        expect(strip(p.docs)).toBe(strip(p.status));
      });

      it('has the studio bar: Products, Resources, About, Contact, Log in, the CTA, in the one order (ar and en)', () => {
        const prods = siteNavProducts(lang);
        const want = [
          ...prods.map(p => p.href),
          ...siteNavResources(lang).map(r => r.href),
          ...siteNavStudio(lang).map(i => i.href),
          ...siteNavLogin(lang).items.map(i => i.href),
          siteNavCta(lang).href,
        ];
        for (const [site, html] of Object.entries(pages())) {
          const nav = navOf(html);
          const desktop = links(nav.slice(0, nav.indexOf('<details class="nav-menu">')));
          expect(prods.map(p => p.label)).toEqual(
            lang === 'ar' ? ['ابدأ ستور', 'ابدأ شات'] : ['Ebda Store', 'Ebda Chat']
          );
          expect(
            desktop.map(l => l.href),
            site
          ).toEqual(want);
          for (const t of [siteNavLabels(lang).products, siteNavLabels(lang).resources])
            expect(nav).toContain(`<summary>${t}</summary>`);
          // the mobile menu repeats every link, grouped Products / Resources / Studio / Log in
          const menu = nav.slice(nav.indexOf('<details class="nav-menu">'));
          expect(
            links(menu).map(l => l.href),
            site
          ).toEqual(want);
          for (const g of [
            siteNavLabels(lang).products,
            siteNavLabels(lang).resources,
            siteNavLabels(lang).studio,
            siteNavLogin(lang).label,
          ])
            expect(menu, `${site}: group ${g}`).toContain(`<p>${g}</p>`);
          // no Store dashboard, no duplicate studio item (audit P1-7)
          expect(desktop.map(l => l.text).join('|'), site).not.toMatch(/Dashboard|لوحة التحكم/);
        }
      });

      it('marks only the current site with aria-current, and the nav is a labelled landmark', () => {
        const p = pages();
        for (const [site, html] of Object.entries(p)) {
          const cur = links(navOf(html)).filter(l => l.current);
          expect(
            cur.map(l => l.href.includes(`${site}.ebda.app`)),
            site
          ).toEqual([true, true]); // desktop + mobile
          expect(navOf(html)).toMatch(/<nav class="top-nav" aria-label="[^"]+">/);
          expect(html, site).toContain(lang === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
        }
      });
    });
  }

  it("the Products menu and labels equal the marketing header's own copy", () => {
    for (const lang of ['ar', 'en'] as const) {
      expect(siteNavLabels(lang).products).toBe(COPY[lang].nav.products);
      expect(siteNavLabels(lang).menu).toBe(COPY[lang].nav.menu);
      expect(siteNavProducts(lang)[0].blurb).toBe(COPY[lang].nav.storeBlurb);
      expect(siteNavProducts(lang)[1].blurb).toBe(COPY[lang].nav.whatsappBlurb);
    }
  });

  it('the marketing globals.css carries the shared Products panel CSS verbatim (one design, two stylesheets)', () => {
    const css = read('apps/marketing/src/app/globals.css');
    const m = /nav-products:start[^*]*\*\/([\s\S]*?)\/\* nav-products:end/.exec(css);
    expect(m, 'the nav-products block markers').not.toBeNull();
    // whitespace, the last `;` before `}` and prettier's leading zero (`.5rem` -> `0.5rem`) and lower-cased hex are not differences
    const norm = (x: string) =>
      x
        .toLowerCase()
        .replace(/(?<!\d)\.(\d)/g, '0.$1')
        .replace(/\s+/g, '')
        .replace(/;}/g, '}');
    expect(norm(m![1])).toBe(norm(SITE_NAV_PANEL_CSS));
  });
});
