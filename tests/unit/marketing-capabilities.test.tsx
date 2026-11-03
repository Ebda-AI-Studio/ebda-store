/**
 * apps/marketing capability surface: /features and /compare/{zid,shopify} exist in ar + en,
 * are in the sitemap with alternates, are named in robots' sitemap + llms.txt, carry the brand
 * line, stay honest (every compare page lists what Ebda does not have), and never leak the
 * inherited brands or the orange the Ebda palette forbids.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sitemap from '../../apps/marketing/src/app/sitemap';
import robots from '../../apps/marketing/src/app/robots';
import { jsonLd, brandLine } from '../../apps/marketing/src/lib/seo';
import { ComparePage } from '../../apps/marketing/src/components/ComparePage';
import { FeaturesPage } from '../../apps/marketing/src/components/FeaturesPage';
import { Home } from '../../apps/marketing/src/components/Home';
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  featuresFaq,
} from '../../apps/marketing/src/lib/capabilities';
import {
  ALL_ROW_IDS,
  CHECKED_ON,
  CHECKED_ON_AR,
  COMPARE,
  compareRows,
} from '../../apps/marketing/src/lib/compare';
import { COMPARE_SLUGS, LOCALES, pagePath } from '../../apps/marketing/src/lib/site';

const APP = path.resolve(__dirname, '../../apps/marketing');
const pub = (f: string) => readFileSync(path.join(APP, 'public', f), 'utf8');
// Built from halves so this file itself names no inherited brand (tests/unit/no-force-branding.test.ts).
const BAD = new RegExp(
  [
    'For' + 'ce AI',
    'Force' + 'AI',
    'force' + '-ai',
    '\\bFW' + 'B\\b',
    '\\bFor' + 'ce\\b',
    'Kuw' + 'ait',
    'الكو' + 'يت',
    '\\bK' + 'WD\\b',
    '#ff6e' + '01',
    '#ff6f' + '00',
    'oran' + 'ge',
  ].join('|'),
  'i'
);

const routeFile = (locale: 'ar' | 'en', page: string) =>
  path.join(APP, 'src/app', locale === 'ar' ? '(ar)' : '(en)/en', page, 'page.tsx');

describe('every /features and /compare page exists in ar + en', () => {
  for (const locale of LOCALES) {
    for (const page of ['features', ...COMPARE_SLUGS.map(s => `compare/${s}`)]) {
      it(`${locale} ${page}: route file, sitemap entry, hreflang`, () => {
        expect(existsSync(routeFile(locale, page))).toBe(true);
        const url = `https://ebda.app${pagePath(locale, page as never)}/`.replace('//', '//');
        const e = sitemap().find(x => x.url === url);
        expect(e, `${url} in sitemap`).toBeTruthy();
        expect(Object.keys(e!.alternates!.languages!).sort()).toEqual(['ar', 'en', 'x-default']);
      });
    }
  }
  it('robots points at the sitemap that lists them', () => {
    expect(robots().sitemap).toBe('https://ebda.app/sitemap.xml');
  });
});

describe('/features', () => {
  for (const locale of LOCALES) {
    const html = renderToStaticMarkup(<FeaturesPage locale={locale} />);
    it(`${locale}: one block per capability, FAQ, compare links, no forbidden strings`, () => {
      for (const id of CAPABILITY_IDS) expect(html).toContain(`data-capability="${id}"`);
      expect(html.match(/<h1/g)).toHaveLength(1);
      for (const f of featuresFaq(locale)) expect(html).toContain(f.q);
      for (const s of COMPARE_SLUGS)
        expect(html).toContain(`href="${pagePath(locale, `compare/${s}` as never)}"`);
      expect(html).not.toMatch(BAD);
    });
    it(`${locale}: JSON-LD has a FAQPage with the features FAQ`, () => {
      const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)!;
      const g = JSON.parse(m[1].replace(/\\u003c/g, '<'))['@graph'];
      const faq = g.find((n: { '@type': string }) => n['@type'] === 'FAQPage');
      expect(faq.mainEntity).toHaveLength(featuresFaq(locale).length);
    });
  }
  it('home shows the capabilities section in both locales and links to /features', () => {
    for (const locale of LOCALES) {
      const html = renderToStaticMarkup(<Home locale={locale} />);
      expect(html).toMatch(/<section id="capabilities"/);
      expect(html).toContain(`href="${pagePath(locale, 'features')}"`);
    }
  });
});

describe('/compare is balanced', () => {
  for (const slug of COMPARE_SLUGS) {
    for (const locale of LOCALES) {
      it(`${locale} ${slug}: says where Ebda is stronger AND not yet, dated, no forbidden strings`, () => {
        const html = renderToStaticMarkup(<ComparePage locale={locale} slug={slug} />);
        // verdicts of "stronger" either way only where the fact is firmly public: Shopify, or a vendor whose
        // pages were read and are cited (`sources`)
        if (COMPARE[slug].sources) {
          expect(/data-verdict="(ebda|them)"/.test(html)).toBe(true);
        } else {
          expect(html.includes('data-verdict="ebda"')).toBe(slug === 'shopify');
          expect(html.includes('data-verdict="them"')).toBe(slug === 'shopify');
        }
        for (const r of [...compareRows().gap, ...compareRows().strength])
          expect(html).toContain(r.label[locale]);
        expect(html).toContain(locale === 'en' ? 'October 2026' : 'أكتوبر 2026');
        expect(html).not.toMatch(BAD);
        // JSON-LD on a compare page carries no FAQPage
        expect(html).not.toContain('FAQPage');
      });
    }
  }
  it('every row has a cell for every vendor, and the permanent gaps stay in the not-yet table', () => {
    const gap = compareRows().gap.map(r => r.id);
    for (const id of ['apps', 'code', 'pos', 'multicur']) expect(gap).toContain(id);
    for (const slug of COMPARE_SLUGS)
      for (const id of ALL_ROW_IDS) expect(COMPARE[slug].cells[id]).toBeTruthy();
  });
  it('uses no invented numbers about competitors (digits only in the Ebda column, or where the page cites its sources)', () => {
    for (const slug of COMPARE_SLUGS.filter(s => !COMPARE[s].sources))
      for (const id of ALL_ROW_IDS)
        for (const l of LOCALES)
          expect(COMPARE[slug].cells[id].text[l].replace(/B2B/g, '')).not.toMatch(/\d/);
  });
});

describe('sourced compare pages (Wuilt, YouCan, EasyOrders, ExpandCart)', () => {
  const sourced = COMPARE_SLUGS.filter(s => COMPARE[s].sources);
  it('exactly the four Egyptian alternatives carry sources', () => {
    expect(sourced).toEqual(['wuilt', 'youcan', 'easyorders', 'expandcart']);
  });
  for (const slug of sourced)
    for (const locale of LOCALES) {
      it(`${locale} ${slug}: cites https sources dated 2 November 2026 as new-tab links, says where they are cheaper, invents nothing`, () => {
        const html = renderToStaticMarkup(<ComparePage locale={locale} slug={slug} />);
        expect(html).toContain(locale === 'en' ? CHECKED_ON : CHECKED_ON_AR);
        for (const src of COMPARE[slug].sources!) {
          expect(src.href).toMatch(/^https:\/\//);
          expect(html).toMatch(
            new RegExp(
              `href="${src.href.replace(/[.*+?^$()|[\]\\/]/g, '\\$&')}"[^>]*target="_blank"`
            )
          );
        }
        // honesty: a row where the other platform is stronger (price/features) unless the sourced facts show none, and unverified items say so
        expect(html).toContain(slug === 'youcan' ? 'data-verdict="ebda"' : 'data-verdict="them"');
        const unverified = locale === 'en' ? /nverified/ : /غير مؤكد/;
        const cells = ALL_ROW_IDS.map(id => COMPARE[slug].cells[id].text[locale]).join(' ');
        expect(cells.length).toBeGreaterThan(0);
        if (slug !== 'easyorders') expect(cells).toMatch(unverified);
        expect(html).not.toMatch(BAD);
      });
    }
  it('cheaper-for-small-sellers vendors say so in the price cell, in both languages', () => {
    expect(COMPARE.wuilt.cells.currency.v).toBe('them');
    expect(COMPARE.wuilt.en.chooseThem[0]).toMatch(/nobody on payroll|few pages/);
    expect(COMPARE.youcan.cells.commission.v).toBe('ebda');
    expect(COMPARE.wuilt.cells.currency.text.en).toContain('1,250');
    expect(COMPARE.wuilt.cells.currency.text.en).toContain('Business EGP 17,500');
    expect(COMPARE.expandcart.cells.commission.text.en).toContain('no commissions');
  });
  it('COMPARE-1 (2 November 2026): corrected figures, EGP for ExpandCart, nothing unverifiable for EasyOrders', () => {
    const yc = COMPARE.youcan.cells;
    expect(yc.currency.text.en).toContain('Premium $149');
    expect(yc.currency.text.en).toContain('Unlimited plan (up to 5 stores) at $229');
    expect(yc.currency.text.en).not.toContain('$187');
    expect(yc.commission.text.en).toContain('$0 in transaction fees');
    expect(yc.commission.text.en).toContain('pay-as-you-go');
    expect(yc.commission.text.ar).toContain('0$ رسوم معاملات');
    const ec = COMPARE.expandcart.cells.currency.text;
    for (const n of ['599', '1,199', '4,599']) expect(ec.en).toContain(n);
    expect(ec.en).not.toMatch(/\$19|\$39|\$1,499/);
    const eo = JSON.stringify([
      COMPARE.easyorders.cells,
      COMPARE.easyorders.en,
      COMPARE.easyorders.ar,
    ]);
    expect(eo).not.toMatch(/0\.04|\$100|100\$|4 سنت/);
    expect(COMPARE.easyorders.cells.currency.v).toBe('even');
    expect(CHECKED_ON).toBe('2 November 2026');
  });
});

describe('llms.txt and llms-full.txt', () => {
  const llms = pub('llms.txt');
  const full = pub('llms-full.txt');
  it('llms.txt links every features and compare page in both locales and llms-full.txt', () => {
    for (const locale of LOCALES) {
      expect(llms).toContain(`https://ebda.app${pagePath(locale, 'features')}/`);
      for (const s of COMPARE_SLUGS)
        expect(llms).toContain(`https://ebda.app${pagePath(locale, `compare/${s}` as never)}/`);
    }
    expect(llms).toContain('https://ebda.app/llms-full.txt');
    expect(llms).toMatch(/^# Ebda AI Studio/);
    expect(llms).toContain('Ebda Store — ابدأ ستور, by Ebda AI Studio (ebda.app)');
    expect(llms).toMatch(/## Not there yet/);
    expect(llms).not.toMatch(BAD);
  });
  it('llms-full.txt carries every capability title (English), the FAQ and the comparisons', () => {
    for (const id of CAPABILITY_IDS) expect(full).toContain(CAPABILITIES.en[id].t);
    for (const f of featuresFaq('en')) expect(full).toContain(f.q);
    for (const s of COMPARE_SLUGS) expect(full).toContain(`/en/compare/${s}/`);
    expect(full).not.toMatch(BAD);
  });
});

describe('brand disambiguation', () => {
  it('brandLine is the one agreed string', () => {
    expect(brandLine()).toBe('Ebda Store — ابدأ ستور, by Ebda AI Studio (ebda.app)');
  });
  it('JSON-LD names Ebda Store with Ebda AI Studio as parent, url ebda.app', () => {
    for (const locale of LOCALES) {
      const g = jsonLd(locale)['@graph'] as {
        '@type': string;
        name?: string;
        parentOrganization?: unknown;
      }[];
      const brand = g.find(n => n.name === 'Ebda Store' && n['@type'] === 'Organization');
      expect(brand?.parentOrganization).toBeTruthy();
    }
  });
});
