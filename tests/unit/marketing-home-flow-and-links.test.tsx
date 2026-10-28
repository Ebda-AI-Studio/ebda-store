// The home page is one flow with no repeats (every capability in ONE section), claims only what
// exists, and every link that leaves ebda.app opens in a new tab through the one shared SiteLink.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Home } from '../../apps/marketing/src/components/Home';
import { FeaturesPage } from '../../apps/marketing/src/components/FeaturesPage';
import { ComparePage } from '../../apps/marketing/src/components/ComparePage';
import { CAPABILITIES, CAPABILITY_IDS } from '../../apps/marketing/src/lib/capabilities';
import { COMPARE_SLUGS, LOCALES } from '../../apps/marketing/src/lib/site';
import {
  isAppFlowHref,
  isExternalHref,
  NEW_TAB_NOTE,
} from '../../apps/marketing/src/components/SiteLink';

const sectionsOf = (html: string) =>
  [...html.matchAll(/<section id="([a-z0-9]+)"[^>]*>(.*?)<\/section>/gs)].map(m => ({
    id: m[1],
    html: m[2],
  }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('home: one flow, no repeats', () => {
  for (const locale of LOCALES) {
    const html = renderToStaticMarkup(<Home locale={locale} />);
    const sections = sectionsOf(html);
    it(`${locale}: no capability (title) appears in more than one home section`, () => {
      for (const id of CAPABILITY_IDS) {
        const title = CAPABILITIES[locale][id].t;
        // the three feature sections; pricing lists plan contents, which is a different job
        const where = sections
          .filter(s => ['features', 'ainative', 'capabilities'].includes(s.id))
          .filter(s => textOf(s.html).includes(title))
          .map(s => s.id);
        expect(where, `${id} "${title}" is in ${where.join(', ')}`).toHaveLength(
          Math.min(where.length, 1)
        );
      }
    });
    it(`${locale}: AI writing and analytics are only in the AI section`, () => {
      const feat = sections.find(s => s.id === 'features')!;
      expect(feat.html).not.toContain('data-feature="ai"');
      const ai = sections.find(s => s.id === 'ainative')!;
      expect(ai.html).toContain('data-ai-area="ai"');
      expect(ai.html).toContain('data-ai-area="analytics"');
      expect(sections.find(s => s.id === 'capabilities')!.html).not.toContain('data-');
    });
  }
  it('ar: one spelling of "عشان" and the "كل اللي محتاجه" line only once', () => {
    const ar = textOf(renderToStaticMarkup(<Home locale="ar" />));
    expect(ar).not.toContain('علشان');
    expect(ar.match(/كل اللي محتاجه/g) ?? []).toHaveLength(1);
  });
  it('the WhatsApp card claims only what exists: a prefilled message the customer sends, and a push', () => {
    const ar = textOf(renderToStaticMarkup(<Home locale="ar" />));
    expect(ar).toContain('تأكيد الطلب على واتساب');
    expect(ar).not.toContain('الطلب يوصلك على واتساب');
    const en = textOf(renderToStaticMarkup(<Home locale="en" />));
    expect(en).toContain('Order confirmation on WhatsApp');
    expect(en).not.toContain('Orders land on WhatsApp');
  });
});

describe('links that leave ebda.app open in a new tab', () => {
  it('sign-up and log-in stay in the same tab; the rest of the app and other hosts do not (UI-15)', () => {
    expect(isAppFlowHref('https://store.ebda.app/signup?plan=growth&interval=month')).toBe(true);
    expect(isAppFlowHref('https://store.ebda.app/login')).toBe(true);
    expect(isAppFlowHref('https://store.ebda.app/dashboard')).toBe(false);
    expect(isAppFlowHref('https://example.com/signup')).toBe(false);
    expect(isAppFlowHref('/signup')).toBe(false);
  });

  it('isExternalHref decides by host', () => {
    expect(isExternalHref('https://store.ebda.app/signup')).toBe(true);
    expect(isExternalHref('https://storedemo-souq.ebda.app/?look=souq.night')).toBe(true);
    expect(isExternalHref('https://orders.ebda.app/')).toBe(true);
    expect(isExternalHref('https://wa.me/201514191411')).toBe(true);
    expect(isExternalHref('https://example.com/x')).toBe(true);
    expect(isExternalHref('https://ebda.app/features/')).toBe(false);
    expect(isExternalHref('https://www.ebda.app/')).toBe(false);
    for (const h of ['/features/', '/en/', '#looks', 'mailto:a@b.co', 'tel:+20100'])
      expect(isExternalHref(h)).toBe(false);
  });
  const pages: [string, JSX.Element][] = [];
  for (const locale of LOCALES) {
    pages.push([`home ${locale}`, <Home key="h" locale={locale} />]);
    pages.push([`features ${locale}`, <FeaturesPage key="f" locale={locale} />]);
    for (const slug of COMPARE_SLUGS)
      pages.push([
        `compare/${slug} ${locale}`,
        <ComparePage key={slug} locale={locale} slug={slug} />,
      ]);
  }
  for (const [name, el] of pages) {
    it(`${name}: every external <a> is _blank + noopener noreferrer + a hidden note; internal ones are same-tab`, () => {
      const html = renderToStaticMarkup(el);
      const locale = name.endsWith('ar') ? 'ar' : 'en';
      let external = 0;
      for (const m of html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)) {
        const attrs = m[1];
        const href = /href="([^"]*)"/.exec(attrs)?.[1]?.replace(/&amp;/g, '&');
        if (!href) continue;
        if (isExternalHref(href) && !isAppFlowHref(href)) {
          external++;
          expect(attrs, href).toContain('target="_blank"');
          expect(attrs, href).toMatch(/rel="noopener noreferrer"/);
          expect(m[0], href).toContain(NEW_TAB_NOTE[locale]);
        } else {
          expect(attrs, href).not.toContain('target=');
        }
      }
      expect(external).toBeGreaterThan(0);
    });
  }
  it('no marketing source renders a raw <a> to an external URL (use SiteLink)', () => {
    const root = path.resolve(__dirname, '../../apps/marketing/src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(f) && f !== 'SiteLink.tsx') files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<a\b[^>]*?href=(\{[^}]*\}|"[^"]*")[^>]*>/gs)) {
        const href = m[1];
        const external =
          /https?:\/\//.test(href) ||
          /SIGNUP_URL|LOGIN_URL|demoLookUrl|whatsappUrl|sourceUrl|licenseUrl/.test(href);
        if (external && !/target="_blank"/.test(m[0]))
          offenders.push(`${path.relative(root, f)}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
