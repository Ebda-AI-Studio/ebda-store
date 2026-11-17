import { describe, expect, it } from 'vitest';
import { intervalsCovered } from '../../apps/api/src/services/billing/period';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('intervalsCovered: intervals an explicit manual period spans, rounded up', () => {
  it('a span of exactly one interval is 1, one second more is 2', () => {
    expect(intervalsCovered(d('2026-03-10'), d('2026-04-10'), 'monthly')).toBe(1);
    expect(intervalsCovered(d('2026-03-10'), new Date('2026-04-10T00:00:01.000Z'), 'monthly')).toBe(
      2
    );
  });
  it('a span shorter than an interval is still 1 (never 0)', () => {
    expect(intervalsCovered(d('2026-03-10'), d('2026-03-11'), 'monthly')).toBe(1);
  });
  it('month-end clamps: Jan 31 -> Feb 28 is 1, Mar 1 is 2, Mar 31 is 2, Apr 1 is 3', () => {
    expect(intervalsCovered(d('2026-01-31'), d('2026-02-28'), 'monthly')).toBe(1);
    expect(intervalsCovered(d('2026-01-31'), d('2026-03-01'), 'monthly')).toBe(2);
    expect(intervalsCovered(d('2026-01-31'), d('2026-03-31'), 'monthly')).toBe(2);
    expect(intervalsCovered(d('2026-01-31'), d('2026-04-01'), 'monthly')).toBe(3);
  });
  it('leap years: Jan 31 2028 -> Feb 29 2028 is 1; Feb 29 2028 -> Feb 28 2029 yearly is 1, Mar 1 is 2', () => {
    expect(intervalsCovered(d('2028-01-31'), d('2028-02-29'), 'monthly')).toBe(1);
    expect(intervalsCovered(d('2028-02-29'), d('2029-02-28'), 'yearly')).toBe(1);
    expect(intervalsCovered(d('2028-02-29'), d('2029-03-01'), 'yearly')).toBe(2);
  });
  it('yearly: 12 months is 1 interval, 24 months is 2', () => {
    expect(intervalsCovered(d('2026-05-05'), d('2027-05-05'), 'yearly')).toBe(1);
    expect(intervalsCovered(d('2026-05-05'), d('2028-05-05'), 'yearly')).toBe(2);
  });
  it('a huge span stops at max + 1 instead of looping', () => {
    expect(intervalsCovered(d('2026-01-01'), d('9999-01-01'), 'monthly', 120)).toBe(121);
  });
});
