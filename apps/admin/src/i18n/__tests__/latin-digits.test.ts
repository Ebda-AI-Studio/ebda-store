/**
 * Issue 1971 — ICU number arguments must render Latin digits in the Arabic
 * admin, like every number the admin formats itself (prices, dates, raw
 * `{count}` values). `#` and a bare `{n, number}` format through
 * `Intl.NumberFormat(locale)`, whose `ar` default depends on the browser's
 * CLDR; the render check below uses `ar-EG`, whose default is Arabic-Indic on
 * every CLDR version, so it proves the policy rather than the test host's data.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'use-intl/core';
import en from '../messages/en.json';
import ar from '../messages/ar.json';
import { intlFormats } from '../formats';
import { formatPrice } from '@/lib/format';
import { NON_LATIN_NUMERAL as ARABIC_INDIC } from '../numerals';

type Tree = { [k: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`)
  );
}

describe('admin ICU numbers render Latin digits (issue 1971)', () => {
  for (const [name, catalogue] of [
    ['en', en],
    ['ar', ar],
  ] as const) {
    const all = leaves(catalogue as unknown as Tree);

    it(`${name}: no plural message uses the locale-formatted "#"`, () => {
      const offenders = all.filter(([, v]) => /,\s*plural\s*,/.test(v) && v.includes('#'));
      expect(offenders.map(([k]) => k)).toEqual([]);
    });

    it(`${name}: no number argument is missing the latn style`, () => {
      const offenders = all.filter(([, v]) => /\{\s*\w+\s*,\s*number\s*\}/.test(v));
      expect(offenders.map(([k]) => k)).toEqual([]);
    });
  }

  it('every ar message with a number argument renders Latin digits under an Arabic-Indic default locale', () => {
    // Sanity: the control locale really does default to Arabic-Indic here.
    expect(ARABIC_INDIC.test(new Intl.NumberFormat('ar-EG').format(42))).toBe(true);

    const t = createTranslator({
      locale: 'ar-EG',
      messages: ar as unknown as Record<string, unknown>,
      formats: intlFormats,
    });
    const numeric = leaves(ar as unknown as Tree).filter(([, v]) =>
      /,\s*number\s*,\s*latn/.test(v)
    );
    expect(numeric.length).toBeGreaterThan(10);
    for (const [key] of numeric) {
      for (const count of [1, 2, 7, 42, 1234]) {
        const out = (t as unknown as (k: string, v: Record<string, unknown>) => string)(key, {
          count,
          b: (chunks: string) => chunks,
        });
        expect(ARABIC_INDIC.test(out), `${key} (${count}) → ${out}`).toBe(false);
      }
    }
  });

  it('admin prices keep the Arabic currency symbol but use Latin digits', () => {
    const ar = formatPrice(1500, { locale: 'ar' });
    expect(ARABIC_INDIC.test(ar), ar).toBe(false);
    expect(ar).toMatch(/^15 /); // whole pounds carry no ".00" (one house style)
    expect(ar).toContain('ج.م');
    expect(formatPrice(1550, { locale: 'en' })).toMatch(/15\.50/);
  });

  it('the formats are wired into both the server request config and the client provider', () => {
    const request = readFileSync(resolve(__dirname, '../request.ts'), 'utf8');
    const layout = readFileSync(resolve(__dirname, '../../app/layout.tsx'), 'utf8');
    expect(request).toMatch(/formats:\s*intlFormats/);
    expect(layout).toMatch(/<NextIntlClientProvider[^>]*formats=\{intlFormats\}/);
  });
});
