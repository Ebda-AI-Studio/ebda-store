import { describe, expect, it } from 'vitest';
import { probesAr, probesEn } from '../src/probe';

describe('incident text number agreement', () => {
  it('English: 1 probe, N probes', () => {
    expect(probesEn(1)).toBe('1 consecutive probe');
    expect(probesEn(2)).toBe('2 consecutive probes');
  });
  it('Arabic: singular, dual, 3-10 plural, 11+ singular noun', () => {
    expect(probesAr(1)).toBe('فحص واحد ورا بعض');
    expect(probesAr(2)).toBe('فحصين ورا بعض');
    expect(probesAr(3)).toBe('3 فحوصات ورا بعض');
    expect(probesAr(10)).toBe('10 فحوصات ورا بعض');
    expect(probesAr(11)).toBe('11 فحص ورا بعض');
  });
  it('never renders the old "1 فحوصات" plural bug', () => {
    for (let n = 1; n <= 12; n++) expect(probesAr(n)).not.toMatch(/\b[12] فحوصات/);
  });
});
