/**
 * Y-01 (Qamar taste audit 2026-10-15, quality-bar § 2): counted nouns go through
 * the ONE plural helper (`apps/web/src/lib/plural.ts`, exposed as
 * `useLanguage().tn`). Concatenating a number and a noun printed "1 منتجات" and
 * "1 items" on the cart; the hand-rolled Arabic rules that existed (receipt,
 * delivery chip, return policy, shipping estimate) disagreed with each other on
 * 11+ ("يوم" / "يوماً" / "يوم عمل").
 *
 * Part 1 pins the helper (Arabic 0/1/2/3/11/100, English 1/2, ranges).
 * Part 2 is the gate: no number + noun concatenation, no hand-rolled plural.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  plural,
  countText,
  ITEMS,
  PIECES,
  RESULTS,
  DAYS,
  BUSINESS_DAYS,
  VERIFIED_REVIEWS,
  ITEMS_ADDED,
  ITEMS_NEED_OPTIONS,
  STARS,
} from '../../apps/web/src/lib/plural';
import { formatEstimatedDays } from '../../apps/web/src/lib/delivery-estimate';
import { daysPhrase } from '../../apps/web/src/lib/return-policy-text';
import { categoryCountText } from '../../apps/web/src/lib/category-count-unit';

describe('Y-01: the plural helper', () => {
  it('Arabic picks all six forms (0/1/2/3/11/100)', () => {
    const ar = (n: number) => countText('ar', n, ITEMS);
    expect(ar(0)).toBe('0 قطعة');
    expect(ar(1)).toBe('قطعة واحدة');
    expect(ar(2)).toBe('قطعتين'); // Egyptian dual (Ruling FU46-Y02a)
    expect(ar(3)).toBe('3 قطع');
    expect(ar(10)).toBe('10 قطع');
    expect(ar(11)).toBe('11 قطعة');
    expect(ar(100)).toBe('100 قطعة');
  });

  it('Arabic days in Egyptian (يوم واحد / يومين / ٣ أيام / ١١ يوم / ١٠٠ يوم)', () => {
    expect(countText('ar', 1, DAYS)).toBe('يوم واحد');
    expect(countText('ar', 2, DAYS)).toBe('يومين');
    expect(daysPhrase(2, 'ar')).toBe('يومين'); // "خلال يومين": one form in every position
    expect(countText('ar', 3, DAYS)).toBe('3 أيام');
    expect(countText('ar', 11, DAYS)).toBe('11 يوم');
    expect(countText('ar', 100, DAYS)).toBe('100 يوم');
  });

  it('English: 1 is singular, 2 is plural', () => {
    expect(countText('en', 1, ITEMS)).toBe('1 item');
    expect(countText('en', 2, ITEMS)).toBe('2 items');
    expect(countText('en', 1, RESULTS)).toBe('1 result');
    expect(countText('en', 2, VERIFIED_REVIEWS)).toBe('2 verified reviews');
    expect(countText('en', 0, PIECES)).toBe('0 pieces');
  });

  it('Egyptian register (Ruling FU46-Y02a): the -ين dual everywhere, bare singular at 11+', () => {
    expect(countText('ar', 2, ITEMS_ADDED)).toBe('اتضافت قطعتين لسلتك');
    expect(countText('ar', 2, RESULTS)).toBe('نتيجتين');
    expect(countText('ar', 2, VERIFIED_REVIEWS)).toBe('مراجعتين موثّقتين');
    expect(countText('ar', 2, BUSINESS_DAYS)).toBe('يومين عمل');
    expect(countText('ar', 2, STARS)).toBe('نجمتين');
    expect(countText('ar', 2, ITEMS_NEED_OPTIONS)).toBe('منتجين محتاجين تختار نوعهم');
    const nouns = [
      ITEMS,
      RESULTS,
      VERIFIED_REVIEWS,
      DAYS,
      BUSINESS_DAYS,
      ITEMS_ADDED,
      ITEMS_NEED_OPTIONS,
      STARS,
    ];
    for (const noun of nouns) {
      // no MSA nominative dual (-ان / -ا before a construct) and no tanween accusative
      for (const form of Object.values(noun.ar)) {
        expect(form, form).not.toMatch(/(?:تان|ان|يوما)(?:\s|$)/);
        expect(form, form).not.toMatch(/[\u064B\u064C\u064D]|اً/);
      }
      expect(noun.ar.two ?? '', JSON.stringify(noun.ar)).toMatch(/ين(?:\s|$)/);
    }
  });

  it('the displayed number can be the render digits', () => {
    expect(countText('ar', 3, ITEMS, '٣')).toBe('٣ قطع');
    expect(countText('ar', 1, ITEMS, '١')).toBe('قطعة واحدة');
  });

  it('a range keeps its numbers even where the form spells them out', () => {
    expect(plural('ar', 2, BUSINESS_DAYS.ar, '1–2')).toBe('1–2 أيام عمل');
    expect(formatEstimatedDays({ estimatedDaysMin: 2, estimatedDaysMax: 4 }, 'ar')).toBe(
      '2–4 أيام عمل'
    );
    expect(formatEstimatedDays({ estimatedDaysMin: 5, estimatedDaysMax: 12 }, 'ar')).toBe(
      '5–12 يوم عمل'
    );
    expect(formatEstimatedDays({ estimatedDaysMin: 2, estimatedDaysMax: 4 }, 'en')).toBe(
      '2–4 business days'
    );
  });

  it('the old hand-rolled helpers now agree with it', () => {
    expect(daysPhrase(14, 'ar')).toBe('14 يوم');
    expect(daysPhrase(1, 'en')).toBe('1 day');
    expect(formatEstimatedDays({ estimatedDays: 2 }, 'ar')).toBe('يومين عمل');
    expect(daysPhrase(2, 'ar')).toBe('يومين'); // every caller says "خلال …"
    expect(daysPhrase(14, 'ar', n => n.toLocaleString('ar-EG'))).toBe('١٤ يوم');
    expect(categoryCountText(undefined, true, 1)).toBe('قطعة واحدة');
    expect(categoryCountText(undefined, false, 4)).toBe('4 pieces');
    // A merchant's own unit word is printed as typed (it cannot be declined).
    expect(categoryCountText({ categoryCountUnit: { en: 'looks', ar: 'إطلالة' } }, true, 4)).toBe(
      '4 إطلالة'
    );
  });
});

/* ── Part 2: the gate ─────────────────────────────────────────────────── */

const ROOT = join(__dirname, '../..');
const WEB = join(ROOT, 'apps/web/src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|ts)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

const NUM = String.raw`(?:\w*[cC]ount\w*|\w*[tT]otal\w*|[\w.]*\.length|qty|quantity|stock|reviews|days|n)`;
const NOUN_START = String.raw`(?:t\(|isRtl\b|isAr\b|(?:lang|language|locale)\s*===|\w*[uU]nit\b)`;
export const CONCAT: RegExp[] = [
  // JSX: {cartCount} {t('items', 'منتجات')}
  new RegExp(String.raw`\{[^{}]*\b${NUM}\b[^{}]*\}\s*\{\s*${NOUN_START}`),
  // template: `${count} ${t('pieces', 'قطعة')}`
  new RegExp(String.raw`\$\{[^{}]*\b${NUM}\b[^{}]*\}\s+\$\{\s*${NOUN_START}`),
  // hand-rolled English plural: n === 1 ? 'item' : 'items', > 1 ? 's' : ''
  /(?:[!=]==|[<>]=?)\s*1\s*\?\s*['"`](?:items?|reviews?|days?|results?|pieces?|s|)['"`]/,
  // hand-rolled Arabic plural: n <= 10 ? 'قطع' : 'قطعة'
  /<=\s*10\s*\?/,
  // number then a hard-coded English counted noun: `Cart, ${cartCount} items`
  new RegExp(
    String.raw`\$\{[^{}]*\b${NUM}\b[^{}]*\}\s+(?:items?|reviews?|days?|results?|pieces?)\b`
  ),
  // number then a hard-coded Arabic counted noun: `${n} قطع`
  /\$\{[^{}]*\}\s+(?:قطع|قطعة|منتج|منتجات|أيام|يوم|نتائج|نتيجة|مراجعات|مراجعة)(?![؀-ۿ])/,
];

/** The sanctioned joins, each with its reason. */
const ALLOW: Record<string, string> = {
  'apps/web/src/lib/category-count-unit.ts':
    'a merchant-configured unit word is printed as typed (it cannot be declined)',
};

describe('Y-01 gate: no number + noun concatenation on the storefront', () => {
  const files = walk(WEB);

  it('scans the storefront', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no concatenated or hand-rolled counted noun', () => {
    const hits = files
      .filter(f => !ALLOW[relative(ROOT, f)])
      .flatMap(f =>
        readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((l, i) =>
            CONCAT.some(r => r.test(l)) ? [`${relative(ROOT, f)}:${i + 1}: ${l.trim()}`] : []
          )
      );
    expect(hits).toEqual([]);
  });

  it('the matcher catches the old shapes and spares the helper (self-test)', () => {
    const hit = (l: string) => CONCAT.some(r => r.test(l));
    expect(hit(`{cartCount} {t('items', 'منتجات')}{' '}`)).toBe(true);
    expect(hit(`{products.length} {t('result', 'نتيجة')}`)).toBe(true);
    expect(hit("meta={count ? `${localize(count)} ${t('pieces', 'قطعة')}` : undefined}")).toBe(
      true
    );
    expect(hit('{category.productCount} {countUnit}')).toBe(true);
    expect(hit("`${itemCount} ${itemCount === 1 ? 'item' : 'items'}`")).toBe(true);
    expect(hit("`${n} item${n > 1 ? 's' : ''}`")).toBe(true);
    expect(hit("return `${localize(n)} ${n <= 10 ? 'قطع' : 'قطعة'}`;")).toBe(true);
    expect(hit('t(`Cart, ${cartCount} items`, `السلة، ${localize(cartCount)} قطع`)')).toBe(true);
    expect(hit('{countText(lang, cartCount, ITEMS, localize(cartCount))}')).toBe(false);
    expect(hit("{t('Qty', 'الكمية')}: {row.item.quantity}")).toBe(false);
    expect(hit('`${name} removed from cart`')).toBe(false);
  });
});
