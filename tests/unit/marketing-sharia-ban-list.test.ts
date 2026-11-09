import { describe, it, expect } from 'vitest';
import { COPY } from '../../apps/marketing/src/lib/content';

/**
 * SHARIA-AUP-1 / SHARIA-GOLD-1 / SHARIA-BNPL-1 (Ahmad, 2026-11-03): the same ban list must stand in the Ebda Store policies
 * (acceptable use + merchant agreement) and in the Ebda Chat terms (9.1 and 9.2), in Arabic and in English, so a re-import of one
 * side or an edit of the other cannot silently drop an item. The Store terms of service incorporate the acceptable use policy and
 * carry the suspension clause; the merchant agreement carries the gold prepaid default and the instalment disclosure.
 */
const text = (d: { sections: { h: string; p: readonly string[] }[] }) =>
  d.sections.flatMap(s => [s.h, ...s.p]).join('\n');

const BAN: Record<'ar' | 'en', Record<string, RegExp>> = {
  ar: {
    alcohol: /الكحولي|المشروبات الكحولية/,
    pork: /لحم الخنزير/,
    paidDraw: /السحوبات/,
    mystery: /الصناديق الغامضة|صندوق غامض/,
    fakeReviews: /التقييمات[^.؛]{0,20}المزيفة|التقييمات والشهادات المزيفة/,
    fakeScarcity: /الندرة (المزيفة|المصطنعة)/,
  },
  en: {
    alcohol: /alcohol/i,
    pork: /pork/i,
    paidDraw: /prize draws/i,
    mystery: /mystery box/i,
    fakeReviews: /fake[^.;]{0,80}reviews/i,
    fakeScarcity: /fake scarcity/i,
  },
};

describe.each(['ar', 'en'] as const)('%s', lang => {
  const pages = COPY[lang].legalPages;
  const store = text(pages.acceptableUse) + '\n' + text(pages.merchant);
  const chat = text(pages.waTerms);

  for (const [item, re] of Object.entries(BAN[lang])) {
    it(`ban list item "${item}" is in the Store policies`, () => {
      expect(store).toMatch(re);
    });
    it(`ban list item "${item}" is in the Ebda Chat terms`, () => {
      expect(chat).toMatch(re);
    });
  }

  it('the Ebda Chat terms carry the removal and suspension clause (9.2)', () => {
    expect(chat).toMatch(
      lang === 'ar' ? /إزالة أي محتوى[\s\S]{0,120}إيقاف/ : /remove any content[\s\S]{0,120}suspend/i
    );
  });

  it('the Store terms incorporate the acceptable use policy and carry the suspension clause', () => {
    const terms = text(pages.terms);
    expect(terms).toMatch(lang === 'ar' ? /سياسة الاستخدام المقبول/ : /Acceptable Use Policy/);
    expect(terms).toMatch(lang === 'ar' ? /إيقاف/ : /suspend/i);
  });

  it('the merchant agreement says gold orders are paid in full online by default and instalments are off by default', () => {
    const m = text(pages.merchant);
    expect(m).toMatch(
      lang === 'ar' ? /التقسيط[^.]{0,60}معطّلة افتراضيًا/ : /Installment[^.]*off by default/
    );
    expect(m).toMatch(
      lang === 'ar'
        ? /ذهبًا[\s\S]{0,200}كاملًا عبر الإنترنت/
        : /gold[\s\S]{0,200}paid in full online/
    );
  });
});
