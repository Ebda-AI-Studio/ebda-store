import { describe, it, expect } from 'vitest';
import { parseFinanceDate } from '../../apps/api/src/routes/finance.routes';

/**
 * Regression guard for the finance-dashboard 500 (2026-06-20).
 *
 * The admin client sends `Date.toISOString()` (full ISO, e.g.
 * `2026-06-01T00:00:00.000Z`). The dashboard route used to append `T23:59:59`
 * to it, producing `...000ZT23:59:59` → Invalid Date, which then threw on
 * `.toISOString()` / Prisma serialization and 500'd every finance card.
 * parseFinanceDate must accept full ISO as-is and never return an Invalid Date.
 */
const KW = 'Asia/Kuwait';

describe('parseFinanceDate', () => {
  const fallback = new Date('2026-01-01T00:00:00.000Z');

  it('accepts a full ISO timestamp from the admin client as-is', () => {
    const iso = '2026-06-01T00:00:00.000Z';
    const d = parseFinanceDate(iso, fallback, 'start', KW);
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.toISOString()).toBe(iso);
  });

  it('does NOT corrupt a full ISO value by appending a time boundary', () => {
    // The exact shape that broke production.
    const d = parseFinanceDate('2026-06-30T23:59:59.999Z', fallback, 'end', KW);
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  // Owner decision 2026-10-01 (Ruling FRT-1): a date-only value is a day in
  // the STORE's time zone, whatever the server's TZ is.
  it('pins date-only YYYY-MM-DD to the store-local start of day', () => {
    const d = parseFinanceDate('2026-06-15', fallback, 'start', KW);
    expect(d.toISOString()).toBe('2026-06-14T21:00:00.000Z');
  });

  it('pins date-only YYYY-MM-DD to the store-local end of day', () => {
    const d = parseFinanceDate('2026-06-15', fallback, 'end', KW);
    expect(d.toISOString()).toBe('2026-06-15T20:59:59.999Z');
  });

  it('follows the store zone, not a fixed offset', () => {
    expect(parseFinanceDate('2026-06-15', fallback, 'start', 'UTC').toISOString()).toBe(
      '2026-06-15T00:00:00.000Z'
    );
    expect(parseFinanceDate('2026-06-15', fallback, 'end', 'Asia/Dubai').toISOString()).toBe(
      '2026-06-15T19:59:59.999Z'
    );
  });

  it('falls back on a date-only value that is not a real day', () => {
    expect(parseFinanceDate('2026-02-30', fallback, 'start', KW)).toBe(fallback);
  });

  it('falls back when the value is absent', () => {
    expect(parseFinanceDate(undefined, fallback, 'start', KW)).toBe(fallback);
    expect(parseFinanceDate(null, fallback, 'start', KW)).toBe(fallback);
    expect(parseFinanceDate('', fallback, 'start', KW)).toBe(fallback);
  });

  it('falls back (never returns Invalid Date) on an unparseable value', () => {
    const d = parseFinanceDate('not-a-date', fallback, 'start', KW);
    expect(d).toBe(fallback);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('falls back on the historical corruption shape (...ZT00:00:00)', () => {
    // Belt-and-suspenders: even if someone reintroduces the concat upstream,
    // an already-invalid string resolves to the fallback rather than 500ing.
    const d = parseFinanceDate('2026-06-01T00:00:00.000ZT00:00:00', fallback, 'start', KW);
    expect(d).toBe(fallback);
  });
});
