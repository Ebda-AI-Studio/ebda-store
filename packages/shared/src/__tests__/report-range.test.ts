import { describe, expect, it } from 'vitest';
import {
  parseReportRange,
  reportRangeQueryString,
  REPORT_RANGE_START_PARAM,
  REPORT_RANGE_END_PARAM,
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
