/**
 * The ONE studio navigation and footer (public sites audit 2026-11-03, section 4; rulings NAV-PRODUCT-OF-PAGE-1,
 * NAV-CTA-1, NAV-CHAT-SLUG-1, AR-STUDIO-NAME-1). The brand module is the single data source; this file proves the
 * marketing React `Header`/`Footer` and the string renderers used by help, docs and status draw the same links, in the
 * same groups and order, in ar and en, and that the page-kind and redirect rules hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatLegalDate } from '../../packages/shared/src/legal';
import { renderToStaticMarkup } from 'react-dom/server';
import { acquireSiteBuildLock } from '../helpers/site-build-lock';
import {
  BRAND,
  SITE_FOOTER_CSS,
  officeInfo,
  serviceInfo,
  siteFooter,
  siteFooterHtml,
  siteNavCta,
  siteNavLogin,
  siteNavProducts,
  siteNavResources,
  siteNavStudio,
  studioHomeLink,
  productBar,
  type NavLang,
} from '../../packages/shared/src/brand';
import { renderStatusPage } from '../../apps/status/src/render';
import { Header } from '../../apps/marketing/src/components/Header';
import { Footer } from '../../apps/marketing/src/components/Footer';
import { ContactPage } from '../../apps/marketing/src/components/ContactPage';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import {
  jsonLd,
  pageMetadata,
  studioJsonLd,
  whatsappJsonLd,
} from '../../apps/marketing/src/lib/seo';
import { StudioHomePage } from '../../apps/marketing/src/components/StudioHome';
import { AboutPage } from '../../apps/marketing/src/components/AboutPage';
import { productOfPage, SITE_PAGES } from '../../apps/marketing/src/lib/site';
import type { Snapshot } from '../../apps/status/src/types';

const ROOT = path.resolve(__dirname, '../..');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');
const ORIGIN = 'https://ebda.app';
const snap = {
  overall: 'operational',
  components: [],
  active: [],
  recent: [],
  generatedAt: Date.now(),
} as unknown as Snapshot;

/** `<a ...href="x"...>label</a>` pairs of an HTML fragment, hrefs made absolute and trailing-slash-insensitive (next/link drops the slash outside a Next build). */
const anchors = (html: string) =>
  [...html.matchAll(/<a\b[^>]*?\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(m => {
    const href = m[1].startsWith('/') ? ORIGIN + m[1] : m[1];
    return {
      href: href.replace(/\/(#|$)/, '$1'),
      label: m[2]
        .replace(/<span class="sr-only">[^<]*<\/span>/g, '') // SiteLink's hidden new-tab note
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    };
  });
const norm = (links: { href: string; label: string }[]) =>
  links.map(l => `${l.label} -> ${l.href.replace(/\/(#|$)/, '$1')}`);
const model = (links: { href: string; label: string }[]) => norm(links);

const groupsOfMenu = (menuHtml: string) =>
  [
    ...menuHtml.matchAll(/<li class="menu-group[^"]*"><p>([^<]+)<\/p><ul>([\s\S]*?)<\/ul><\/li>/g),
  ].map(m => ({ title: m[1], links: model(anchors(m[2])) }));
const navOf = (html: string) => /<nav class="top-nav"[\s\S]*?<\/nav>/.exec(html)![0];
const menuOf = (html: string) => html.slice(html.indexOf('<details class="nav-menu">'));
const colsOf = (html: string) =>
  [
    ...html.matchAll(/<nav class="sf-col"[^>]*><h2[^>]*>([^<]+)<\/h2><ul>([\s\S]*?)<\/ul><\/nav>/g),
  ].map(m => ({ title: m[1], links: model(anchors(m[2])) }));

describe('brand module nav data', () => {
  for (const lang of ['ar', 'en'] as NavLang[]) {
    it(`${lang}: every link is absolute https, the wordmark is the studio home, Chat stays at /whatsapp/`, () => {
      const all = [
        studioHomeLink(lang),
        ...siteNavProducts(lang),
        ...siteNavResources(lang),
        ...siteNavStudio(lang),
        ...siteNavLogin(lang).items,
        siteNavCta(lang),
        ...siteFooter(lang).columns.flatMap(c => c.links),
      ];
      for (const l of all) expect(l.href, l.id).toMatch(/^https:\/\//);
      expect(studioHomeLink(lang).href).toBe(lang === 'ar' ? `${ORIGIN}/` : `${ORIGIN}/en/`);
      expect(siteNavProducts(lang)[1].href).toBe(
        lang === 'ar' ? `${ORIGIN}/whatsapp/` : `${ORIGIN}/en/whatsapp/`
      );
      // NAV-CTA-1: the studio CTA is "choose a product", anchored to the product windows, never a signup
      expect(siteNavCta(lang).href).toMatch(/#products$/);
      expect(siteNavCta(lang).label).toBe(lang === 'ar' ? 'اختار منتجك' : 'Choose a product');
      expect(all.map(l => l.label).join(' ')).not.toMatch(/WhatsApp (?:Chat|Store)|Ebda WhatsApp/);
    });
    it(`${lang}: the product bar anchors carry the trailing slash (one hop) and the CTA is the product's own`, () => {
      for (const kind of ['store', 'chat'] as const) {
        const b = productBar(kind, lang);
        for (const l of b.links) expect(l.path, l.id).toMatch(/\/(#[a-z]+)?$/);
        expect(b.cta.href).toBe(
          kind === 'store' ? 'https://store.ebda.app/signup' : 'https://wa.ebda.app'
        );
      }
    });
    it(`${lang}: the footer is five columns (brand + Products, Resources, Studio, Legal), no compare links, no legal entity name`, () => {
      const f = siteFooter(lang);
      expect(f.columns.map(c => c.id)).toEqual(['products', 'resources', 'studio', 'legal']);
      const flat = f.columns.flatMap(c => c.links);
      expect(flat.some(l => /\/compare\//.test(l.href))).toBe(false);
      // the Chat documents are reachable from the footer (audit P1-4)
      for (const d of ['whatsapp-terms', 'whatsapp-privacy', 'whatsapp-dpa'])
        expect(
          flat.some(l => l.href.includes(`/legal/${d}/`)),
          d
        ).toBe(true);
      for (const r of ['help', 'docs', 'status'])
        expect(
          flat.some(l => l.href.includes(`${r}.ebda.app`)),
          r
        ).toBe(true);
      expect(JSON.stringify(f)).not.toMatch(/تكنولوجيا المعلومات|legal entity/);
      expect(JSON.stringify(f)).not.toContain(BRAND.company.legalNameEn);
    });
  }
});

describe('studio-level links never carry a bare product-specific label (Ahmad, footer ruling 2026-11-03)', () => {
  // Store-only documents that productOfPage() cannot tell from studio pages by slug
  const STORE_DOCS = ['merchant-agreement', 'refund'];
  const slugOf = (href: string) =>
    href
      .replace(/^https:\/\/ebda\.app/, '')
      .replace(/^\/en(?=\/|$)/, '')
      .replace(/[#?].*$/, '')
      .replace(/^\/|\/$/g, '');
  for (const lang of ['ar', 'en'] as NavLang[]) {
    it(`${lang}: a footer or nav link to a Store-only or Chat-only page names its product in the label`, () => {
      const names = {
        store: lang === 'ar' ? 'ابدأ ستور' : 'Ebda Store',
        chat: lang === 'ar' ? 'ابدأ شات' : 'Ebda Chat',
      };
      const links = [
        ...siteFooter(lang).columns.flatMap(c => c.links),
        ...siteNavProducts(lang),
        ...siteNavResources(lang),
        ...siteNavStudio(lang),
        siteNavCta(lang),
      ];
      let checked = 0;
      for (const l of links) {
        if (!l.href.startsWith('https://ebda.app')) continue;
        const slug = slugOf(l.href);
        const kind = STORE_DOCS.includes(slug) ? 'store' : productOfPage(slug);
        if (kind === 'studio') continue;
        checked++;
        expect(l.label, `${l.href} is ${kind}-only`).toContain(names[kind]);
      }
      expect(checked).toBeGreaterThan(8);
      // generic "Features" is Store's, never studio-level (the label says Store, or it is not there)
      for (const l of links)
        if (/^(المميزات|Features)$/.test(l.label)) throw new Error(`bare ${l.label}`);
      // studio links use the short Arabic name (AR-STUDIO-NAME-1)
      expect(links.map(l => l.label).join('|')).not.toMatch(/للذكاء الاصطناعي/);
    });
  }
});

describe('marketing React header and footer equal the brand data and the support-site renderers', () => {
  for (const lang of ['ar', 'en'] as NavLang[]) {
    const page = renderToStaticMarkup(<Header locale={lang} page="about" />);
    it(`${lang}: studio bar, groups and order`, () => {
      const prods = siteNavProducts(lang);
      const res = siteNavResources(lang);
      const studio = siteNavStudio(lang);
      const login = siteNavLogin(lang);
      const desktop = anchors(
        page.slice(
          page.indexOf('<ul class="nav-links">'),
          page.indexOf('<details class="nav-menu">')
        )
      );
      expect(norm(desktop)).toEqual(
        model([
          ...prods.map(p => ({ href: p.href, label: `${p.label} ${p.blurb}` })),
          ...res,
          ...studio,
        ])
      );
      const groups = groupsOfMenu(menuOf(page));
      expect(groups.map(g => g.links)).toEqual([
        model(prods),
        model(res),
        model(studio),
        model(login.items),
      ]);
      // the same groups the support sites' mobile menu renders
      const html = siteNavHtmlFor(lang);
      expect(groupsOfMenu(menuOf(html)).map(g => g.links)).toEqual(groups.map(g => g.links));
      // the Log in menu and the studio CTA
      expect(norm(anchors(page.slice(page.indexOf('class="header-actions"'))))).toEqual(
        expect.arrayContaining(model([...login.items, siteNavCta(lang)]))
      );
    });
    it(`${lang}: the footer columns equal the support-site footer`, () => {
      const react = renderToStaticMarkup(<Footer locale={lang} />);
      const strings = siteFooterHtml(lang, '<img>', new Date().getUTCFullYear());
      const noCookie = (cols: ReturnType<typeof colsOf>) =>
        cols.map(c => ({
          ...c,
          links: c.links.filter(l => !l.startsWith(lang === 'ar' ? 'إعدادات' : 'Cookie')),
        }));
      expect(noCookie(colsOf(react))).toEqual(noCookie(colsOf(strings)));
      expect(colsOf(react).map(c => c.title)).toEqual(siteFooter(lang).columns.map(c => c.title));
      expect(anchors(react.match(/<div class="sf-brand">[\s\S]*?<\/dl>/)![0])).toEqual(
        anchors(strings.match(/<div class="sf-brand">[\s\S]*?<\/dl>/)![0])
      );
      expect(react).toContain(siteFooter(lang).copyright(new Date().getUTCFullYear()));
      expect(strings).toContain(siteFooter(lang).copyright(new Date().getUTCFullYear()));
    });
  }
  it('chrome.css carries the shared footer CSS verbatim (one design, two stylesheets)', () => {
    const css = read('apps/marketing/src/app/chrome.css');
    const m = /site-footer:start[^*]*\*\/([\s\S]*?)\/\* site-footer:end/.exec(css);
    expect(m, 'the site-footer block markers').not.toBeNull();
    const n = (x: string) =>
      x
        .toLowerCase()
        .replace(/(?<!\d)\.(\d)/g, '0.$1')
        .replace(/\s+/g, '')
        .replace(/;}/g, '}')
        .replace(/'/g, '');
    expect(n(m![1])).toBe(n(SITE_FOOTER_CSS));
  });
});

// the nav the three support renderers share, as the status Worker draws it
import { siteNavHtml } from '../../packages/shared/src/brand';
const siteNavHtmlFor = (lang: NavLang) => siteNavHtml(lang, 'status');

describe('support sites: identical footer, language-correct links, no dead internal links', () => {
  let release: () => void = () => {};
  beforeAll(async () => {
    release = await acquireSiteBuildLock();
    for (const app of ['docs', 'help'])
      execFileSync('npm', ['run', 'build', '-w', `apps/${app}`], { cwd: ROOT, stdio: 'pipe' });
  }, 840_000);
  afterAll(() => release());
  const footerOf = (html: string) =>
    /<footer class="site-footer band-dark sf">[\s\S]*?<\/footer>/
      .exec(html)![0]
      .replace(/<(img|svg)[^>]*?(\/>|>)(?:[\s\S]*?<\/svg>)?/, '<mark/>');
  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: help, docs and status render the identical footer`, () => {
      const docs = read('apps/docs/out', lang === 'ar' ? 'ar/index.html' : 'index.html');
      const help = read('apps/help/out', lang === 'ar' ? 'index.html' : 'en/index.html');
      const status = renderStatusPage(snap, lang, 'https://status.ebda.app');
      const f = footerOf(help);
      expect(footerOf(docs)).toBe(f);
      expect(footerOf(status)).toBe(f);
      // an English page never links an Arabic root, nor the other way round (audit P1-8)
      const hrefs = anchors(f).map(a => a.href);
      const want = siteNavResources(lang).map(r => r.href);
      for (const h of want) expect(hrefs, h).toContain(h.replace(/\/$/, ''));
    });
  }
  it('no dead /ar/ help links and the account-security app path resolves to a real page', () => {
    for (const f of readdirSync(path.join(ROOT, 'apps/help/content/ar'))) {
      if (!f.endsWith('.mdx')) continue;
      expect(read('apps/help/content/ar', f), f).not.toMatch(/\]\(\/ar\//);
    }
    for (const l of ['ar', 'en'])
      expect(read(`apps/help/content/${l}/account-security.mdx`)).toContain(
        'appPath: /account/security'
      );
    expect(statSync(path.join(ROOT, 'apps/admin/src/app/account/security/page.tsx')).isFile()).toBe(
      true
    );
  });
});

describe('Log in is product-specific on a product page (MKT-WA-CHROME-1)', () => {
  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: a Chat page never links the Store app, a Store page never links the Chat app, the studio lists both`, () => {
      const chat = renderToStaticMarkup(<Header locale={lang} page="legal/whatsapp-terms" />);
      const store = renderToStaticMarkup(<Header locale={lang} page="features" />);
      const studio = renderToStaticMarkup(<Header locale={lang} page="about" />);
      expect(chat).not.toContain('store.ebda.app');
      expect(chat).toContain('href="https://wa.ebda.app"');
      expect(store).not.toContain('wa.ebda.app');
      expect(store).toContain('https://store.ebda.app/login');
      expect(studio).toContain('https://store.ebda.app/login');
      expect(studio).toContain('wa.ebda.app');
    });
  }
});

describe('page kinds (NAV-PRODUCT-OF-PAGE-1)', () => {
  it('studio | store | chat, the Store family is an explicit list and the default is studio', () => {
    for (const p of [
      '',
      'about',
      'contact',
      'credits',
      'legal',
      'privacy',
      'terms',
      'merchant-agreement',
      'acceptable-use',
      'refund',
      'legal/data-deletion',
      'some-new-page',
    ])
      expect(productOfPage(p), p).toBe('studio');
    for (const p of [
      'store',
      'features',
      'compare/zid',
      'compare/shopify',
      'for/fashion',
      'for/jewellery',
    ])
      expect(productOfPage(p), p).toBe('store');
    for (const p of [
      'whatsapp',
      'legal/whatsapp-terms',
      'legal/whatsapp-privacy',
      'legal/whatsapp-dpa',
    ])
      expect(productOfPage(p), p).toBe('chat');
    // every real page has a kind (none falls through by accident)
    expect(SITE_PAGES.map(productOfPage).every(k => ['studio', 'store', 'chat'].includes(k))).toBe(
      true
    );
  });
  it('studio pages show no product bar; Store and Chat pages show theirs; the wordmark is always the studio home', () => {
    for (const lang of ['ar', 'en'] as const) {
      for (const [page, bar] of [
        ['about', false],
        ['contact', false],
        ['privacy', false],
        ['store', true],
        ['features', true],
        ['compare/zid', true],
        ['whatsapp', true],
        ['legal/whatsapp-dpa', true],
      ] as const) {
        const html = renderToStaticMarkup(<Header locale={lang} page={page} />);
        expect(html.includes('class="product-bar"'), `${lang} ${page}`).toBe(bar);
        const wm = /<a class="wordmark"[^>]*?href="([^"]+)"/.exec(html)![1];
        expect(wm.replace(/\/$/, '') || '/').toBe(lang === 'ar' ? '/' : '/en');
      }
    }
  });
  it('titles: studio pages say Ebda AI Studio, Store pages Ebda Store, Chat pages Ebda Chat', () => {
    expect(String(pageMetadata('en', 'about', 'About Ebda AI Studio').title)).not.toMatch(
      /Ebda Store/
    );
    expect(String(pageMetadata('en', 'privacy', 'Privacy policy').title)).toBe(
      'Privacy policy | Ebda AI Studio (ebda.app)'
    );
    expect(String(pageMetadata('en', 'features', 'Features').title)).toBe(
      'Features | Ebda Store (ebda.app)'
    );
    expect(String(pageMetadata('ar', 'legal/whatsapp-terms', 'شروط خدمة ابدأ شات').title)).toBe(
      'شروط خدمة ابدأ شات | ابدأ شات (ebda.app)'
    );
    expect(pageMetadata('ar', 'contact', 'تواصل').openGraph).toMatchObject({
      siteName: 'ابدأ ستوديو للذكاء الاصطناعي',
    });
  });
});

describe('names and facts (AR-STUDIO-NAME-1)', () => {
  const walk = (dir: string, out: string[] = []) => {
    for (const n of readdirSync(dir)) {
      if (
        [
          'node_modules',
          '.next',
          'out',
          'dist',
          '.git',
          'plans',
          'audits',
          'graphify-out',
        ].includes(n)
      )
        continue;
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(tsx?|mjs|json|mdx?|txt|html)$/.test(n) && !/\.test\./.test(n)) out.push(p);
    }
    return out;
  };
  it('«ابدأ استوديو» (with the alef) appears nowhere in apps, packages or docs', () => {
    // the ruling itself quotes the old spelling; the vendored foundation brand.ts now carries the corrected values too
    const allowed = ['docs/rulings/AR-STUDIO-NAME-1.md'];
    const hits = ['apps', 'packages', 'docs']
      .flatMap(d => walk(path.join(ROOT, d)))
      .filter(f => !allowed.includes(path.relative(ROOT, f)))
      .filter(f => readFileSync(f, 'utf8').includes('ابدأ استوديو'));
    expect(hits.map(f => path.relative(ROOT, f))).toEqual([]);
  });
  it('the legal entity name is on the legal notice, not on the contact page', () => {
    for (const lang of ['ar', 'en'] as const) {
      const contact = renderToStaticMarkup(<ContactPage locale={lang} />);
      const legal = renderToStaticMarkup(<LegalPage locale={lang} page="legal" />);
      expect(contact).not.toContain(BRAND.company[lang === 'en' ? 'legalNameEn' : 'legalNameAr']);
      expect(legal).toMatch(lang === 'en' ? /Ebda Studio\b/ : /ابدأ ستوديو لتكنولوجيا المعلومات/);
    }
  });
});

describe('redirects (audit section 4)', () => {
  const rules = read('apps/marketing/public/_redirects')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.trim().split(/\s+/));
  const rule = (src: string) => rules.find(r => r[0] === src);
  const from = new Set(rules.map(r => r[0]));
  it.each([
    ['/chat', '/whatsapp/', '301'],
    ['/chat/', '/whatsapp/', '301'],
    ['/en/chat', '/en/whatsapp/', '301'],
    ['/en/chat/', '/en/whatsapp/', '301'],
    ['/login', 'https://store.ebda.app/login', '302'],
    ['/help', 'https://help.ebda.app/', '301'],
    ['/en/help', 'https://help.ebda.app/en/', '301'],
    ['/docs', 'https://docs.ebda.app/ar/', '301'],
    ['/en/docs', 'https://docs.ebda.app/', '301'],
    ['/status', 'https://status.ebda.app/', '301'],
    ['/en/status', 'https://status.ebda.app/en', '301'],
    ['/studio', '/', '301'],
    ['/en/studio', '/en/', '301'],
    ['/security.txt', '/.well-known/security.txt', '301'],
    ['/pricing', '/store/#pricing', '301'],
    ['/en/compare', '/en/store/#pricing', '301'],
  ])('%s -> %s (%s), in one hop', (src, dest, code) => {
    expect(rule(src)).toEqual([src, dest, code]);
    expect(from.has(dest.split('#')[0]), 'the destination is never itself a redirect source').toBe(
      false
    );
  });
  it('the studio home is never redirected to /store, and /signup stays', () => {
    expect(rule('/')).toBeUndefined();
    expect(rule('/en/')).toBeUndefined();
    expect(rule('/signup')).toEqual(['/signup', 'https://store.ebda.app/signup', '302']);
  });
  it('hash-forward lands on the canonical /store/ in one hop', () => {
    expect(read('apps/marketing/public/hash-forward.js')).toContain(
      "'/store/' + location.search + h"
    );
  });
});

describe('the office (BRAND.office): About, Contact and the legal notice show it; the footer does not; JSON-LD carries a PostalAddress', () => {
  for (const lang of ['ar', 'en'] as const) {
    const o = officeInfo(lang);
    it(`${lang}: address, map link and the by-appointment meeting line come from BRAND`, () => {
      for (const [name, html] of [
        ['about', renderToStaticMarkup(<AboutPage locale={lang} />)],
        ['contact', renderToStaticMarkup(<ContactPage locale={lang} />)],
        ['legal notice', renderToStaticMarkup(<LegalPage locale={lang} page="legal" />)],
      ] as const) {
        const text = html.replace(/<[^>]+>/g, '');
        expect(text, name).toContain(o.address);
        expect(text, name).toContain(o.meeting);
        expect(html, name).toContain(`href="${o.mapUrl}"`);
        // a virtual office: nothing implies walk-in hours
        expect(text, name).not.toMatch(
          /walk-in|opening hours|office hours|ساعات (?:العمل|الزيارة)/i
        );
      }
      expect(o.meeting).toMatch(lang === 'ar' ? /بميعاد سابق/ : /by appointment only/);
      // the footer keeps email and WhatsApp only
      expect(renderToStaticMarkup(<Footer locale={lang} />)).not.toContain(o.address);
      expect(siteFooterHtml(lang, '', 2026)).not.toContain(o.address);
    });
  }
  it('Organization JSON-LD (studio home, Store, Chat) has a PostalAddress in Cairo, EG and the founding date', () => {
    for (const lang of ['ar', 'en'] as const) {
      const graphs = [studioJsonLd(lang), jsonLd(lang), whatsappJsonLd(lang, [])].flatMap(
        g => g['@graph'] as Record<string, unknown>[]
      );
      const orgs = graphs.filter(n => n['@id'] === 'https://ebda.app/#organization');
      expect(orgs.length).toBe(3);
      for (const org of orgs) {
        expect(org.address).toMatchObject({
          '@type': 'PostalAddress',
          streetAddress: BRAND.office.addressEn,
          addressLocality: 'Cairo',
          addressRegion: 'Cairo',
          addressCountry: 'EG',
        });
        expect(org.foundingDate).toBe('2026-09-11');
        // name is the marketing name, legalName the registered entity (LEGAL-NAME-2)
        expect(org.name).toBe('Ebda AI Studio');
        expect(org.legalName).toBe(
          lang === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn
        );
      }
    }
  });
});

describe('the founding date (BRAND.company.foundedOn)', () => {
  it('About shows it through the site date formatter, Western digits, ar and en', () => {
    expect(BRAND.company.foundedOn).toBe('2026-09-11');
    const ar = renderToStaticMarkup(<AboutPage locale="ar" />);
    const en = renderToStaticMarkup(<AboutPage locale="en" />);
    expect(ar.replace(/<[^>]+>/g, '')).toContain(
      `اتأسست في ${formatLegalDate('2026-09-11', 'ar')}`
    );
    expect(en.replace(/<[^>]+>/g, '')).toContain(`Founded ${formatLegalDate('2026-09-11', 'en')}`);
    expect(formatLegalDate('2026-09-11', 'ar')).toMatch(/^11 .*2026$/);
    expect(formatLegalDate('2026-09-11', 'en')).toBe('11 September 2026');
    expect(ar + en).toContain('dateTime="2026-09-11"');
  });
});

describe('services (BRAND.services): studio home and About render all seven, separate from the products', () => {
  const ids = ['ai', 'software', 'marketing', 'photography', 'training', '3d', 'events'];
  it('BRAND holds the seven, benefit lines only (no prices)', () => {
    expect(BRAND.services.map(s => s.id)).toEqual(ids);
    for (const s of BRAND.services) {
      expect(`${s.ar} ${s.en} ${s.benefitAr} ${s.benefitEn}`).not.toMatch(/EGP|جنيه|ج\.م|\d{2,}/);
      expect(s.benefitAr.length).toBeGreaterThan(8);
    }
  });
  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: the studio home and About show every service from BRAND, and the home keeps Products as its own section`, () => {
      const home = renderToStaticMarkup(<StudioHomePage locale={lang} />);
      const about = renderToStaticMarkup(<AboutPage locale={lang} />);
      for (const [name, html] of [
        ['home', home],
        ['about', about],
      ] as const) {
        expect((html.match(/data-service="/g) ?? []).length, name).toBe(7);
        for (const s of serviceInfo(lang)) {
          expect(html, `${name} ${s.id}`).toContain(s.name);
          expect(html, `${name} ${s.id}`).toContain(s.benefit);
        }
      }
      expect(home).toContain('id="products"');
      expect(home.indexOf('id="studio"')).toBeLessThan(home.indexOf('id="products"'));
      // the CTA to /contact on About
      expect(about).toContain(lang === 'ar' ? 'كلّمنا عن مشروعك' : 'Tell us about your project');
      expect(about).toMatch(lang === 'ar' ? /href="\/contact"/ : /href="\/en\/contact"/);
    });
    it(`${lang}: Organization JSON-LD lists the services as knowsAbout and makesOffer (Service, no price)`, () => {
      const orgs = [studioJsonLd(lang), jsonLd(lang), whatsappJsonLd(lang, [])]
        .flatMap(g => g['@graph'] as Record<string, unknown>[])
        .filter(n => n['@id'] === 'https://ebda.app/#organization');
      expect(orgs.length).toBe(3);
      for (const org of orgs) {
        expect(org.knowsAbout).toEqual(serviceInfo(lang).map(s => s.name));
        const offers = org.makesOffer as { itemOffered: { '@type': string; name: string } }[];
        expect(offers.map(o => o.itemOffered['@type'])).toEqual(Array(7).fill('Service'));
        expect(JSON.stringify(offers)).not.toMatch(/price/i);
      }
    });
  }
});
