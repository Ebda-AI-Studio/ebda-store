import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BRAND } from '../../packages/shared/src/brand';
import { LegalPage } from '../../apps/marketing/src/components/LegalPage';
import { COPY } from '../../apps/marketing/src/lib/content';
import sitemap from '../../apps/marketing/src/app/sitemap';
import { LEGAL_EXTRA_SLUGS, LOCALES, pagePath } from '../../apps/marketing/src/lib/site';

/** LEGAL-1: the data deletion page and the three Ebda Chat documents under /legal/. */
const KEY = {
  'legal/data-deletion': 'dataDeletion',
  refund: 'refund',
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

  it('terms and merchant agreement: prices are final amounts, no VAT (Ruling VAT-0), 72-hour breach notice, WhatsApp pointer', () => {
    for (const k of ['terms', 'merchant'] as const) {
      expect(allText('en', [k])).not.toContain('14%');
      expect(allText('ar', [k])).not.toContain('14%');
    }
    expect(allText('en', ['terms'])).toContain('not registered for value-added tax (VAT)');
    expect(allText('en', ['terms'])).toContain('at least 30 days of written notice'); // VAT would arrive as a fee change
    expect(allText('en', ['terms'])).toContain('/legal/whatsapp-terms/');
    expect(allText('en', ['merchant'])).toContain('72 hours');
    expect(allText('ar', ['merchant'])).toContain('72 ساعة');
    expect(allText('en', ['acceptableUse'])).toContain('prescription drugs');
  });

  it('DOC-1: no page promises a dashboard flow for closing the account or deleting the store (it does not exist)', () => {
    for (const l of LOCALES) {
      const t = allText(l, ['terms', 'dataDeletion', 'privacy']);
      expect(t).not.toMatch(/close (your|the) account[^.]*from the dashboard/i);
      expect(t).not.toMatch(/إغلاق حسابك[^.]*من لوحة التحكم|أغلق الحساب من لوحة التحكم/);
      expect(t).toContain('privacy@ebda.app');
    }
  });

  it('Ruling VAT-0: the Terms and the Merchant Agreement carry docs/legal/VAT-0-clause.md word for word, in both languages', () => {
    const md = readFileSync(path.resolve(__dirname, '../../docs/legal/VAT-0-clause.md'), 'utf8');
    const en = /## English\n\n(.+)\n/.exec(md)![1];
    const ar = /## العربية\n\n(.+)\n/.exec(md)![1];
    // the Ebda Chat terms (clause 6.6, WA PR #25) carry the same clause verbatim
    expect(COPY.en.legalPages.waTerms.sections.flatMap(s => s.p).join('\n')).toContain(en);
    expect(COPY.ar.legalPages.waTerms.sections.flatMap(s => s.p).join('\n')).toContain(ar);
    for (const k of ['terms', 'merchant'] as const) {
      expect(COPY.en.legalPages[k].sections.flatMap(s => s.p).join('\n'), `en ${k}`).toContain(en);
      expect(COPY.ar.legalPages[k].sections.flatMap(s => s.p).join('\n'), `ar ${k}`).toContain(ar);
    }
  });

  it('P12 / M-034: /refund restates the Terms, stands as final (LEGAL-FINAL-1), carries the VAT-0 clause, and BRAND points at it', () => {
    const md = readFileSync(path.resolve(__dirname, '../../docs/legal/VAT-0-clause.md'), 'utf8');
    const en = /## English\n\n(.+)\n/.exec(md)![1];
    const ar = /## العربية\n\n(.+)\n/.exec(md)![1];
    for (const [l, clause] of [
      ['en', en],
      ['ar', ar],
    ] as const) {
      const doc = COPY[l].legalPages.refund;
      const text = doc.sections.flatMap(s => [s.h, ...s.p]).join('\n');
      expect(doc.note, `${l} note`).toBeTruthy(); // the Terms and the Merchant Agreement prevail: said under the title
      // Ahmad 2026-11-10 (LEGAL-FINAL-1): the texts stand as our terms from launch, no "provisional" note
      expect(`${doc.note}\n${text}`).not.toMatch(/counsel|provisional|Provisional|مبدئ|محامٍ/);
      expect(text).toContain(clause);
      // C22: each language points at its own page
      expect(text).toContain(
        l === 'en'
          ? 'https://ebda.app/en/legal/whatsapp-terms/'
          : 'https://ebda.app/legal/whatsapp-terms/'
      );
    }
    // the same no-refund rule the Merchant Agreement states (section 11)
    expect(COPY.en.legalPages.refund.sections.flatMap(s => s.p).join(' ')).toContain(
      'not refundable'
    );
    expect(COPY.en.legalPages.merchant.sections.flatMap(s => s.p).join(' ')).toContain(
      'non-refundable'
    );
    expect(BRAND.legalUrls.refunds).toBe('https://ebda.app/refund/');
  });
});
