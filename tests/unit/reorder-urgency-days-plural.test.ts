/** RO2: "14 أيام" was wrong Arabic; the count agrees with ICU plural rules, Western digits. */
import { describe, it, expect } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

const fmt = (msg: string, locale: string, days: number) =>
  new IntlMessageFormat(msg, locale).format({ days }) as string;
const enMsg = (en as any).stock.reorder.card.urgencyDays as string;
const arMsg = (ar as any).stock.reorder.card.urgencyDays as string;

describe('reorder urgencyDays', () => {
  it('Arabic: agreement for 1, 2, 3, 14, 100', () => {
    expect(fmt(arMsg, 'ar', 1)).toBe('يوم واحد');
    expect(fmt(arMsg, 'ar', 2)).toBe('يومين');
    expect(fmt(arMsg, 'ar', 3)).toBe('3 أيام');
    expect(fmt(arMsg, 'ar', 14)).toBe('14 يوم');
    expect(fmt(arMsg, 'ar', 100)).toBe('100 يوم');
  });
  it('English: singular and plural', () => {
    expect(fmt(enMsg, 'en', 1)).toBe('1 day');
    expect(fmt(enMsg, 'en', 5)).toBe('5 days');
  });
});
