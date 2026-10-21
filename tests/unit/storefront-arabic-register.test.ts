/**
 * Ruling FU46-Y02 (quality bar Y-02): every Arabic string the STOREFRONT generates is Modern
 * Standard Arabic. B0-46 T15 swept the Egyptian colloquial copy out (the receipt's "طلبك اتسجل",
 * the delivery chip's "يوصلك", the InstaPay uploader, the 404 page, the editor placeholders...);
 * this keeps it out.
 *
 * Scope: Arabic string literals in `apps/web/src` and `packages/ui/src` (tests excluded), plus the
 * shopper-facing `messageAr` answers the API sends. NOT in scope: `components/landing/` (Ebda's
 * own marketing landing, not a store), the admin, help and merchant docs (merchant voice), and
 * anything a merchant types (it is data, never in code).
 *
 * The matcher is a list of colloquial words that have no MSA reading, matched as whole words, so
 * it cannot fire inside an MSA word. It is a floor, not a grammar checker: the copy review still
 * owns register.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');

/**
 * Ahmad 2026-10-16 reversed Y-02 for full sentences (Egyptian Arabic; short labels stay neutral).
 * main's fix/ahmad-decisions-1016 replaces this gate; until this branch rebases onto it, the
 * sentences W5 wrote in the new voice are listed here by file (Ruling B1-91). Take main's gate on
 * rebase and drop this list.
 */
const EGYPTIAN_BY_DECISION_1016 = new Set([
  'apps/web/src/lib/coupon-errors.ts',
  // STOP-2 P2-2 (Ruling B1-109): the empty-cart sentences (سلتك فاضية / لسه ما ضفتش أي منتج).
  'apps/web/src/app/cart/CartClient.tsx',
]);

const COLLOQUIAL = [
  'ده',
  'دي',
  'دول',
  'دلوقتي',
  'مش',
  'اللي',
  'عشان',
  'علشان',
  'كده',
  'تاني',
  'تانية',
  'لسه',
  'إزاي',
  'ازاي',
  'فاضي',
  'فاضية',
  'ابعت',
  'كلّم',
  'كلمنا',
  'يوصلك',
  'اتسجل',
  'اتبعت',
  'اتأكد',
  'مقفول',
  'مقفولة',
  'بتاعتك',
  'بتاعك',
  'ضيف',
  'شوفه',
  'هيراجع',
  'بنطبع',
  'بنأكد',
];
const WORD = new RegExp(
  `(?:^|[^\\u0621-\\u065F\\u0670\\u0640])(${COLLOQUIAL.join('|')})(?=$|[^\\u0621-\\u065F\\u0670\\u0640])`
);
const STRING = /(['"`])((?:(?!\1)[^\\\n]|\\.)*[ء-ي](?:(?!\1)[^\\\n]|\\.)*)\1/g;

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === '__tests__' || n === 'landing') continue;
      files(p, out);
    } else if (
      /\.tsx?$/.test(n) &&
      !/\.(test|spec|d)\.tsx?$/.test(n) &&
      !EGYPTIAN_BY_DECISION_1016.has(relative(ROOT, p))
    )
      out.push(p);
  }
  return out;
}

function hits(paths: string[], only?: RegExp): string[] {
  return paths.flatMap(f =>
    readFileSync(f, 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
        if (only && !only.test(line)) return [];
        const found: string[] = [];
        for (const m of line.matchAll(STRING)) {
          const w = WORD.exec(m[2]);
          if (w) found.push(`${relative(ROOT, f)}:${i + 1} «${w[1]}» in ${m[2].slice(0, 80)}`);
        }
        return found;
      })
  );
}

describe('storefront Arabic copy is Modern Standard Arabic (Y-02)', () => {
  it('no colloquial word in any storefront string', () => {
    const paths = [...files(join(ROOT, 'apps/web/src')), ...files(join(ROOT, 'packages/ui/src'))];
    expect(paths.length).toBeGreaterThan(200);
    expect(hits(paths)).toEqual([]);
  });

  it('no colloquial word in an Arabic answer the API gives a shopper (`messageAr`)', () => {
    const paths = files(join(ROOT, 'apps/api/src'));
    expect(hits(paths, /messageAr/)).toEqual([]);
  });

  it('the matcher catches the swept shapes and leaves MSA alone (self-test)', () => {
    for (const s of ['طلبك اتسجل', 'يوصلك بين', 'ده متجر تجريبي', 'جرّب تاني', 'المتجر مش متاح'])
      expect(WORD.test(s), s).toBe(true);
    for (const s of [
      'تم تسجيل طلبك',
      'يصلك بين',
      'هذا متجر تجريبي',
      'حاول مرة أخرى',
      'المتجر غير متاح',
      'تدفع الباقي',
      'هدية',
      'مشترياتك',
      'الذين',
      'أُضيف إلى المفضلة',
    ])
      expect(WORD.test(s), s).toBe(false);
  });
});
