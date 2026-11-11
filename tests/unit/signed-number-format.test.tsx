/**
 * SIGN-1 formatter + <SignedNumber>: zero is never signed, the minus is U+2212, sign + number are one LTR isolate,
 * in ar and en. Regression for admin loyalty "total redeemed" showing "-0" and Arabic "N-".
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatSigned, signedParts, MINUS } from '@ebda/shared';
import { SignedNumber } from '@ebda/ui';

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
  it.each(['en', 'ar'])('[%s] renders a bdi dir=ltr, never -0', language => {
    expect(renderToStaticMarkup(<SignedNumber value={-0} language={language} />)).toBe(
      '<bdi dir="ltr">0</bdi>'
    );
    expect(renderToStaticMarkup(<SignedNumber value={-30} language={language} />)).toBe(
      `<bdi dir="ltr">${MINUS}30</bdi>`
    );
    expect(renderToStaticMarkup(<SignedNumber value={30} plus language={language} />)).toBe(
      '<bdi dir="ltr">+30</bdi>'
    );
  });
});
