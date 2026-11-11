import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/ui', () => ({ useToast: () => ({}) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@/lib/api', () => ({ apiPut: vi.fn() }));
vi.mock('@/hooks/useCurrentStore', () => ({ useCurrentStore: () => ({}) }));

import { TIME_ZONES } from './TaxTimeZoneCard';

describe('time-zone picker (A3)', () => {
  it('is Egypt-first and lists no Gulf zones', () => {
    expect(TIME_ZONES[0]).toBe('Africa/Cairo');
    expect(TIME_ZONES.join(' ')).not.toMatch(/Riyadh|Dubai|Qatar|Bahrain|Muscat|Baghdad/);
  });
});
