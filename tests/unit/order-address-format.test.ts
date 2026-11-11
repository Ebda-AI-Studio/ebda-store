/**
 * Unit tests for formatAddressLines — verifies locale-aware label rendering.
 *
 * Regression: before this fix the function always used English labels
 * (Block / Street / Avenue …) regardless of the admin locale. When the
 * admin switched to Arabic the address lines still rendered in English.
 */
import { describe, it, expect } from 'vitest';
import { formatAddressLines } from '@admin/app/stores/[id]/orders/[orderId]/_components/format';

const AR_LABELS = {
  block: 'قطعة',
  street: 'شارع',
  avenue: 'جادة',
  house: 'منزل',
  building: 'بناية',
  floor: 'طابق',
  apt: 'شقة',
};

const EN_LABELS = {
  block: 'Block',
  street: 'Street',
  avenue: 'Avenue',
  house: 'House',
  building: 'Building',
  floor: 'Floor',
  apt: 'Apt',
};

const BASE_ADDR = {
  country: 'Egypt',
  city: 'Capital',
  area: 'Salmiya',
  block: '4',
  street: '12',
  avenue: '3',
  house: '10',
  building: '5',
  floor: '2',
  apartment: '6',
};

describe('formatAddressLines — locale-aware labels', () => {
  it('uses English labels when EN labels are passed', () => {
    const lines = formatAddressLines(BASE_ADDR, EN_LABELS);
    const blockLine = lines.find(l => l.includes('Block'));
    expect(blockLine).toBeDefined();
    expect(blockLine).toContain('Block 4');
    expect(blockLine).toContain('Street 12');
    expect(blockLine).toContain('Avenue 3');
    expect(blockLine).toContain('House 10');
  });

  it('uses Arabic labels when AR labels are passed', () => {
    const lines = formatAddressLines(BASE_ADDR, AR_LABELS);
    // Should NOT contain English label words
    const allText = lines.join(' ');
    expect(allText).not.toContain('Block');
    expect(allText).not.toContain('Street');
    expect(allText).not.toContain('Avenue');
    expect(allText).not.toContain('House');
    expect(allText).not.toContain('Building');
    expect(allText).not.toContain('Floor');
    expect(allText).not.toContain('Apt');

    // Should contain Arabic labels
    expect(allText).toContain('قطعة 4');
    expect(allText).toContain('شارع 12');
    expect(allText).toContain('جادة 3');
    expect(allText).toContain('منزل 10');
    expect(allText).toContain('بناية 5');
    expect(allText).toContain('طابق 2');
    expect(allText).toContain('شقة 6');
  });

  it('defaults to English labels when no labels argument provided', () => {
    const lines = formatAddressLines(BASE_ADDR);
    const allText = lines.join(' ');
    expect(allText).toContain('Block 4');
    expect(allText).toContain('Street 12');
  });

  it('returns empty array for null/undefined address', () => {
    expect(formatAddressLines(null)).toEqual([]);
    expect(formatAddressLines(undefined)).toEqual([]);
  });

  it('selects English city/area on the EN locale (one language, not both)', () => {
    const addr = {
      city: 'Capital',
      cityAr: 'العاصمة',
      area: 'Salmiya',
      areaAr: 'السالمية',
    };
    const head = formatAddressLines(addr, EN_LABELS, 'en')[0];
    expect(head).toContain('Capital');
    expect(head).toContain('Salmiya');
    // locale-selective: the AR values are NOT shown on the EN locale
    expect(head).not.toContain('العاصمة');
    expect(head).not.toContain('السالمية');
  });

  it('selects Arabic city/area on the AR locale (one language, not both)', () => {
    const addr = {
      city: 'Capital',
      cityAr: 'العاصمة',
      area: 'Salmiya',
      areaAr: 'السالمية',
    };
    const head = formatAddressLines(addr, AR_LABELS, 'ar')[0];
    expect(head).toContain('العاصمة');
    expect(head).toContain('السالمية');
    // locale-selective: the EN values are NOT shown on the AR locale
    expect(head).not.toContain('Capital');
    expect(head).not.toContain('Salmiya');
  });

  it('falls back to streetAr when street is absent (with AR labels)', () => {
    const addr = { block: '1', streetAr: 'شارع الحرية' };
    const lines = formatAddressLines(addr, AR_LABELS);
    const allText = lines.join(' ');
    // QA-D2: the value already carries the label, so it is not doubled.
    expect(allText).toContain('شارع الحرية');
    expect(allText).not.toContain('شارع شارع');
  });
});
