import { describe, expect, it } from 'vitest';
import { evaluateReturnWindow } from '../../apps/api/src/lib/return-window';

const delivered = new Date('2026-10-01T12:00:00Z');
const updated = new Date('2026-09-20T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('evaluateReturnWindow', () => {
  it('has no limit when the merchant declared no window (null / undefined)', () => {
    for (const d of [null, undefined]) {
      expect(
        evaluateReturnWindow({ returnWindowDays: d, deliveredAt: delivered, updatedAt: updated })
      ).toEqual({ open: true, closesAt: null });
    }
  });

  it('refuses every request when the window is 0 (returns not accepted)', () => {
    const v = evaluateReturnWindow({
      returnWindowDays: 0,
      deliveredAt: delivered,
      updatedAt: updated,
      now: at('2026-10-01T12:01:00Z'),
    });
    expect(v).toMatchObject({ open: false, reason: 'NOT_ACCEPTED' });
  });

  it('is open inside the window and exactly at its end', () => {
    const base = { returnWindowDays: 14, deliveredAt: delivered, updatedAt: updated };
    expect(evaluateReturnWindow({ ...base, now: at('2026-10-10T00:00:00Z') }).open).toBe(true);
    expect(evaluateReturnWindow({ ...base, now: at('2026-10-15T12:00:00Z') }).open).toBe(true);
  });

  it('closes one millisecond after deliveredAt + N days', () => {
    const v = evaluateReturnWindow({
      returnWindowDays: 14,
      deliveredAt: delivered,
      updatedAt: updated,
      now: at('2026-10-15T12:00:00.001Z'),
    });
    expect(v).toMatchObject({ open: false, reason: 'EXPIRED' });
    expect(v.closesAt?.toISOString()).toBe('2026-10-15T12:00:00.000Z');
  });

  it('falls back to updatedAt when deliveredAt is null', () => {
    const v = evaluateReturnWindow({
      returnWindowDays: 7,
      deliveredAt: null,
      updatedAt: updated,
      now: at('2026-09-28T12:00:00.001Z'),
    });
    expect(v).toMatchObject({ open: false, reason: 'EXPIRED' });
    expect(v.closesAt?.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(
      evaluateReturnWindow({
        returnWindowDays: 7,
        deliveredAt: null,
        updatedAt: updated,
        now: at('2026-09-27T12:00:00Z'),
      }).open
    ).toBe(true);
  });
});
