import { describe, it, expect } from 'vitest';
import { COPY } from '../../apps/marketing/src/lib/content';

/**
 * Legal pages are formal Arabic (CLAUDE.md copy rule: Egyptian for marketing sentences, formal legal pages). This flags the
 * colloquial words that crept into the Ebda Chat terms, privacy policy and DPA (imported from the WhatsApp session's
 * markdown) and the "this page" label. Whole-word match on Arabic tokens, so a formal word that merely contains one of them
 * (e.g. «مشتري», «دينار») never trips it. Add a marker here when a new colloquial word shows up in review.
 */
const COLLOQUIAL = [
  'اللي',
  'بتاع',
  'بتاعت',
  'بتاعة',
  'بيتم',
  'بتتم',
  'ده',
  'دي',
  'دول',
  'مش',
  'مفيش',
  'عشان',
  'علشان',
  'إزاي',
  'ازاي',
  'كده',
  'دلوقتي',
  'بيعمل',
  'بنعالج',
  'بنستخدم',
  'مبنبيعش',
] as const;

const tokens = (t: string) => t.match(/[؀-ۿ]+/g) ?? [];

describe('Arabic legal pages carry no colloquial markers', () => {
  const pages = COPY.ar.legalPages;
  const docs = [
    'legal',
    'privacy',
    'terms',
    'acceptableUse',
    'merchant',
    'dataDeletion',
    'refund',
    'waTerms',
    'waPrivacy',
    'waDpa',
  ] as const;
  for (const key of docs) {
    it(key, () => {
      const d = pages[key];
      const text = [d.title, d.note ?? '', ...d.sections.flatMap(s => [s.h, ...s.p])].join('\n');
      const found = tokens(text).filter(w => (COLLOQUIAL as readonly string[]).includes(w));
      expect([...new Set(found)]).toEqual([]);
    });
  }
  it('the page chrome (toc, notice, back) is formal too', () => {
    const found = tokens([pages.toc, pages.notice, pages.back].join('\n')).filter(w =>
      (COLLOQUIAL as readonly string[]).includes(w)
    );
    expect(found).toEqual([]);
  });
  it('Ebda Chat and the studio are named in Arabic in the Arabic Ebda Chat pages', () => {
    for (const key of ['waTerms', 'waPrivacy', 'waDpa'] as const) {
      const d = pages[key];
      const text = [d.title, ...d.sections.flatMap(s => [s.h, ...s.p])].join('\n');
      expect(text, key).not.toMatch(/Ebda Chat|Ebda AI Studio/);
    }
  });
});
