/**
 * Phase B4 Task 5, Ruling B4-7: the pure delivery-date resolver both the storefront and the order
 * endpoint run. Earliest date = today + (store estimate + the cart's longest lead time) BUSINESS
 * days, skipping the store's off days, in the store timezone; today is offered only while a window
 * can still be booked; then `daysAhead` working days. The order endpoint writes the note itself.
 */
import { describe, it, expect } from 'vitest';
import {
  deliveryDateChoices,
  checkDeliveryPick,
  deliveryNoteLine,
  formatDeliveryDate,
  formatWindowTime12,
  daysAheadSchema,
} from '@ebda/shared';
import { resolveOrderDeliveryNote } from '../../apps/api/src/lib/order-delivery-slot';

const WINDOWS = [
  { id: 'lunch', start: '12:00', orderBy: '10:00' },
  { id: 'dinner', start: '18:00', orderBy: '15:00' },
];
/** An instant that reads `hh:mm` on the wall clock in Cairo on the given date (UTC+3 in October 2026, +2 after the DST end). */
const cairo = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`);
const dates = (c: ReturnType<typeof deliveryDateChoices>) => c.map(x => x.date);
const base = { windows: WINDOWS, daysAhead: 5, offDays: [] as number[], timeZone: 'Africa/Cairo' };

describe('deliveryDateChoices', () => {
  it('Thursday morning: today is on offer with both windows, then the next days', () => {
    // 2026-10-22 is a Thursday
    const c = deliveryDateChoices({ ...base, now: cairo('2026-10-22', '08:30') });
    expect(dates(c)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(c[0].offset).toBe(0);
    expect(c[0].windows).toEqual([
      { id: 'lunch', available: true },
      { id: 'dinner', available: true },
    ]);
    expect(c[1].windows.every(w => w.available)).toBe(true);
  });
  it("Thursday evening: today's cut-offs have passed, so the first date is tomorrow (the existing rollover)", () => {
    const c = deliveryDateChoices({ ...base, now: cairo('2026-10-22', '19:00') });
    expect(c[0].date).toBe('2026-10-23');
    expect(c[0].offset).toBe(1);
  });
  it('between the cut-offs only the later window is bookable today', () => {
    const c = deliveryDateChoices({ ...base, now: cairo('2026-10-22', '11:00') });
    expect(c[0].date).toBe('2026-10-22');
    expect(c[0].windows).toEqual([
      { id: 'lunch', available: false },
      { id: 'dinner', available: true },
    ]);
  });
  it('a store with no windows has no cut-off: today stays on offer late in the day', () => {
    const c = deliveryDateChoices({ ...base, windows: [], now: cairo('2026-10-22', '23:30') });
    expect(c[0].date).toBe('2026-10-22');
    expect(c[0].windows).toEqual([]);
  });
  it('Friday is skipped by default (Egypt weekend) and not when the store delivers every day', () => {
    const def = deliveryDateChoices({ ...base, offDays: null, now: cairo('2026-10-22', '08:00') });
    expect(dates(def)).toEqual([
      '2026-10-22',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ]);
    const every = deliveryDateChoices({ ...base, offDays: [], now: cairo('2026-10-22', '08:00') });
    expect(dates(every)).toContain('2026-10-23');
  });
  it('asked on an off day, the first date is the next working day', () => {
    // Friday 2026-10-23, default off day
    const c = deliveryDateChoices({ ...base, offDays: null, now: cairo('2026-10-23', '09:00') });
    expect(c[0].date).toBe('2026-10-24');
    expect(c[0].offset).toBe(1);
  });
  it('lead time 3 hides today and counts business days (off days skipped)', () => {
    const c = deliveryDateChoices({
      ...base,
      offDays: null,
      maxLeadTimeDays: 3,
      now: cairo('2026-10-22', '08:00'),
    });
    // Thu +3 business days, Friday skipped: Sat(1) Sun(2) Mon(3)
    expect(c[0].date).toBe('2026-10-26');
    const none = deliveryDateChoices({
      ...base,
      maxLeadTimeDays: 0,
      now: cairo('2026-10-22', '08:00'),
    });
    expect(none[0].date).toBe('2026-10-22');
  });
  it('the store estimate and the lead time add up', () => {
    const c = deliveryDateChoices({
      ...base,
      estimateDays: 1,
      maxLeadTimeDays: 1,
      now: cairo('2026-10-22', '08:00'),
    });
    expect(c[0].date).toBe('2026-10-24'); // +2 business days with Friday off? offDays [] -> Sat
  });
  it('reads the store timezone, not the server clock: just after midnight in Cairo is already the next day', () => {
    // 2026-10-22 22:30 UTC = 2026-10-23 01:30 in Cairo (UTC+3)
    const c = deliveryDateChoices({ ...base, windows: [], now: new Date('2026-10-22T22:30:00Z') });
    expect(c[0].date).toBe('2026-10-23');
  });
  it('steps calendar days across the DST switch (Cairo falls back on the last Thursday of October)', () => {
    // 2026-10-29 is the last Thursday; the offset changes from +3 to +2 that night
    const c = deliveryDateChoices({
      ...base,
      daysAhead: 4,
      windows: [],
      now: cairo('2026-10-28', '12:00'),
    });
    expect(dates(c)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
  });
  it('returns nothing for a daysAhead outside 1-14, and exactly daysAhead dates inside', () => {
    for (const bad of [0, 15, 1.5, NaN, -3])
      expect(
        deliveryDateChoices({ ...base, daysAhead: bad, now: cairo('2026-10-22', '08:00') })
      ).toEqual([]);
    expect(
      deliveryDateChoices({ ...base, daysAhead: 14, now: cairo('2026-10-22', '08:00') })
    ).toHaveLength(14);
    expect(daysAheadSchema.safeParse(14).success).toBe(true);
    expect(daysAheadSchema.safeParse(15).success).toBe(false);
  });
  it('a typo in the store timezone falls back to Cairo instead of throwing', () => {
    expect(() =>
      deliveryDateChoices({ ...base, timeZone: 'Mars/Olympus', now: cairo('2026-10-22', '08:00') })
    ).not.toThrow();
  });
});

describe('checkDeliveryPick', () => {
  const choices = deliveryDateChoices({ ...base, now: cairo('2026-10-22', '11:00') });
  it('accepts an offered date and a bookable window', () => {
    expect(
      checkDeliveryPick(choices, { deliveryDate: '2026-10-22', deliveryWindowId: 'dinner' }, true)
    ).toEqual({ ok: true, date: '2026-10-22', windowId: 'dinner' });
    expect(
      checkDeliveryPick(choices, { deliveryDate: '2026-10-24', deliveryWindowId: 'lunch' }, true).ok
    ).toBe(true);
  });
  it('refuses a missing date, a date off the list, a hand-edited past date, a closed window, an unknown window', () => {
    const reason = (p: Parameters<typeof checkDeliveryPick>[1]) => {
      const r = checkDeliveryPick(choices, p, true);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason({})).toBe('DATE_REQUIRED');
    expect(reason({ deliveryDate: '2026-10-21', deliveryWindowId: 'dinner' })).toBe(
      'DATE_UNAVAILABLE'
    );
    expect(reason({ deliveryDate: '2099-01-01', deliveryWindowId: 'dinner' })).toBe(
      'DATE_UNAVAILABLE'
    );
    expect(reason({ deliveryDate: '2026-10-22' })).toBe('WINDOW_REQUIRED');
    expect(reason({ deliveryDate: '2026-10-22', deliveryWindowId: 'lunch' })).toBe(
      'WINDOW_UNAVAILABLE'
    );
    expect(reason({ deliveryDate: '2026-10-22', deliveryWindowId: 'nope' })).toBe(
      'WINDOW_UNAVAILABLE'
    );
  });
  it('without windows a window id is ignored', () => {
    const noWin = deliveryDateChoices({ ...base, windows: [], now: cairo('2026-10-22', '11:00') });
    expect(
      checkDeliveryPick(noWin, { deliveryDate: '2026-10-22', deliveryWindowId: 'x' }, false)
    ).toEqual({
      ok: true,
      date: '2026-10-22',
      windowId: null,
    });
  });
  it('no dates on offer never blocks checkout', () => {
    expect(checkDeliveryPick([], {}, true)).toEqual({ ok: true, date: '', windowId: null });
  });
});

describe('formatting', () => {
  it('formats the 12-hour window time in both languages', () => {
    expect(formatWindowTime12('14:00', 'en')).toBe('2:00 PM');
    expect(formatWindowTime12('00:05', 'ar')).toBe('12:05 ص');
    expect(formatWindowTime12('nonsense', 'en')).toBe('nonsense');
  });
  it('formats a calendar date without slipping a day, Western digits in Arabic', () => {
    expect(formatDeliveryDate('2026-10-23', 'en')).toBe('Fri 23 Oct');
    const ar = formatDeliveryDate('2026-10-23', 'ar');
    expect(ar).toContain('الجمعة');
    expect(ar).toContain('23');
    expect(ar).toContain('أكتوبر');
    expect(ar).not.toMatch(/[٠-٩]/);
  });
  it('writes the note line with the same prefix the client wrote before', () => {
    const win = { label: 'Evening', labelAr: 'عشا', start: '18:00', end: '20:00' };
    expect(deliveryNoteLine({ locale: 'en', date: '2026-10-23', window: win })).toBe(
      'Delivery: Fri 23 Oct, Evening (6:00 PM–8:00 PM)'
    );
    expect(deliveryNoteLine({ locale: 'ar', date: '2026-10-23', window: win })).toBe(
      'التوصيل: الجمعة 23 أكتوبر، عشا (6:00 م–8:00 م)'
    );
    expect(deliveryNoteLine({ locale: 'en', date: '2026-10-23' })).toBe('Delivery: Fri 23 Oct');
  });
});

describe('resolveOrderDeliveryNote (the order endpoint, Ruling B4-7)', () => {
  const settings = (over: Record<string, unknown> = {}) => ({
    checkoutDelivery: {
      note: { enabled: false, text: '', textAr: '' },
      windows: {
        enabled: true,
        items: [
          {
            id: 'lunch',
            label: 'Lunch',
            labelAr: 'غدا',
            start: '12:00',
            end: '14:00',
            orderBy: '10:00',
          },
          {
            id: 'dinner',
            label: 'Dinner',
            labelAr: 'عشا',
            start: '18:00',
            end: '20:00',
            orderBy: '15:00',
          },
        ],
      },
      daysAhead: 5,
    },
    deliveryOffDays: [],
    ...over,
  });
  const run = (over: Record<string, unknown> = {}) =>
    resolveOrderDeliveryNote({
      settings: settings(),
      timeZone: 'Africa/Cairo',
      now: cairo('2026-10-22', '08:00'),
      maxLeadTimeDays: 0,
      deliveryDate: '2026-10-23',
      deliveryWindowId: 'dinner',
      locale: 'ar',
      enforce: true,
      ...over,
    });
  it('writes the Arabic line for a valid pick', () => {
    expect(run()).toBe('التوصيل: الجمعة 23 أكتوبر، عشا (6:00 م–8:00 م)');
  });
  it('a store WITHOUT daysAhead is untouched: no line, nothing validated, even with junk sent', () => {
    const legacy = {
      ...settings(),
      checkoutDelivery: { ...settings().checkoutDelivery, daysAhead: undefined },
    };
    expect(run({ settings: legacy, deliveryDate: '1999-01-01' })).toBeNull();
    expect(run({ settings: {} })).toBeNull();
    expect(run({ settings: null })).toBeNull();
  });
  it('refuses with 422 DELIVERY_SLOT_UNAVAILABLE: a stale or hand-edited date, a closed window, a missing date', () => {
    for (const over of [
      { deliveryDate: '2026-10-21' },
      { deliveryDate: '2099-01-01' },
      { deliveryDate: '2026-10-22', deliveryWindowId: 'lunch', now: cairo('2026-10-22', '11:00') },
      { deliveryDate: undefined },
      { deliveryWindowId: undefined },
    ])
      expect(() => run(over), JSON.stringify(over)).toThrowError(
        expect.objectContaining({ statusCode: 422, code: 'DELIVERY_SLOT_UNAVAILABLE' })
      );
  });
  it('a lead time on a cart product moves the first offered date: today is refused', () => {
    expect(() => run({ deliveryDate: '2026-10-22', maxLeadTimeDays: 2 })).toThrowError(
      expect.objectContaining({ code: 'DELIVERY_SLOT_UNAVAILABLE' })
    );
    expect(run({ deliveryDate: '2026-10-24', maxLeadTimeDays: 2 })).toContain('السبت');
  });
  it('an off-day edit reaches the very next order (live settings, never cached)', () => {
    const friday = settings({ deliveryOffDays: [5] });
    expect(() => run({ settings: friday })).toThrowError(
      expect.objectContaining({ code: 'DELIVERY_SLOT_UNAVAILABLE' })
    );
  });
  it('non-storefront sources may omit the date, but a date they send is validated', () => {
    expect(
      run({ enforce: false, deliveryDate: undefined, deliveryWindowId: undefined })
    ).toBeNull();
    expect(() => run({ enforce: false, deliveryDate: '2099-01-01' })).toThrowError(
      expect.objectContaining({ code: 'DELIVERY_SLOT_UNAVAILABLE' })
    );
  });
  it('speaks English for an English order', () => {
    expect(run({ locale: 'en' })).toBe('Delivery: Fri 23 Oct, Dinner (6:00 PM–8:00 PM)');
  });
  it('store estimate: deliveryDays.min pushes the first date', () => {
    expect(() =>
      run({ settings: settings({ deliveryDays: { min: 2, max: 3 } }), deliveryDate: '2026-10-22' })
    ).toThrowError(expect.objectContaining({ code: 'DELIVERY_SLOT_UNAVAILABLE' }));
  });
});
