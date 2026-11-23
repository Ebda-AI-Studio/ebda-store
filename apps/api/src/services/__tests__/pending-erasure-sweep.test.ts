import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../alerts.service', () => ({ sendAlert: vi.fn(async () => ({})) }));
import { sweepPendingErasures, PENDING_ERASURE_ALERT_AFTER } from '../pending-erasure-sweep';

const mk = (o: Partial<Parameters<typeof sweepPendingErasures>[0]> = {}) => ({
  storeIds: async () => ['s1'],
  list: async () => [{ userId: 'u1', tries: 0 }],
  erase: vi.fn(async () => undefined),
  note: vi.fn(async (_s: string, _u: string, ok: boolean) => ({ tries: ok ? 0 : 1 })),
  alert: vi.fn(async () => ({}) as never),
  ...o,
});

describe('sweepPendingErasures', () => {
  it('retries the erasure and clears the retry row on success', async () => {
    const d = mk();
    expect(await sweepPendingErasures(d)).toEqual({ found: 1, erased: 1, failed: 0, alerted: 0 });
    expect(d.erase).toHaveBeenCalledWith('s1', 'u1');
    expect(d.note).toHaveBeenCalledWith('s1', 'u1', true);
    expect(d.alert).not.toHaveBeenCalled();
  });
  it('counts a failed try without alerting before the threshold', async () => {
    const d = mk({ erase: vi.fn(async () => Promise.reject(new Error('x'))) });
    expect(await sweepPendingErasures(d)).toMatchObject({ failed: 1, alerted: 0 });
    expect(d.alert).not.toHaveBeenCalled();
  });
  it('pages a P1 with ids only from the Nth failed sweep', async () => {
    const d = mk({
      erase: vi.fn(async () => Promise.reject(new Error('x'))),
      note: vi.fn(async () => ({ tries: PENDING_ERASURE_ALERT_AFTER })),
    });
    expect(await sweepPendingErasures(d)).toMatchObject({ failed: 1, alerted: 1 });
    const a = (d.alert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect([a.level, a.context]).toEqual([
      'p1',
      { storeId: 's1', userId: 'u1', tries: PENDING_ERASURE_ALERT_AFTER },
    ]);
  });
  it('one failing user or store never stops the rest', async () => {
    const d = mk({
      storeIds: async () => ['bad', 's1'],
      list: vi.fn(async (s: string) => {
        if (s === 'bad') throw new Error('down');
        return [
          { userId: 'u1', tries: 0 },
          { userId: 'u2', tries: 0 },
        ];
      }),
      erase: vi.fn(async (_s: string, u: string) => {
        if (u === 'u1') throw new Error('x');
      }),
    });
    expect(await sweepPendingErasures(d)).toMatchObject({ found: 2, erased: 1, failed: 1 });
  });
});
