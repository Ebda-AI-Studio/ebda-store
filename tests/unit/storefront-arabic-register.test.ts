/**
 * Ruling FU46-Y02a (Ahmad 2026-10-16, supersedes FU46-Y02): a FULL SENTENCE the storefront
 * generates is Egyptian Arabic ("طلبك اتسجل", "يوصلك بين …", "سلتك فاضية"); a short button or
 * label stays a neutral form that reads right in both registers ("أرسل الإيصال", "موعد الوصول").
 * Ruling FU46-Y02b (coordinator 2026-10-16): the ONLY exception is legal text — the privacy and
 * terms pages, the returns-policy body and the cookie consent text stay formal (Ahmad can
 * override).
 *
 * Locks, so the register cannot drift back:
 *  1. MSA-only sentence markers (words with no Egyptian reading: "هذا", "لم", "يرجى", "سوف",
 *     "يجب", "كيف", "فارغة", the MSA dual "قطعتان"...) are banned in every Arabic string literal
 *     in `apps/web/src` + `packages/ui/src` (`\u06xx` escapes decoded) and in the shopper
 *     `messageAr` answers of the API. Legal text is exempt only where named: whole files in
 *     LEGAL_FILES, or the lines between `legal-register:start` / `legal-register:end` comments in
 *     a file listed in LEGAL_REGION_FILES. A region marker anywhere else fails the gate.
 *  2. The Egyptian sentence set Ahmad asked for is pinned verbatim (EGYPTIAN), so a sweep that
 *     "standardises" them turns this red even if it only uses words the marker list misses.
 *  3. The neutral button/label forms are pinned too (NEUTRAL), so the reverse drift is caught.
 *
 * NOT in scope: `components/landing/` (Ebda's own marketing landing), the admin, help and merchant
 * docs (merchant voice), and anything a merchant types (data, never in code).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');

/** Words with no Egyptian-colloquial reading. A whole-word match, so they cannot fire inside a word. */
export const MSA_ONLY = [
  'هذا',
  'هذه',
  'ذلك',
  'تلك',
  'لم',
  'لن',
  'سوف',
  'حالياً',
  'حاليًا',
  'حاليا',
  'يرجى',
  'نرجو',
  'الرجاء',
  'جارٍ',
  'جاري',
  'يوجد',
  'توجد',
  'لقد',
  'الذي',
  'التي',
  'الذين',
  'سنرد',
  'سيراجع',
  'ستظهر',
  'سيظهر',
  'سيتم',
  'سنقوم',
  'يصلك',
  'أولاً',
  'قطعتان',
  'يومان',
  'نتيجتان',
  'يمكنك',
  'بإمكانك',
  'لديك',
  'لدينا',
  'لديه',
  'إذا',
  'يجب',
  'ليس',
  'ليست',
  'كيف',
  'لماذا',
  'ماذا',
  'أين',
  'متى',
  'هل',
  'فقط',
  'فارغة',
  'فارغ',
  'عذراً',
  'عذرًا',
  'نأسف',
  'قم',
];
const AR = '\\u0621-\\u065F\\u0670\\u0640';
const WORD = new RegExp(`(?:^|[^${AR}])(${MSA_ONLY.join('|')})(?=$|[^${AR}])`, 'g');
const STRING = /(['"`])((?:(?!\1)[^\\\n]|\\.)*[ء-ي](?:(?!\1)[^\\\n]|\\.)*)\1/g;

/** Whole files that are legal text (Ruling FU46-Y02b): formal register allowed. */
const LEGAL_FILES: Record<string, string> = {
  'apps/web/src/app/privacy/PrivacyClient.tsx': 'privacy policy',
  'apps/web/src/app/terms/TermsClient.tsx': 'terms of service',
  'apps/web/src/components/CookieConsentBanner.tsx': 'cookie consent notice',
  'apps/web/src/components/CookiePreferencesModal.tsx': 'cookie preferences (consent text)',
};
/** Files whose legal part is fenced by `legal-register:start` / `legal-register:end` comments. */
const LEGAL_REGION_FILES: Record<string, string> = {
  'apps/web/src/app/returns/ReturnsClient.tsx': 'the returns-policy body (eligibility, refunds)',
  'apps/web/src/lib/return-policy-text.ts': 'the returns-policy and terms return sentences',
};
const REGION_START = /legal-register:start/;
const REGION_END = /legal-register:end/;

/** Ahmad's Egyptian sentences (2026-10-16), pinned in the file that renders them. */
const EGYPTIAN: Array<[string, string]> = [
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'طلبك اتسجل، الدفع عند الاستلام'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'طلبك اتسجل، في انتظار الدفع'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'تم الدفع، طلبك اتأكد'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'بنطبع فاتورتك…'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'الدفع ما تمش'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'عندك سؤال؟ كلّم المتجر على واتساب'],
  ['apps/web/src/components/commerce/DeliveryChip.tsx', 'يوصلك بين'],
  ['apps/web/src/components/commerce/DeliveryChip.tsx', 'بيتجهز خصيصًا لك في'],
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', 'صاحب المتجر هيراجع التحويل'],
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', 'الإيصال اتبعت.'],
  ['apps/web/src/app/contact/ContactClient.tsx', 'هنرد عليك في أقرب وقت.'],
  ['apps/web/src/components/UnknownHostNotFound.tsx', 'المتجر ده مش موجود أو لسه ما فتحش'],
  ['apps/web/src/components/demo/DemoCheckoutNotice.tsx', 'ده متجر تجريبي — الطلب مقفول'],
  ['apps/web/src/templates/dahab/CartDrawer.tsx', 'سلتك فاضية'],
  ['apps/web/src/lib/return-policy-text.ts', 'بنقبل الإرجاع خلال'],
  [
    'apps/web/src/app/checkout/success/SuccessClient.tsx',
    'طلبك اتسجل. جهّز المبلغ لما الطلب يوصلك.',
  ],
  ['apps/web/src/lib/plural.ts', "two: 'قطعتين'"],
  ['apps/web/src/lib/plural.ts', "two: 'يومين'"],
  ['apps/api/src/routes/public.routes.ts', 'ده متجر تجريبي — الرسائل مقفولة'],
];

/** Short buttons and labels stay neutral (decision e): pinned so a sentence sweep leaves them be. */
const NEUTRAL: Array<[string, string]> = [
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', "'أرسل الإيصال'"],
  ['apps/web/src/components/ProductModel3d.tsx', "'اعرضه 3D'"],
  ['apps/web/src/components/ProductModel3d.tsx', "'اعرضه في مكانك'"],
  ['apps/web/src/components/UnknownHostNotFound.tsx', "'أنشئ متجرك على إبدأ'"],
  ['apps/web/src/components/UnknownHostNotFound.tsx', "'تواصل معنا عبر واتساب'"],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', "'موعد الوصول'"],
  ['apps/web/src/components/demo/DemoLookBar.tsx', "'اختر شكلاً'"],
];

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === '__tests__' || n === 'landing') continue;
      files(p, out);
    } else if (/\.tsx?$/.test(n) && !/\.(test|spec|d)\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** MSA-marker hits per repo-relative file. */
export function msaHits(
  paths: string[],
  only?: RegExp,
  opts: { honourRegions?: boolean } = {}
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of paths) {
    let inLegal = false;
    readFileSync(f, 'utf8')
      .replace(/\\u(06[0-9a-fA-F]{2})/g, (_: string, h: string) =>
        String.fromCharCode(parseInt(h, 16))
      )
      .split('\n')
      .forEach((line, i) => {
        if (REGION_START.test(line)) inLegal = true;
        if (REGION_END.test(line)) inLegal = false;
        if (inLegal && opts.honourRegions) return;
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (only && !only.test(line)) return;
        for (const m of line.matchAll(STRING)) {
          for (const w of m[2].matchAll(WORD)) {
            const rel = relative(ROOT, f);
            (out[rel] ??= []).push(`${rel}:${i + 1} «${w[1]}» in ${m[2].slice(0, 80)}`);
          }
        }
      });
  }
  return out;
}

/** Every hit outside legal text, as one problem list (empty = the rule holds). */
function nonLegalHits(paths: string[], only?: RegExp): string[] {
  const regionFiles = paths.filter(p => relative(ROOT, p) in LEGAL_REGION_FILES);
  const other = paths.filter(
    p => !(relative(ROOT, p) in LEGAL_FILES) && !(relative(ROOT, p) in LEGAL_REGION_FILES)
  );
  return [
    ...Object.values(msaHits(other, only)).flat(),
    ...Object.values(msaHits(regionFiles, only, { honourRegions: true })).flat(),
  ];
}

const storefrontPaths = () => [
  ...files(join(ROOT, 'apps/web/src')),
  ...files(join(ROOT, 'packages/ui/src')),
];

describe('storefront Arabic register (Ruling FU46-Y02a: Egyptian sentences, neutral labels)', () => {
  it('no MSA sentence in any storefront string outside the named legal text', () => {
    const paths = storefrontPaths();
    expect(paths.length).toBeGreaterThan(200);
    expect(nonLegalHits(paths)).toEqual([]);
  });

  it('no MSA sentence in an Arabic answer the API gives a shopper (`messageAr`)', () => {
    expect(nonLegalHits(files(join(ROOT, 'apps/api/src')), /messageAr/)).toEqual([]);
  });

  it('legal exemptions are named: every listed file exists, and region markers sit only in LEGAL_REGION_FILES', () => {
    for (const f of [...Object.keys(LEGAL_FILES), ...Object.keys(LEGAL_REGION_FILES)])
      expect(() => readFileSync(join(ROOT, f)), f).not.toThrow();
    const stray = storefrontPaths()
      .filter(p => REGION_START.test(readFileSync(p, 'utf8')))
      .map(p => relative(ROOT, p))
      .filter(f => !(f in LEGAL_REGION_FILES));
    expect(stray).toEqual([]);
    for (const f of Object.keys(LEGAL_REGION_FILES)) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).toMatch(REGION_START);
      expect((src.match(/legal-register:start/g) ?? []).length, f).toBe(
        (src.match(/legal-register:end/g) ?? []).length
      );
    }
  });

  it("Ahmad's Egyptian sentences are in the files that render them", () => {
    const missing = EGYPTIAN.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });

  it('short buttons and labels keep their neutral form', () => {
    const missing = NEUTRAL.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });

  it('a \\u-escaped Arabic string is read too (413 single-quoted escaped storefront strings were invisible to the old gate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    const f = join(dir, 'x.tsx');
    // "هذا متجر" written as escapes
    writeFileSync(f, "t('x', '\\u0647\\u0630\\u0627 \\u0645\\u062a\\u062c\\u0631');\n");
    expect(Object.values(msaHits([f])).flat()).toHaveLength(1);
  });

  it('the matcher catches the MSA sentence shapes and leaves Egyptian alone (self-test)', () => {
    const hit = (s: string) => [...s.matchAll(WORD)].length > 0;
    for (const s of [
      'تم تسجيل طلبك، يصلك بين',
      'هذا متجر تجريبي',
      'لم يكتمل الدفع',
      'يرجى إدخال البيانات',
      'قطعتان',
      'المتجر غير متاح حالياً',
      'سيراجع صاحب المتجر التحويل',
      'سلة التسوق فارغة',
      'يجب أن تختار مقاس',
      'كيف يمكنني تتبع طلبي؟',
      'هل تحتاج مساعدة؟',
    ])
      expect(hit(s), s).toBe(true);
    for (const s of [
      'طلبك اتسجل',
      'يوصلك بين',
      'هيوصلك خلال يومين',
      'ده متجر تجريبي',
      'الدفع ما تمش',
      'قطعتين',
      'المتجر مش متاح دلوقتي',
      'لمّا',
      'التيشيرت',
      'يلمع',
      'الهدية',
      'سلتك فاضية',
      'لازم تختار مقاس',
      'إزاي أتابع طلبي؟',
      'محتاج مساعدة؟',
      'يمكن يوصل بكرة',
      'أخرى',
    ])
      expect(hit(s), s).toBe(false);
  });
});
