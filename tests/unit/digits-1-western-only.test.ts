/**
 * Ruling DIGITS-1 (Ahmad, 2026-10-26): Western digits (0-9) everywhere in Ebda: UI, copy, receipts, PDFs, emails,
 * notifications, in Arabic and in English. Arabic-Indic digits (٠-٩) and Persian ones (۰-۹) are never produced.
 *
 *  1. No Arabic-Indic digit in any locale file, help / docs article, copy module or template (a line that only
 *     NORMALISES input, or a comment, is allowed: those files are listed below with the reason).
 *  2. No `ar` locale handed to Intl / toLocale*String without `-u-nu-latn` (or numberingSystem: 'latn', or the
 *     shared `intlLocale()` / `withNumerals()`), because bare `ar-EG` prints Arabic-Indic digits on older ICU.
 *  3. The shared helpers cannot be talked into producing them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMoney, intlLocale, withNumerals, localizeDigits } from '@ebda/shared';

const ROOT = path.resolve(__dirname, '../..');
const SKIP_DIR =
  /(^|\/)(node_modules|\.next|\.open-next|out|dist|\.gate|\.wrangler|graphify-out|coverage)(\/|$)/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(ROOT, p);
    if (SKIP_DIR.test(rel)) continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield rel;
  }
}
const ALL = [...walk(path.join(ROOT, 'apps')), ...walk(path.join(ROOT, 'packages'))].map(f =>
  f.split(path.sep).join('/')
);
const isTest = (f: string) => /\.test\.|\/__tests__\/|\/test\/|\.spec\./.test(f);
// the vendored pdf-lib build (Ruling BUNDLE-BUDGET-7) is third-party minified code, not first-party source
const SOURCE = ALL.filter(
  f =>
    /\.(ts|tsx|mjs|js)$/.test(f) && !isTest(f) && !f.endsWith('apps/api/src/cf/modules/pdf-lib.mjs')
);
// foundation/vectors = vendored cross-product test vectors that deliberately contain Arabic-Indic input
const COPY = ALL.filter(
  f => /\.(json|mdx|md|html|hbs)$/.test(f) && !isTest(f) && !/\/foundation\/vectors\//.test(f)
);

const ARABIC_INDIC = /[٠-٩۰-۹]/;

/** Files that exist to READ Arabic-Indic digits typed by a person (input normalisers, search folding, parsers). */
const NORMALISERS = [
  /packages\/shared\/src\/search\//, // search folding + its vectors
  /packages\/shared\/src\/region\/index\.ts$/, // normaliseDigits / phone parsing
  /packages\/shared\/src\/foundation\/(phone|text)\.ts$/, // vendored foundation v0.1.0: phone + Arabic fold input normalisers
  /packages\/shared\/src\/barcode\/ean\.ts$/, // scanner/typed barcode input normaliser
  /packages\/shared\/src\/tax-profile\.ts$/,
  /packages\/shared\/src\/instapay-receipt\.ts$/,
  /apps\/api\/src\/services\/price-cell\.ts$/,
  /apps\/api\/src\/services\/accounting\/bank-statement-parser\.ts$/,
  /apps\/api\/src\/services\/carriers\/egypt-areas\.ts$/,
  /apps\/api\/src\/lib\/ai\/instapay-receipt-reader\.ts$/,
  /apps\/api\/src\/lib\/ai\/faq-grounding-validator\.ts$/,
  /apps\/api\/src\/lib\/ci\/return-reason\.ts$/, // folds digits typed in a return reason
  /apps\/api\/src\/lib\/ai\/review-moderation-policy\.ts$/, // reads digits typed in a review (phone-number prefilter)
  /apps\/admin\/src\/i18n\/numerals\.ts$/,
  /apps\/admin\/src\/lib\/format\.ts$/,
  /apps\/admin\/src\/lib\/onboarding-validation\.ts$/,
  /apps\/web\/src\/lib\/option-localization\.ts$/,
  /apps\/web\/src\/lib\/bidi\.tsx$/,
  /apps\/marketing\/src\/lib\/phone-store\.ts$/,
];
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*|\{?\/\*)/.test(line);

describe('DIGITS-1: no Arabic-Indic digit in locale files, copy or templates', () => {
  it('scans a meaningful set of files', () => {
    expect(COPY.length).toBeGreaterThan(40);
    expect(COPY.some(f => f.endsWith('apps/admin/src/i18n/messages/ar.json'))).toBe(true);
    expect(SOURCE.length).toBeGreaterThan(1500);
  });

  it('copy files (locale JSON, help / docs articles) contain none', () => {
    const hits = COPY.filter(f => !/\.generated\./.test(f)).flatMap(f =>
      readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n')
        .flatMap((line, i) => (ARABIC_INDIC.test(line) ? [`${f}:${i + 1}`] : []))
    );
    expect(hits).toEqual([]);
  });

  it('source files (UI, emails, PDFs, templates, seeds) contain none outside the input normalisers', () => {
    const hits = SOURCE.filter(f => !NORMALISERS.some(r => r.test(f))).flatMap(f =>
      readFileSync(path.join(ROOT, f), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          ARABIC_INDIC.test(line) && !isComment(line)
            ? [`${f}:${i + 1}: ${line.trim().slice(0, 90)}`]
            : []
        )
    );
    expect(hits).toEqual([]);
  });
});

describe('DIGITS-1: every Intl / toLocale call on a possibly-Arabic locale pins Latin digits', () => {
  const CALL =
    /(toLocale(?:Date|Time)?String|Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat))\s*\(/g;
  // safe: the shared helper, an explicit latn pin, or a non-Arabic literal locale
  const SAFE = /intlLocale|nu-latn|numberingSystem|withNumerals|['"]en(-[A-Za-z]{2})?['"]/;

  it('no call is left on a bare or variable locale', () => {
    const offenders: string[] = [];
    for (const f of SOURCE) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(CALL)) {
        const at = m.index ?? 0;
        const span = src.slice(at, at + 260);
        const line = src.slice(0, at).split('\n').length;
        const text = src.split('\n')[line - 1] ?? '';
        if (isComment(text)) continue;
        if (!SAFE.test(span))
          offenders.push(`${f}:${line}: ${span.split('\n')[0].trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Arabic locale literal is passed without the latn pin', () => {
    const offenders: string[] = [];
    for (const f of SOURCE) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      src.split('\n').forEach((text, i) => {
        if (isComment(text)) return;
        for (const m of text.matchAll(/['"`](ar(?:-[A-Z]{2})?)(-u-[a-z0-9-]+)?['"`]/g)) {
          const tag = m[0].slice(1, -1);
          // only a locale handed straight to Intl / toLocale (same line, or an argument on its own line right
          // after the call opens); `intlLocale('ar')` is the shared helper and always pins latn
          const lines = src.split('\n');
          const near = lines.slice(Math.max(0, i - 1), i + 3).join('\n');
          const prev = lines[i - 1] ?? '';
          const handed =
            /Intl\.|toLocale/.test(text) ||
            (/^\s*['"`]/.test(text) && /(Intl\.\w+|toLocale\w*)\(\s*$/.test(prev));
          if (!handed || /intlLocale\(/.test(text)) continue;
          if (/-u-nu-latn/.test(tag)) continue;
          if (/numberingSystem|withNumerals|nu-latn/.test(near)) continue;
          if (/PluralRules/.test(text)) continue; // plural categories, no digits
          offenders.push(`${f}:${i + 1}: ${text.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('DIGITS-1: the shared helpers cannot produce them', () => {
  const asked = 'arab' as never;
  it('whatever a caller or a stored theme asks for', () => {
    expect(intlLocale('ar', asked)).toBe('ar-EG-u-nu-latn');
    expect(intlLocale('en', asked)).toBe('en-US-u-nu-latn');
    expect(withNumerals({ year: 'numeric' }, asked).numberingSystem).toBe('latn');
    expect(localizeDigits('2026', asked)).toBe('2026');
    expect(formatMoney(145_050, 'ar', { numerals: asked, easternArabicDigits: true })).toBe(
      '1,450.50 ج.م'
    );
    expect(new Intl.NumberFormat(intlLocale('ar')).format(1234567)).not.toMatch(ARABIC_INDIC);
    expect(new Date(0).toLocaleDateString(intlLocale('ar'), { dateStyle: 'long' })).not.toMatch(
      ARABIC_INDIC
    );
  });
});
