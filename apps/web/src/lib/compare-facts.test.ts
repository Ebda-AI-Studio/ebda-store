import { describe, it, expect } from 'vitest';
import { compareFactRows } from './compare-facts';

const f = (key: string, keyAr: string, value: string) => ({
  key,
  keyAr,
  value,
  valueAr: '',
  onCard: false,
});

describe('compareFactRows', () => {
  it('merges when both names match (EN case-insensitive)', () => {
    const rows = compareFactRows(
      [
        { id: 'a', facts: [f('Fabric', 'الخامة', 'Linen')] },
        { id: 'b', facts: [f(' fabric ', 'الخامة', 'Silk')] },
      ],
      'en'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toEqual({ a: 'Linen', b: 'Silk' });
  });
  it('does not merge when only one language name matches', () => {
    const rows = compareFactRows(
      [
        { id: 'a', facts: [f('', 'المقاس', 'M')] },
        { id: 'b', facts: [f('Size', 'المقاس', 'L')] },
        { id: 'c', facts: [f('Fabric', 'الخامة', 'x'), f('Fabric', 'القماش', 'y')] },
      ],
      'ar'
    );
    expect(rows.map(r => r.id)).toHaveLength(4);
  });
  it('merges blank-EN facts that share the same AR name', () => {
    const rows = compareFactRows(
      [
        { id: 'a', facts: [f('', 'العيار', '21')] },
        { id: 'b', facts: [f('', 'العيار', '18')] },
      ],
      'en'
    );
    expect(rows).toHaveLength(1);
  });
});
