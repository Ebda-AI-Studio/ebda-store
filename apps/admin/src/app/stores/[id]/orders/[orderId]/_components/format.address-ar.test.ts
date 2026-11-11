import { describe, it, expect } from 'vitest';
import { formatAddressLines } from './format';

const labels = {
  block: 'قطعة',
  street: 'شارع',
  avenue: 'جادة',
  house: 'منزل',
  building: 'مبنى',
  floor: 'طابق',
  apt: 'شقة',
};

describe('formatAddressLines (QA-D2)', () => {
  it('uses مصر, and does not double the street label', () => {
    const lines = formatAddressLines(
      {
        country: 'Egypt',
        governorateAr: 'القاهرة',
        street: 'شارع الاختبار',
        building: '4',
      } as never,
      labels,
      'ar'
    );
    expect(lines[0]).toBe('مصر - القاهرة');
    expect(lines.join('\n')).toContain('شارع الاختبار');
    expect(lines.join('\n')).not.toContain('شارع شارع');
    expect(lines.join('\n')).toContain('مبنى 4');
  });
});
