import { describe, it, expect } from 'vitest';
import { utcCronsFor, matchesLocal, tickKey } from './cron-expr';

// M-126: a zoned cron whose UTC trigger lands on the previous UTC day must shift day-of-month (and weekday) too.
describe('utcCronsFor zoned day-of-month shift (M-126)', () => {
  it('moves a fixed day-of-month back one day when the UTC hour wraps past midnight', () => {
    // 01:00 Cairo on the 15th = 23:00 UTC (+2) / 22:00 UTC (+3) on the 14th.
    expect(utcCronsFor('TZ=Africa/Cairo 0 1 15 * *')).toEqual(['0 23 14 * *', '0 22 14 * *']);
  });

  it('does not shift the day when the UTC hour does not wrap', () => {
    expect(utcCronsFor('TZ=Africa/Cairo 0 6 15 * *')).toEqual(['0 4 15 * *', '0 3 15 * *']);
  });

  it('refuses day 1 at a wrapping hour (cannot express "last day of previous month")', () => {
    expect(() => utcCronsFor('TZ=Africa/Cairo 0 1 1 * *')).toThrow(/previous UTC day/);
  });

  it('shifts the weekday back with the wrap (Monday 01:00 Cairo -> Sunday, named for CF)', () => {
    expect(utcCronsFor('TZ=Africa/Cairo 0 1 * * 1')).toEqual(['0 23 * * SUN', '0 22 * * SUN']);
  });

  it('passes plain UTC crons through, weekday written as a name', () => {
    expect(utcCronsFor('0 3 * * 0')).toEqual(['0 3 * * SUN']);
  });
});

describe('matchesLocal / tickKey for a day-of-month zoned cron (M-126)', () => {
  const expr = 'TZ=Africa/Cairo 0 1 15 * *';
  it('the shifted UTC trigger matches the real local time on the 15th, in summer (+3) and winter (+2)', () => {
    // 2026-07-14T22:00Z = 01:00 Cairo 15 Jul (+3); 2026-12-14T23:00Z = 01:00 Cairo 15 Dec (+2)
    expect(matchesLocal(expr, new Date('2026-07-14T22:00:00Z'))).toBe(true);
    expect(matchesLocal(expr, new Date('2026-12-14T23:00:00Z'))).toBe(true);
  });
  it('the other offset trigger does not match (only one of the two runs the job)', () => {
    expect(matchesLocal(expr, new Date('2026-07-14T23:00:00Z'))).toBe(false); // 02:00 Cairo
    expect(matchesLocal(expr, new Date('2026-12-14T22:00:00Z'))).toBe(false); // 00:00 Cairo
  });
  it('a UTC cron always matches; its tick key is the tick time', () => {
    const at = new Date('2026-07-14T22:00:00Z');
    expect(matchesLocal('0 3 * * *', at)).toBe(true);
    expect(tickKey('0 3 * * *', at)).toBe(String(at.getTime()));
  });
  it('tickKey of a zoned cron is the LOCAL date+time: the fall-back double 23:xx dedupes', () => {
    // Egypt falls back 2026-10-30 24:00 -> 23:00: local 23:30 on 29 Oct occurs only once, but 23:30 on the
    // fallback night occurs twice (+3 then +2).
    const z = 'TZ=Africa/Cairo 30 23 * * *';
    const first = new Date('2026-10-29T20:30:00Z'); // 23:30 +3
    const second = new Date('2026-10-29T21:30:00Z'); // 23:30 +2 (local 23:30 again? 21:30Z +2 = 23:30)
    expect(tickKey(z, first)).toBe('20261029T2330');
    expect(tickKey(z, second)).toBe(tickKey(z, first));
  });
});
