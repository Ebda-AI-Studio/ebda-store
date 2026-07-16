import { describe, expect, it } from 'vitest';
import {
  computeWindowAvailability,
  getNowMinutesInTimezone,
  parseTimeToMinutes,
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

describe('computeWindowAvailability', () => {
  it('disables a 13:00 window when now is 14:00 (past start)', () => {
    const [result] = computeWindowAvailability([WINDOW_1PM_5PM], 14 * 60);
    expect(result.available).toBe(false);
  });

  it('enables a 13:00 window when now is 12:00 (before start)', () => {
    const [result] = computeWindowAvailability([WINDOW_1PM_5PM], 12 * 60);
    expect(result.available).toBe(true);
  });

  it('disables a window exactly at its start time (at/past start rule)', () => {
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
