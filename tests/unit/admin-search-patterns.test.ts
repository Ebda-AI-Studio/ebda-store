import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: { sql: () => ({}) } }));
const { buildCustomerPatterns } = await import('../../apps/api/src/services/admin-search.service');

describe('buildCustomerPatterns', () => {
  it('normalises Arabic names (alef forms) and ANDs every token', () => {
    expect(buildCustomerPatterns('أحمد  علي')).toMatchObject({
      names: ['%احمد%', '%علي%'],
      digits: null,
      email: null,
    });
  });
  it('a phone in any form becomes digits, with no name pattern', () => {
    for (const q of ['0101 234 5678', '+20 101 234 5678', '٠١٠١٢٣٤٥٦٧٨']) {
      expect(buildCustomerPatterns(q)).toEqual({
        names: [],
        digits: '%1012345678%',
        email: null,
      });
    }
  });
  it('an email-shaped term adds an escaped ILIKE pattern; metacharacters are literal', () => {
    expect(buildCustomerPatterns('a_b@x.com').email).toBe('%a\\_b@x.com%');
    expect(buildCustomerPatterns('%')).toEqual({ names: [], digits: null, email: null });
    expect(buildCustomerPatterns('ab%').names).toEqual(['%ab\\%%']);
  });
  it('a name with digits in it is a name search, not a phone search', () => {
    const p = buildCustomerPatterns('منى 0101234');
    expect(p.names).toEqual(['%مني%']);
    expect(p.digits).toBeNull();
    expect(buildCustomerPatterns('a3f09b1c4e').digits).toBeNull();
  });
  it('empty / one-char input still yields a bounded pattern set', () => {
    expect(buildCustomerPatterns('')).toEqual({ names: [], digits: null, email: null });
  });
});
