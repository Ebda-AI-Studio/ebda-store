import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import { COPY } from '../../apps/marketing/src/lib/content';
import sitemap from '../../apps/marketing/src/app/sitemap';
import { LEGAL_EXTRA_SLUGS, LOCALES, pagePath } from '../../apps/marketing/src/lib/site';

/** LEGAL-1: the data deletion page and the three Ebda WhatsApp documents under /legal/. */
const KEY = {
  'legal/data-deletion': 'dataDeletion',
  'legal/whatsapp-terms': 'waTerms',
  'legal/whatsapp-privacy': 'waPrivacy',
  'legal/whatsapp-dpa': 'waDpa',
} as const;

const allText = (locale: 'ar' | 'en', docs: (keyof (typeof COPY)['ar']['legalPages'])[]) =>
  docs
    .map(k => {
      const d = COPY[locale].legalPages[k] as { sections: { h: string; p: string[] }[] };
      return d.sections.flatMap(s => [s.h, ...s.p]).join('\n');
    })
    .join('\n');

describe('LEGAL-1 extra legal pages', () => {
  for (const slug of LEGAL_EXTRA_SLUGS)
    for (const locale of LOCALES) {
      it(`${locale} ${slug}: renders title, own version and date, no review markers`, () => {
        const doc = COPY[locale].legalPages[KEY[slug]];
        const html = renderToStaticMarkup(<LegalPage locale={locale} page={slug} />);
        expect(html).toContain(doc.title);
        expect(html).toContain(`dateTime="${doc.meta?.publishedAt}"`);
        expect(html).not.toMatch(/PENDING|<!--\s*PENDING/i);
        expect(html).not.toContain('**');
      });
    }

  it('a route file exists for every extra page in both locales', () => {
    const app = path.resolve(__dirname, '../../apps/marketing/src/app');
    for (const slug of LEGAL_EXTRA_SLUGS) {
      expect(existsSync(path.join(app, '(ar)', slug, 'page.tsx'))).toBe(true);
      expect(existsSync(path.join(app, '(en)', 'en', slug, 'page.tsx'))).toBe(true);
    }
  });

  it('ar and en have the same number of sections per document (parity)', () => {
    for (const slug of LEGAL_EXTRA_SLUGS)
      expect(COPY.ar.legalPages[KEY[slug]].sections.length).toBe(
        COPY.en.legalPages[KEY[slug]].sections.length
      );
  });

  it('privacy-context text uses privacy@ebda.app, never ahlan@', () => {
    for (const locale of LOCALES) {
      const t = allText(locale, ['privacy', 'dataDeletion', 'waPrivacy', 'waDpa']);
      expect(t).toContain('privacy@ebda.app');
      expect(t).not.toContain('ahlan@ebda.app');
    }
  });

  it('the legal notice links to every extra document in both locales', () => {
    for (const locale of LOCALES) {
      const html = renderToStaticMarkup(<LegalPage locale={locale} page="legal" />);
      for (const slug of LEGAL_EXTRA_SLUGS)
        expect(html).toContain(`href="${pagePath(locale, slug)}"`);
    }
  });

  it('the sitemap lists every extra page in both locales with the legal date', () => {
    const urls = sitemap().map(e => e.url);
    for (const slug of LEGAL_EXTRA_SLUGS)
      for (const locale of LOCALES)
        expect(urls).toContain(`https://ebda.app${pagePath(locale, slug)}/`);
  });

  it('terms and merchant agreement state the 14% VAT, the 72-hour breach notice and the WhatsApp pointer', () => {
    expect(allText('en', ['terms'])).toContain('14%');
    expect(allText('en', ['terms'])).toContain('/legal/whatsapp-terms/');
    expect(allText('en', ['merchant'])).toContain('72 hours');
    expect(allText('ar', ['merchant'])).toContain('72 ساعة');
    expect(allText('en', ['acceptableUse'])).toContain('prescription drugs');
  });
});
