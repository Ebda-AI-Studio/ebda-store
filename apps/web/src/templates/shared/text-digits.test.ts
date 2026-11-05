import { describe, it, expect } from 'vitest';
import { westernizeDigits, isolateNumbers, storefrontText } from '@ebda/shared';

describe('storefront copy digits + bidi (PREMIUM-12)', () => {
  it('folds Arabic-Indic digits and marks into Western', () => {
    expect(westernizeDigits('خصم ٣٠٪ على ١٢٠ من ١٥٠٠')).toBe('خصم 30% على 120 من 1500');
    expect(westernizeDigits('۱۲۳')).toBe('123');
  });
  it('isolates a number with its percent so it cannot reorder in RTL text', () => {
    const t = isolateNumbers('سيروم فيتامين سي 15% 30 مل');
    expect(t).toBe('سيروم فيتامين سي ⁦15%⁩ ⁦30⁩ مل');
  });
  it('is idempotent and leaves digit-free text alone', () => {
    const once = storefrontText('عطر 50 مل', true);
    expect(storefrontText(once, true)).toBe(once);
    expect(storefrontText('عطر فاخر', true)).toBe('عطر فاخر');
  });
  it('English copy only gets Western digits, no isolates', () => {
    expect(storefrontText('Save ٣٠% today', false)).toBe('Save 30% today');
  });
});
