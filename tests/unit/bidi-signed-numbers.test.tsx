// @vitest-environment jsdom
/**
 * R-02 (Qamar taste audit 2026-10-15, quality-bar § 2): a signed number inside
 * Arabic text is isolated left-to-right with its sign, and the sign is U+2212.
 *
 * A leading sign is a bidi NEUTRAL: in a right-to-left paragraph it takes the
 * paragraph direction and is painted after the digits, so the sale badge read
 * "21%-", the swatch overflow "2+" and every discount line "450-". The browser
 * paints the logical order of an LTR isolate left to right, so "sign first inside
 * <bdi dir=ltr> / U+2066…U+2069" IS the on-screen order "−21%", "+2" (jsdom has
 * no layout, so the test pins that logical shape under dir=rtl).
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getDiscountBadgeText } from '../../apps/web/src/lib/product-pricing';
import { MINUS, SignedAmount, signedText } from '../../apps/web/src/lib/bidi';
import { SwatchDots } from '../../apps/web/src/components/commerce/SwatchDots';

afterEach(cleanup);

const LRI = '⁦';
const PDI = '⁩';
const sale = { price: 7900, compareAtPrice: 10000 };

describe('R-02: the sale badge text', () => {
  it('ar: "−21%" in an LTR isolate, real minus, no hyphen', () => {
    expect(getDiscountBadgeText(sale, true)).toBe(`${LRI}${MINUS}21%${PDI}`);
  });
  it('ar with Arabic-Indic digits keeps the isolate', () => {
    expect(getDiscountBadgeText(sale, true, undefined, undefined, 'arab')).toBe(
      `${LRI}${MINUS}٢١%${PDI}`
    );
  });
  it('en: the same isolated "−21%"', () => {
    expect(getDiscountBadgeText(sale, false)).toBe(`${LRI}${MINUS}21%${PDI}`);
  });
  it('rendered inside dir=rtl the isolate starts with the sign', () => {
    const { container } = render(
      <div dir="rtl">
        <span data-testid="b">{getDiscountBadgeText(sale, true)}</span>
      </div>
    );
    const text = container.textContent ?? '';
    expect(text.startsWith(`${LRI}${MINUS}`)).toBe(true);
    expect(text).not.toContain('-');
  });
});

describe('R-02: SignedAmount / signedText', () => {
  it('isolates only the sign and the number of an Arabic amount', () => {
    const { container } = render(
      <div dir="rtl">
        <SignedAmount sign={MINUS} value="1,450.50 ج.م" />
      </div>
    );
    const bdi = container.querySelector('bdi')!;
    expect(bdi.getAttribute('dir')).toBe('ltr');
    expect(bdi.textContent).toBe(`${MINUS}1,450.50`);
    expect(container.textContent).toBe(`${MINUS}1,450.50 ج.م`);
  });
  it('an English amount keeps its currency before the isolated number', () => {
    expect(signedText(MINUS, 'EGP 450')).toBe(`EGP ${LRI}${MINUS}450${PDI}`);
  });
  it('Arabic-Indic digits and separators count as the number', () => {
    expect(signedText(MINUS, '١٬٢٩٩٫٥٠ ج.م')).toBe(`${LRI}${MINUS}١٬٢٩٩٫٥٠${PDI} ج.م`);
  });
});

describe('R-02: the swatch overflow count', () => {
  it('renders "+2" in an LTR bdi under dir=rtl', () => {
    const values = Array.from({ length: 7 }, (_, i) => ({
      value: `c${i}`,
      swatchHex: '#112233',
    }));
    const { container } = render(
      <div dir="rtl">
        <SwatchDots product={{ options: [{ name: 'Color', values }] }} max={5} />
      </div>
    );
    const bdi = container.querySelector('bdi');
    expect(bdi?.getAttribute('dir')).toBe('ltr');
    expect(bdi?.textContent).toBe('+2');
  });
});

/** Static half: no storefront file paints a sign glued to an expression outside the helper. */
describe('R-02: no bare signed expression in the storefront', () => {
  const ROOT = join(__dirname, '../..');
  const WEB = join(ROOT, 'apps/web/src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(tsx|ts)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  // JSX text "-{x}", "−{x}", "+{x}" and template literals `-${x}`, `−${x}`, `+${x}`.
  // Inside a template a sign after "(" is the same neutral (the COD fee "(+30 ج.م)"):
  // `(+${fee})`. A sign after a SPACE is not matched: CSS (`0px -${n}px`) uses it.
  const BANNED = [/(^|[>}\s])[-−+]\{[A-Za-z(]/, /[`(][-−+]\$\{/];

  it('scans the storefront', () => {
    expect(walk(WEB).length).toBeGreaterThan(200);
  });
  it('every signed number goes through lib/bidi', () => {
    const hits = walk(WEB)
      .filter(f => !f.endsWith('lib/bidi.tsx'))
      .flatMap(f =>
        readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((l, i) =>
            BANNED.some(r => r.test(l)) ? [`${relative(ROOT, f)}:${i + 1}: ${l.trim()}`] : []
          )
      );
    expect(hits).toEqual([]);
  });
  it('the matcher catches the old shapes (self-test)', () => {
    const t = (l: string) => BANNED.some(r => r.test(l));
    expect(t('              −{fmt(discount)}')).toBe(true);
    expect(t('<span>-{formatPrice(x)}</span>')).toBe(true);
    expect(t('<span>+{total - max}</span>')).toBe(true);
    expect(t('return `-${pct}%`;')).toBe(true);
    expect(t('<Num>{`−${formatPrice(x)}`}</Num>')).toBe(true);
    expect(t("const feeText = ` (+${[fixed, pct].join(' + ')})`;")).toBe(true);
    expect(t('` (+${rows.length - 1} more)`')).toBe(true);
    expect(t('rootMargin: `0px 0px -${measure()}px 0px`,')).toBe(false);
    expect(t('className="-mt-2"')).toBe(false);
    expect(t('a = b - {x}')).toBe(false);
  });
});
