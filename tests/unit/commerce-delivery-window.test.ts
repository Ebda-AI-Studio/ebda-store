import { describe, it, expect } from 'vitest';
import { deliveryWindow, deliveryDaysSchema } from '@ebda/shared';

// Wednesday 14 Oct 2026, 10:00Z (13:00 in Cairo). Egypt's weekend day is Friday;
// couriers work Saturdays, so "business days" skip Fridays only.
const now = new Date('2026-10-14T10:00:00Z');
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

describe('deliveryWindow (business days, Friday skipped)', () => {
  it('uses the fastest active zone', () => {
    const w = deliveryWindow({
      now,
      leadTimeDays: null,
      zones: [
        { isActive: true, estimatedDaysMin: 3, estimatedDaysMax: 5 },
        { isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 2 },
        { isActive: false, estimatedDaysMin: 0, estimatedDaysMax: 0 },
      ],
    });
    // Wed +1 = Thu 15, +2 skips Fri 16 = Sat 17.
    expect(w).toEqual({ from: at('2026-10-15'), to: at('2026-10-17') });
  });

  it('adds lead time as business days', () => {
    expect(
      deliveryWindow({
        now,
        leadTimeDays: 7,
        zones: [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 2 }],
      })
    ).toEqual({ from: at('2026-10-24'), to: at('2026-10-25') });
  });

  it('falls back to estimatedDays when min/max missing', () => {
    expect(
      deliveryWindow({
        now,
        leadTimeDays: null,
        zones: [
          { isActive: true, estimatedDaysMin: null, estimatedDaysMax: null, estimatedDays: 3 },
        ],
      })
    ).toEqual({ from: at('2026-10-18'), to: at('2026-10-18') });
  });

  it('no zone hides chip', () => {
    expect(deliveryWindow({ now, leadTimeDays: 2, zones: [] })).toBeNull();
    expect(
      deliveryWindow({
        now,
        leadTimeDays: 2,
        zones: [{ isActive: true, estimatedDaysMin: null, estimatedDaysMax: null }],
      })
    ).toBeNull();
    expect(
      deliveryWindow({
        now,
        leadTimeDays: 2,
        zones: [{ isActive: false, estimatedDaysMin: 1, estimatedDaysMax: 2 }],
        fallback: null,
      })
    ).toBeNull();
  });

  it('a Thursday start with 1 business day lands on Saturday', () => {
    const w = deliveryWindow({
      now: at('2026-10-15'),
      leadTimeDays: null,
      zones: [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 1 }],
    });
    expect(w).toEqual({ from: at('2026-10-17'), to: at('2026-10-17') });
  });

  it('a window that spans a Friday skips it', () => {
    const w = deliveryWindow({
      now: at('2026-10-15'),
      leadTimeDays: null,
      zones: [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 3 }],
    });
    // Thu +1 = Sat 17, +2 = Sun 18, +3 = Mon 19. No Friday in between.
    expect(w).toEqual({ from: at('2026-10-17'), to: at('2026-10-19') });
  });

  it('reads the weekday in the store timezone, not UTC', () => {
    // Thu 22:30Z is already Friday 01:30 in Cairo. +1 business day = Saturday.
    const start = new Date('2026-10-15T22:30:00Z');
    const zones = [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 1 }];
    expect(deliveryWindow({ now: start, leadTimeDays: null, zones })?.from).toEqual(
      new Date('2026-10-16T22:30:00Z')
    );
    // Same instant read in UTC (Thursday) would push past Friday to Saturday Oct 17.
    expect(
      deliveryWindow({ now: start, leadTimeDays: null, zones, timeZone: 'UTC' })?.from
    ).toEqual(new Date('2026-10-17T22:30:00Z'));
  });

  it('zero business days started on a Friday moves to Saturday', () => {
    const fri = at('2026-10-16');
    const zones = [{ isActive: true, estimatedDaysMin: 0, estimatedDaysMax: 0 }];
    expect(deliveryWindow({ now: fri, leadTimeDays: null, zones })).toEqual({
      from: at('2026-10-17'),
      to: at('2026-10-17'),
    });
    // Non-Friday zero stays the same day.
    expect(deliveryWindow({ now, leadTimeDays: null, zones })).toEqual({ from: now, to: now });
  });

  it('keeps the Cairo wall-clock time across the DST end (2026-10-29)', () => {
    // 23:30 Cairo (UTC+3) on Wed 28 Oct, the day before clocks go back.
    const start = new Date('2026-10-28T20:30:00Z');
    const w = deliveryWindow({
      now: start,
      leadTimeDays: null,
      zones: [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 3 }],
    })!;
    const cairo = (d: Date) =>
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Africa/Cairo',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(d);
    // Thu 29, (Fri 30 skipped), Sat 31, Sun 1 Nov: all at 23:30 Cairo, not 22:30.
    expect(cairo(w.from)).toBe('2026-10-29 23:30');
    expect(cairo(w.to)).toBe('2026-11-01 23:30');
    expect(w.to).toEqual(new Date('2026-11-01T21:30:00Z')); // UTC+2 after the switch
    const three = deliveryWindow({
      now: start,
      leadTimeDays: null,
      zones: [{ isActive: true, estimatedDaysMin: 2, estimatedDaysMax: 2 }],
    })!;
    expect(cairo(three.from)).toBe('2026-10-31 23:30');
  });

  it('uses the store-wide fallback only when no active zone has numbers', () => {
    const fallback = { min: 2, max: 4 };
    expect(
      deliveryWindow({
        now,
        leadTimeDays: null,
        zones: [{ isActive: true, estimatedDaysMin: null, estimatedDaysMax: null }],
        fallback,
      })
    ).toEqual({ from: at('2026-10-17'), to: at('2026-10-19') });
    expect(deliveryWindow({ now, leadTimeDays: null, zones: [], fallback })).toEqual({
      from: at('2026-10-17'),
      to: at('2026-10-19'),
    });
    // A zone with numbers wins over the fallback.
    expect(
      deliveryWindow({
        now,
        leadTimeDays: null,
        zones: [{ isActive: true, estimatedDaysMin: 1, estimatedDaysMax: 1 }],
        fallback,
      })
    ).toEqual({ from: at('2026-10-15'), to: at('2026-10-15') });
  });

  it('adds lead time to the fallback', () => {
    expect(
      deliveryWindow({
        now,
        leadTimeDays: 1,
        zones: [],
        fallback: { min: 1, max: 1 },
      })
    ).toEqual({ from: at('2026-10-17'), to: at('2026-10-17') });
  });
});

describe('deliveryDaysSchema', () => {
  it('accepts integer business days with min <= max', () => {
    expect(deliveryDaysSchema.safeParse({ min: 2, max: 4 }).success).toBe(true);
    expect(deliveryDaysSchema.safeParse({ min: 0, max: 0 }).success).toBe(true);
    expect(deliveryDaysSchema.safeParse({ min: 30, max: 30 }).success).toBe(true);
  });
  it('rejects bad shapes', () => {
    for (const bad of [
      { min: 5, max: 2 },
      { min: -1, max: 2 },
      { min: 1, max: 31 },
      { min: 1.5, max: 2 },
      { min: 1 },
      'x',
    ]) {
      expect(deliveryDaysSchema.safeParse(bad).success).toBe(false);
    }
  });
});
