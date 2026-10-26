/**
 * M-124 (Ruling P18-2): dashboard "this month / this year / today" start at Cairo midnight, across the
 * 2026-10-30 offset switch (+3 to +2), not at the runtime's (UTC on Workers) midnight.
 */
import { describe, it, expect, vi } from 'vitest';
import { regionDayStart } from '@ebda/shared';

vi.mock('@api/services/redis.service', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@ebda/database', () => ({ prisma: {}, Prisma: { sql: () => '', raw: () => '' } }));
vi.mock('@api/services/accounting/reports.service', () => ({ profitAndLoss: vi.fn() }));

import { currentMonthStart, currentYearStart } from '@api/services/analytics.service';

const iso = (d: Date) => d.toISOString();

describe('currentMonthStart', () => {
  it('summer (+03): 00:30 Cairo on 1 July is July, so the month starts 21:00Z on 30 June', () => {
    expect(iso(currentMonthStart(new Date('2026-06-30T21:30:00Z')))).toBe(
      '2026-06-30T21:00:00.000Z'
    );
  });

  it('winter (+02): 00:30 Cairo on 1 Nov is November, so the month starts 22:00Z on 31 Oct', () => {
    // 22:30Z on 31 Oct is still October in UTC: the old `new Date(y, m, 1)` returned the October start here.
    expect(iso(currentMonthStart(new Date('2026-10-31T22:30:00Z')))).toBe(
      '2026-10-31T22:00:00.000Z'
    );
  });

  it('straddling the switch: October starts at +03, November at +02', () => {
    expect(iso(currentMonthStart(new Date('2026-10-15T12:00:00Z')))).toBe(
      '2026-09-30T21:00:00.000Z'
    );
    expect(iso(currentMonthStart(new Date('2026-11-15T12:00:00Z')))).toBe(
      '2026-10-31T22:00:00.000Z'
    );
  });

  it('just before Cairo midnight stays in the previous month', () => {
    expect(iso(currentMonthStart(new Date('2026-10-31T21:59:00Z')))).toBe(
      '2026-09-30T21:00:00.000Z'
    );
  });
});

describe('currentYearStart and today', () => {
  it('the year starts at Cairo midnight on 1 January (+02)', () => {
    expect(iso(currentYearStart(new Date('2026-07-10T12:00:00Z')))).toBe(
      '2025-12-31T22:00:00.000Z'
    );
    expect(iso(currentYearStart(new Date('2026-12-31T22:30:00Z')))).toBe(
      '2026-12-31T22:00:00.000Z'
    );
  });

  it('today starts at Cairo midnight, not UTC midnight', () => {
    expect(iso(regionDayStart(new Date('2026-11-01T00:10:00Z')))).toBe('2026-10-31T22:00:00.000Z');
  });
});
