/**
 * G5: Inngest crons on Cloudflare Cron Triggers (lib/jobs/schedule.ts). UTC crons pass through,
 * zoned ones (Africa/Cairo, which has DST) get both UTC offsets plus a local-time guard, and
 * wrangler.jsonc declares exactly the legacy schedules plus the job ones.
 */
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CRON_SCHEDULE } from '@api/cf/cron';
import { matchesLocal, parseCron, tickKey, utcCronsFor } from '@api/lib/jobs/schedule';
import { collectCronFunctions } from '../helpers/inngest-cron-budget';

const ROOT = path.join(__dirname, '..', '..');
const wrangler = ts.parseConfigFileTextToJson(
  'w.jsonc',
  readFileSync(path.join(ROOT, 'apps/api/wrangler.jsonc'), 'utf8')
).config as { triggers: { crons: string[] } };

const jobCrons = collectCronFunctions(path.join(ROOT, 'apps/api/src/lib/inngest/functions')).map(
  c => c.cron.replace('<tz>', 'Africa/Cairo')
);

describe('utcCronsFor', () => {
  it('passes plain UTC crons through untouched', () => {
    expect(utcCronsFor('7 * * * *')).toEqual(['7 * * * *']);
    expect(utcCronsFor('7,37 * * * *')).toEqual(['7,37 * * * *']);
    expect(utcCronsFor('17 */6 * * *')).toEqual(['17 */6 * * *']);
  });
  it('Cairo crons get the winter (+2) and summer (+3) UTC triggers', () => {
    expect(utcCronsFor('TZ=Africa/Cairo 0 6 * * *')).toEqual(['0 4 * * *', '0 3 * * *']);
    expect(utcCronsFor('TZ=Africa/Cairo 30 1 * * *')).toEqual(['30 23 * * *', '30 22 * * *']);
  });
  it('a weekly Cairo cron whose hour wraps past midnight moves to the previous weekday', () => {
    // Sunday 01:00 Cairo is Saturday 23:00 / 22:00 UTC.
    expect(utcCronsFor('TZ=Africa/Cairo 0 1 * * 0')).toEqual(['0 23 * * 6', '0 22 * * 6']);
    // Monday 00:00 Cairo is Sunday.
    expect(utcCronsFor('TZ=Africa/Cairo 0 0 * * 1')).toEqual(['0 22 * * 0', '0 21 * * 0']);
  });
  it('refuses a zoned expression it cannot translate (no silent wrong schedule)', () => {
    expect(() => utcCronsFor('TZ=Africa/Cairo */5 * * * *')).toThrow();
    expect(() => utcCronsFor('TZ=Mars/Olympus 0 6 * * *')).toThrow(/offsets/);
  });
  it('parseCron reads the zone and fields', () => {
    expect(parseCron('TZ=Africa/Cairo 0 6 * * 0')).toMatchObject({
      tz: 'Africa/Cairo',
      hour: 6,
      min: 0,
      dow: 0,
    });
  });
});

describe('matchesLocal (the DST guard)', () => {
  const expr = 'TZ=Africa/Cairo 0 6 * * *';
  it('winter: 04:00 UTC is 06:00 Cairo, 03:00 UTC is not', () => {
    expect(matchesLocal(expr, new Date('2026-01-15T04:00:00Z'))).toBe(true);
    expect(matchesLocal(expr, new Date('2026-01-15T03:00:00Z'))).toBe(false);
  });
  it('summer (EEST): 03:00 UTC is 06:00 Cairo, 04:00 UTC is not', () => {
    expect(matchesLocal(expr, new Date('2026-07-15T03:00:00Z'))).toBe(true);
    expect(matchesLocal(expr, new Date('2026-07-15T04:00:00Z'))).toBe(false);
  });
  it('exactly one of the two triggers matches on any day of the year', () => {
    for (let d = 0; d < 366; d += 3) {
      const day = new Date(Date.UTC(2026, 0, 1 + d));
      const hits = [4, 3].filter(h => matchesLocal(expr, new Date(day.getTime() + h * 3_600_000)));
      expect(hits.length, day.toISOString()).toBe(1);
    }
  });
  it('weekly: Sunday 06:00 Cairo only', () => {
    const w = 'TZ=Africa/Cairo 0 6 * * 0';
    expect(matchesLocal(w, new Date('2026-01-18T04:00:00Z'))).toBe(true); // Sunday
    expect(matchesLocal(w, new Date('2026-01-19T04:00:00Z'))).toBe(false); // Monday
  });
  it('a plain UTC cron always matches', () => {
    expect(matchesLocal('7 * * * *', new Date())).toBe(true);
  });
});

describe('wrangler.jsonc Cron Triggers', () => {
  const declared = [...wrangler.triggers.crons].sort();
  const expected = [
    ...new Set([...Object.keys(CRON_SCHEDULE), ...jobCrons.flatMap(utcCronsFor)]),
  ].sort();

  it('declares exactly the legacy schedules plus every job schedule', () => {
    expect(declared).toEqual(expected);
  });

  it('cron-budget discipline: nothing under 30 minutes except the pre-existing */15 abandoned-cart sweep', () => {
    const sub30 = declared.filter(
      c => /^\*\/(\d+) /.test(c) && Number(/^\*\/(\d+)/.exec(c)![1]) < 30
    );
    expect(sub30).toEqual(['*/15 * * * *']);
    // and no job cron is more frequent than every 30 minutes
    for (const c of jobCrons) expect(/^(\*|\*\/\d+) /.test(c), c).toBe(false);
  });
});

describe('zoned crons across the UTC day boundary (M-126, Ruling P18-3)', () => {
  it('a monthly Cairo cron whose hour wraps fires on the previous UTC day-of-month', () => {
    // the 15th at 01:00 Cairo is the 14th at 23:00 / 22:00 UTC
    expect(utcCronsFor('TZ=Africa/Cairo 0 1 15 * *')).toEqual(['0 23 14 * *', '0 22 14 * *']);
  });
  it('a monthly cron that does not wrap keeps its day-of-month', () => {
    expect(utcCronsFor('TZ=Africa/Cairo 0 6 15 * *')).toEqual(['0 4 15 * *', '0 3 15 * *']);
  });
  it('refuses a day-1 cron whose hour wraps instead of silently never firing', () => {
    expect(() => utcCronsFor('TZ=Africa/Cairo 0 1 1 * *')).toThrow(/previous UTC day/);
    expect(() => utcCronsFor('TZ=Africa/Cairo 0 2 1 * *')).toThrow(/hour >= 3/);
    expect(utcCronsFor('TZ=Africa/Cairo 0 3 1 * *')).toEqual(['0 1 1 * *', '0 0 1 * *']);
  });
  it('the repeated local hour on the night Egypt falls back gets ONE start id', () => {
    const expr = 'TZ=Africa/Cairo 30 23 * * *';
    const first = new Date('2026-10-29T20:30:00Z'); // 23:30 at +03
    const second = new Date('2026-10-29T21:30:00Z'); // 23:30 again at +02
    expect(matchesLocal(expr, first)).toBe(true);
    expect(matchesLocal(expr, second)).toBe(true);
    expect(tickKey(expr, first)).toBe(tickKey(expr, second));
    // a different local day is a different key, and a UTC cron still keys by the tick time
    expect(tickKey(expr, new Date('2026-10-30T21:30:00Z'))).not.toBe(tickKey(expr, first));
    expect(tickKey('7 * * * *', first)).toBe(String(first.getTime()));
  });
});
