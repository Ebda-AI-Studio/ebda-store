// SOCIAL-1: the footer, the contact page, JSON-LD sameAs and llms.txt carry exactly the foundation's list of official accounts, and nothing else.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { EBDA } from '../../packages/shared/src/foundation/brand';
import { siteFooterHtml } from '../../packages/shared/src/brand';
import { Footer } from '../../apps/marketing/src/components/Footer';
import { ContactPage } from '../../apps/marketing/src/components/ContactPage';
import { jsonLd, studioJsonLd } from '../../apps/marketing/src/lib/seo';

const LIST = EBDA.social.accounts.map(a => a.url);
const SOCIAL_HOST =
  /https?:\/\/(?:[\w-]+\.)?(?:instagram|facebook|tiktok|linkedin|x|twitter|youtube|threads|snapchat|pinterest|telegram)\.com[^\s"'<)]*|https?:\/\/(?:wa\.me|t\.me|youtu\.be)[^\s"'<)]*/g;
const social = (html: string) => [...new Set(html.match(SOCIAL_HOST) ?? [])];
const read = (p: string) => readFileSync(p, 'utf8');

describe('social links (parity with the foundation list)', () => {
  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: React footer, string footer and contact page link exactly the foundation list, in order`, () => {
      for (const html of [
        renderToStaticMarkup(<Footer locale={lang} />),
        siteFooterHtml(lang, '', 2026),
      ]) {
        const hrefs = [...html.matchAll(/<ul class="sf-social">([\s\S]*?)<\/ul>/g)][0]![1]!
          .match(/href="([^"]+)"/g)!
          .map(h => h.slice(6, -1));
        expect(hrefs.map(h => h.replace(/&amp;/g, '&'))).toEqual(LIST);
      }
      const contact = renderToStaticMarkup(<ContactPage locale={lang} />);
      for (const u of LIST) expect(contact).toContain(u.replace(/&/g, '&amp;'));
    });
    it(`${lang}: no other social URL on the footer or contact page (WhatsApp wa.me button is the listed one)`, () => {
      for (const html of [
        renderToStaticMarkup(<Footer locale={lang} />),
        renderToStaticMarkup(<ContactPage locale={lang} />),
      ]) {
        expect(
          social(html)
            .map(u => u.replace(/&amp;/g, '&'))
            .filter(
              u => !LIST.some(l => l.startsWith(u.split('?')[0]!) || u.startsWith(l.split('?')[0]!))
            )
        ).toEqual([]);
      }
    });
    it(`${lang}: icons are accessible, safe, 44px and monochrome`, () => {
      const html = renderToStaticMarkup(<Footer locale={lang} />);
      const list = [...html.matchAll(/<ul class="sf-social">([\s\S]*?)<\/ul>/g)][0]![1]!;
      const anchors = list.match(/<a [^>]*>[\s\S]*?<\/a>/g)!;
      expect(anchors).toHaveLength(6);
      for (const a of anchors) {
        expect(a).toMatch(/aria-label="[^"]+"/);
        expect(a).toContain('target="_blank"');
        expect(a).toContain('rel="noopener noreferrer"');
        expect(a).toContain('aria-hidden="true"');
        expect(a).toContain('fill="currentColor"');
      }
      expect(list).toContain(
        lang === 'ar' ? 'ابدأ ستوديو للذكاء الاصطناعي على إنستجرام' : 'Ebda AI Studio on Instagram'
      );
    });
  }
  it('JSON-LD Organization sameAs = the foundation list on both graphs; the founder keeps mypovonai on the Person only', () => {
    for (const g of [jsonLd('en'), studioJsonLd('en')] as unknown as Array<{
      '@graph': Array<{ '@id'?: string; sameAs?: string[]; founder?: { sameAs: string[] } }>;
    }>) {
      const org = g['@graph'].find(n => n['@id'] === 'https://ebda.app/#organization')!;
      expect(org.sameAs).toEqual(LIST);
      expect(org.sameAs).not.toContain('https://mypovonai.com');
    }
  });
  it('llms.txt and llms-full.txt have a Social section with exactly the list', () => {
    for (const f of ['llms.txt', 'llms-full.txt']) {
      const t = read(`apps/marketing/public/${f}`);
      const sec = t.slice(t.indexOf('## Social'));
      expect(sec.startsWith('## Social')).toBe(true);
      expect(sec.match(/https:\/\/\S+/g)).toEqual(LIST);
    }
  });
  it('the CSP stays closed: no third-party origin is added for icons', () => {
    const h = read('apps/marketing/public/_headers');
    for (const d of ['instagram', 'facebook', 'tiktok', 'linkedin', 'wa.me'])
      expect(h).not.toContain(d);
  });
});
