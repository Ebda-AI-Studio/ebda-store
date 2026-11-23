/**
 * SIGN-1 formatter + <SignedNumber>: zero is never signed, the minus is U+2212, sign + number are one LTR isolate,
 * in ar and en. Regression for admin loyalty "total redeemed" showing "-0" and Arabic "N-".
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatSigned, signedParts, MINUS } from '@ebda/shared';
import { SignedNumber, PlusGlyph, MinusGlyph, Sep } from '@ebda/ui';

const strip = (s: string) => s.replace(/[⁦⁩]/g, '');

describe('formatSigned', () => {
  for (const language of ['en', 'ar']) {
    it(`[${language}] 0, -0 and a value that rounds to zero print plain`, () => {
      expect(strip(formatSigned(0, { language }))).toBe('0');
      expect(strip(formatSigned(-0, { language }))).toBe('0');
      expect(strip(formatSigned(-0, { language, plus: true }))).toBe('0');
      expect(strip(formatSigned(-0.04, { language, fractionDigits: 1, plus: true }))).toBe('0.0');
      expect(formatSigned(-0, { language })).not.toContain(MINUS);
      expect(formatSigned(-0, { language })).not.toContain('-');
    });
    it(`[${language}] negative and positive carry the sign inside one LTR isolate`, () => {
      expect(formatSigned(-1250, { language })).toBe(`⁦${MINUS}1,250⁩`);
      expect(formatSigned(1250, { language, plus: true })).toBe('⁦+1,250⁩');
      expect(formatSigned(1250, { language })).toBe('1,250');
    });
  }
  it('Western digits only (DIGITS-1), also for ar', () => {
    expect(formatSigned(-45, { language: 'ar' })).toMatch(/^⁦−45⁩$/);
  });
  it('a currency in `format` keeps its place; only sign + number are isolated', () => {
    expect(formatSigned(-450, { format: abs => `EGP ${abs}` })).toBe(`EGP ⁦${MINUS}450⁩`);
    expect(formatSigned(-450, { format: abs => `${abs} ج.م` })).toBe(`⁦${MINUS}450⁩ ج.م`);
    expect(formatSigned(0, { format: abs => `EGP ${abs}` })).toBe('EGP 0');
  });
  it('percent and non-finite', () => {
    expect(formatSigned(-21, { format: abs => `${abs}%` })).toBe(`⁦${MINUS}21%⁩`);
    expect(signedParts(Number.NaN)).toEqual({ sign: '', body: '0' });
  });
});

describe('<SignedNumber>', () => {
  it.each(['en', 'ar'])('[%s] zero is plain, negative/positive sit in a bdi dir=ltr', language => {
    const html = (el: JSX.Element) => renderToStaticMarkup(el);
    expect(html(<SignedNumber value={-0} language={language} />)).toBe('0');
    expect(html(<SignedNumber value={-30} language={language} />)).toBe(
      `<bdi dir="ltr">${MINUS}30</bdi>`
    );
    expect(html(<SignedNumber value={30} plus language={language} />)).toBe(
      '<bdi dir="ltr">+30</bdi>'
    );
    expect(html(<SignedNumber value={30} language={language} />)).toBe('30');
  });
  it('markup isolation: no hidden bidi characters reach the DOM text (copy-paste into Excel stays a number)', () => {
    const html = renderToStaticMarkup(<SignedNumber value={-1250} />);
    expect(html).not.toMatch(/[⁦-⁩]/);
    expect(html.replace(/<[^>]+>/g, '')).toBe(`${MINUS}1,250`);
  });
  it('a currency in `format` stays outside the isolate, in ar and en', () => {
    expect(renderToStaticMarkup(<SignedNumber value={-450} format={abs => `EGP ${abs}`} />)).toBe(
      `EGP <bdi dir="ltr">${MINUS}450</bdi>`
    );
    expect(
      renderToStaticMarkup(<SignedNumber value={-450} language="ar" format={abs => `${abs} ج.م`} />)
    ).toBe(`<bdi dir="ltr">${MINUS}450</bdi> ج.م`);
    expect(renderToStaticMarkup(<SignedNumber value={0} format={abs => `EGP ${abs}`} />)).toBe(
      'EGP 0'
    );
  });
  it('a 12% gain is +12.0%, a 12% drop is a minus (plus is explicit)', () => {
    const f = (v: number) =>
      renderToStaticMarkup(
        <SignedNumber value={v} plus fractionDigits={1} format={abs => `${abs.toFixed(1)}%`} />
      );
    expect(f(12)).toBe('<bdi dir="ltr">+12.0%</bdi>');
    expect(f(-12)).toBe(`<bdi dir="ltr">${MINUS}12.0%</bdi>`);
    expect(f(-0.04)).toBe('0.0%');
  });
});

describe('formatSigned isolate option', () => {
  it('isolate:false returns a plain string for badges/dialogs that are LTR already', () => {
    expect(formatSigned(-21, { isolate: false, format: abs => `${abs}%` })).toBe(`${MINUS}21%`);
    expect(formatSigned(0, { isolate: false })).toBe('0');
  });
});

describe('glyphs', () => {
  it('PlusGlyph, MinusGlyph and Sep render explicit, aria-hidden characters', () => {
    expect(renderToStaticMarkup(<PlusGlyph />)).toBe('<span aria-hidden="true">+</span>');
    expect(renderToStaticMarkup(<PlusGlyph decorative={false} />)).toBe('<span>+</span>');
    expect(renderToStaticMarkup(<MinusGlyph />)).toBe(`<span aria-hidden="true">${MINUS}</span>`);
    expect(renderToStaticMarkup(<Sep />)).toBe('<span aria-hidden="true"> – </span>');
  });
});
