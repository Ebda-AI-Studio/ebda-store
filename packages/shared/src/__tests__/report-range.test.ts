import { describe, expect, it } from 'vitest';
import {
  parseReportRange,
  reportRangeQueryString,
  REPORT_RANGE_START_PARAM,
  REPORT_RANGE_END_PARAM,
  DEFAULT_STORE_TIME_ZONE,
  resolveStoreTimeZone,
  zonedDayEnd,
  zonedDayStart,
  zonedIsoDay,
  zonedMonthStartDay,
} from '../schemas/report-range';

const range = {
  startDate: new Date('2026-08-31T21:00:00.000Z'),
  endDate: new Date('2026-09-30T20:59:59.999Z'),
};

describe('shared report-range contract', () => {
  it('round-trips: what the admin builds is exactly what the API parses', () => {
    const q = Object.fromEntries(new URLSearchParams(reportRangeQueryString(range)));
    expect(Object.keys(q).sort()).toEqual([REPORT_RANGE_END_PARAM, REPORT_RANGE_START_PARAM]);
    expect(parseReportRange(q)).toEqual({ ok: true, range });
  });

  it('no range → undefined (the route applies its documented default)', () => {
    expect(parseReportRange({})).toEqual({ ok: true, range: undefined });
    expect(parseReportRange(undefined)).toEqual({ ok: true, range: undefined });
  });

  it('half a range is rejected, never silently defaulted', () => {
    expect(parseReportRange({ startDate: range.startDate.toISOString() }).ok).toBe(false);
    expect(parseReportRange({ endDate: range.endDate.toISOString() }).ok).toBe(false);
  });

  it('unparseable dates and start > end are rejected', () => {
    expect(parseReportRange({ startDate: 'nope', endDate: 'nope' }).ok).toBe(false);
    expect(
      parseReportRange({
        startDate: range.endDate.toISOString(),
        endDate: range.startDate.toISOString(),
      }).ok
    ).toBe(false);
  });

  it('other query params pass through untouched', () => {
    const r = parseReportRange({
      ...Object.fromEntries(new URLSearchParams(reportRangeQueryString(range))),
      limit: '5',
    });
    expect(r).toEqual({ ok: true, range });
  });
});

describe('store-local days (finance reports, Ruling FRT-1)', () => {
  it('a Kuwait day is 21:00Z the day before → 20:59:59.999Z', () => {
    expect(zonedDayStart('2026-09-30', 'Asia/Kuwait')?.toISOString()).toBe(
      '2026-09-29T21:00:00.000Z'
    );
    expect(zonedDayEnd('2026-09-30', 'Asia/Kuwait')?.toISOString()).toBe(
      '2026-09-30T20:59:59.999Z'
    );
  });

  it('labels an instant with its store-local day', () => {
    expect(zonedIsoDay(new Date('2026-09-30T22:30:00.000Z'), 'Asia/Kuwait')).toBe('2026-10-01');
    expect(zonedIsoDay(new Date('2026-09-30T22:30:00.000Z'), 'UTC')).toBe('2026-09-30');
    expect(zonedMonthStartDay(new Date('2026-09-30T22:30:00.000Z'), 'Asia/Kuwait')).toBe(
      '2026-10-01'
    );
  });

  it('a DST day has its real length (America/New_York spring forward)', () => {
    const s = zonedDayStart('2026-03-08', 'America/New_York')!;
    const e = zonedDayEnd('2026-03-08', 'America/New_York')!;
    expect(s.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(e.getTime() - s.getTime() + 1).toBe(23 * 3600_000);
  });

  it('rejects a non-day and an impossible date', () => {
    expect(zonedDayStart('2026-02-30', 'Asia/Kuwait')).toBeUndefined();
    expect(zonedDayStart('30/09/2026', 'Asia/Kuwait')).toBeUndefined();
  });

  it('falls back to Asia/Kuwait for a missing or unknown zone (Ruling FRT-2)', () => {
    expect(DEFAULT_STORE_TIME_ZONE).toBe('Asia/Kuwait');
    expect(resolveStoreTimeZone(undefined)).toBe('Asia/Kuwait');
    expect(resolveStoreTimeZone('')).toBe('Asia/Kuwait');
    expect(resolveStoreTimeZone('Mars/Olympus')).toBe('Asia/Kuwait');
    expect(resolveStoreTimeZone('UTC')).toBe('UTC');
    expect(resolveStoreTimeZone('Asia/Riyadh')).toBe('Asia/Riyadh');
  });
});
