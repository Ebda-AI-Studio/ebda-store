import { describe, expect, it } from 'vitest';
import {
  computeWindowAvailability,
  formatWindowTime,
  getNowMinutesInTimezone,
  orderByMinutes,
  parseTimeToMinutes,
  resolveDeliverySelection,
  type DeliveryWindowItem,
} from './deliveryWindows';

const WINDOW_1PM_5PM: DeliveryWindowItem = {
  id: 'w1',
  label: 'Afternoon',
  labelAr: 'بعد الظهر',
  start: '13:00',
  end: '17:00',
};

const WINDOW_6PM_9PM: DeliveryWindowItem = {
  id: 'w2',
  label: 'Evening',
  labelAr: 'مساءً',
  start: '18:00',
  end: '21:00',
};

// The merchant's own example: window A closes for ordering at 14:00 (well
// before its own 6pm end), window B closes at 19:00.
const WINDOW_A_2PM_6PM_ORDERBY_1400: DeliveryWindowItem = {
  id: 'a',
  label: 'Window A',
  labelAr: 'الموعد أ',
  start: '14:00',
  end: '18:00',
  orderBy: '14:00',
};

const WINDOW_B_6PM_9PM_ORDERBY_1900: DeliveryWindowItem = {
  id: 'b',
  label: 'Window B',
  labelAr: 'الموعد ب',
  start: '18:00',
  end: '21:00',
  orderBy: '19:00',
};

describe('parseTimeToMinutes', () => {
  it('parses HH:mm into minutes-since-midnight', () => {
    expect(parseTimeToMinutes('13:00')).toBe(780);
    expect(parseTimeToMinutes('00:00')).toBe(0);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
    expect(parseTimeToMinutes('09:05')).toBe(545);
  });

  it('falls back to 0 for malformed input', () => {
    expect(parseTimeToMinutes('')).toBe(0);
    expect(parseTimeToMinutes('nonsense')).toBe(0);
  });
});

describe('formatWindowTime', () => {
  it('formats 24h times as customer-friendly 12h (en)', () => {
    expect(formatWindowTime('13:00', 'en')).toBe('1:00 PM');
    expect(formatWindowTime('17:30', 'en')).toBe('5:30 PM');
    expect(formatWindowTime('09:05', 'en')).toBe('9:05 AM');
    expect(formatWindowTime('00:00', 'en')).toBe('12:00 AM');
    expect(formatWindowTime('12:00', 'en')).toBe('12:00 PM');
  });

  it('uses Arabic AM/PM markers for the ar locale', () => {
    expect(formatWindowTime('09:05', 'ar')).toBe('9:05 ص');
    expect(formatWindowTime('17:30', 'ar')).toBe('5:30 م');
  });

  it('returns the raw input unchanged when unparseable', () => {
    expect(formatWindowTime('', 'en')).toBe('');
    expect(formatWindowTime('nonsense', 'en')).toBe('nonsense');
    expect(formatWindowTime('25:00', 'en')).toBe('25:00');
  });
});

describe('orderByMinutes', () => {
  it('uses the explicit orderBy time when set', () => {
    expect(orderByMinutes(WINDOW_A_2PM_6PM_ORDERBY_1400)).toBe(14 * 60);
  });

  it('falls back to start when orderBy is unset', () => {
    expect(orderByMinutes(WINDOW_1PM_5PM)).toBe(parseTimeToMinutes(WINDOW_1PM_5PM.start));
  });

  it('falls back to start when orderBy is an empty string', () => {
    expect(orderByMinutes({ ...WINDOW_1PM_5PM, orderBy: '' })).toBe(
      parseTimeToMinutes(WINDOW_1PM_5PM.start)
    );
  });
});

describe('computeWindowAvailability', () => {
  it('disables a 13:00 window (no orderBy) when now is 14:00 (past start)', () => {
    const [result] = computeWindowAvailability([WINDOW_1PM_5PM], 14 * 60);
    expect(result.available).toBe(false);
  });

  it('enables a 13:00 window (no orderBy) when now is 12:00 (before start)', () => {
    const [result] = computeWindowAvailability([WINDOW_1PM_5PM], 12 * 60);
    expect(result.available).toBe(true);
  });

  it('disables a window exactly at its start time when orderBy is unset', () => {
    const [result] = computeWindowAvailability([WINDOW_1PM_5PM], 13 * 60);
    expect(result.available).toBe(false);
  });

  it('evaluates multiple windows independently', () => {
    const results = computeWindowAvailability([WINDOW_1PM_5PM, WINDOW_6PM_9PM], 14 * 60);
    expect(results).toEqual([
      { ...WINDOW_1PM_5PM, available: false },
      { ...WINDOW_6PM_9PM, available: true },
    ]);
  });

  it('marks every window unavailable once all start times have passed', () => {
    const results = computeWindowAvailability([WINDOW_1PM_5PM, WINDOW_6PM_9PM], 22 * 60);
    expect(results.every(r => r.available === false)).toBe(true);
  });

  it('returns an empty array for an empty window list', () => {
    expect(computeWindowAvailability([], 12 * 60)).toEqual([]);
  });

  it('honors a per-window orderBy independently of start/end', () => {
    // Window closes at 14:00 for ordering even though its slot runs to 18:00.
    const [available] = computeWindowAvailability([WINDOW_A_2PM_6PM_ORDERBY_1400], 13 * 60 + 30);
    expect(available.available).toBe(true);
    const [closed] = computeWindowAvailability([WINDOW_A_2PM_6PM_ORDERBY_1400], 14 * 60 + 1);
    expect(closed.available).toBe(false);
  });
});

describe('resolveDeliverySelection', () => {
  const WINDOWS = [WINDOW_A_2PM_6PM_ORDERBY_1400, WINDOW_B_6PM_9PM_ORDERBY_1900];

  // The merchant's exact scenario: A order-by 14:00, B order-by 19:00.
  it('at 13:59, stays on today with both A and B available', () => {
    const result = resolveDeliverySelection(WINDOWS, 13 * 60 + 59);
    expect(result.day).toBe('today');
    expect(result.windows.map(w => ({ id: w.id, available: w.available }))).toEqual([
      { id: 'a', available: true },
      { id: 'b', available: true },
    ]);
  });

  it('at 14:01, stays on today with only B available', () => {
    const result = resolveDeliverySelection(WINDOWS, 14 * 60 + 1);
    expect(result.day).toBe('today');
    expect(result.windows.map(w => ({ id: w.id, available: w.available }))).toEqual([
      { id: 'a', available: false },
      { id: 'b', available: true },
    ]);
  });

  it('at 18:59, stays on today with only B available', () => {
    const result = resolveDeliverySelection(WINDOWS, 18 * 60 + 59);
    expect(result.day).toBe('today');
    expect(result.windows.map(w => ({ id: w.id, available: w.available }))).toEqual([
      { id: 'a', available: false },
      { id: 'b', available: true },
    ]);
  });

  it('at 19:01, rolls over to tomorrow with both A and B available again', () => {
    const result = resolveDeliverySelection(WINDOWS, 19 * 60 + 1);
    expect(result.day).toBe('tomorrow');
    expect(result.windows.map(w => ({ id: w.id, available: w.available }))).toEqual([
      { id: 'a', available: true },
      { id: 'b', available: true },
    ]);
  });

  it('stays on today with an empty list when no windows are configured', () => {
    const result = resolveDeliverySelection([], 12 * 60);
    expect(result).toEqual({ day: 'today', windows: [] });
  });

  it('rolls over even for a single window once its orderBy has passed', () => {
    const result = resolveDeliverySelection([WINDOW_1PM_5PM], 13 * 60);
    expect(result.day).toBe('tomorrow');
    expect(result.windows).toEqual([{ ...WINDOW_1PM_5PM, available: true }]);
  });
});

describe('getNowMinutesInTimezone', () => {
  it('derives store-local minutes-since-midnight for a fixed instant', () => {
    // 2026-07-15T10:30:00Z is 13:30 in Asia/Kuwait (UTC+3).
    const now = new Date('2026-07-15T10:30:00Z');
    expect(getNowMinutesInTimezone('Asia/Kuwait', now)).toBe(13 * 60 + 30);
  });

  it('honors a different timezone for the same instant', () => {
    const now = new Date('2026-07-15T10:30:00Z');
    // UTC stays 10:30.
    expect(getNowMinutesInTimezone('UTC', now)).toBe(10 * 60 + 30);
  });
});
