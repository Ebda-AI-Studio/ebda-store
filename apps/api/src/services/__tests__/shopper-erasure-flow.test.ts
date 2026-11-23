import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { AppError } from '../../middleware/error-handler';
import { runShopperErasure } from '../shopper-erasure-flow';

const ctx = { storeId: 'st1', userId: 'u1' };
const steps = (o: Partial<Parameters<typeof runShopperErasure>[1]> = {}) => ({
  erase: vi.fn(async () => ({ orderIds: [] })),
  eraseIdentity: vi.fn(async () => ({ erased: true })),
  lockIdentity: vi.fn(async () => undefined),
  alert: vi.fn(async () => ({}) as never),
  ...o,
});

describe('runShopperErasure', () => {
  it('refusals become a 409 with an ar + en message and the identity is never touched', async () => {
    const s = steps({
      erase: vi.fn(async () => {
        throw new AppError(409, 'ACCOUNT_HAS_OPEN_ORDERS', 'x');
      }),
    });
    const e = await runShopperErasure(ctx, s).catch(x => x);
    expect([e.statusCode ?? e.status, e.code]).toEqual([409, 'ACCOUNT_HAS_OPEN_ORDERS']);
    expect(e.message).toMatch(/order in progress/);
    expect(e.message).toMatch(/طلب شغال/);
    expect(s.eraseIdentity).not.toHaveBeenCalled();
    expect(s.lockIdentity).not.toHaveBeenCalled();
  });
  it('an unexpected store-half failure propagates and nothing else runs (store section is atomic)', async () => {
    const s = steps({ erase: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(runShopperErasure(ctx, s)).rejects.toThrow('boom');
    expect(s.eraseIdentity).not.toHaveBeenCalled();
    expect(s.lockIdentity).not.toHaveBeenCalled();
  });
  it('mid-chain: identity erase fails once -> retried, completes, no lock', async () => {
    const eraseIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ erased: true });
    const s = steps({ eraseIdentity });
    await expect(runShopperErasure(ctx, s)).resolves.toMatchObject({ identity: { erased: true } });
    expect(s.lockIdentity).not.toHaveBeenCalled();
  });
  it('mid-chain: identity erase fails twice -> account locked, 503 ERASURE_INCOMPLETE (never a bare 500)', async () => {
    const s = steps({ eraseIdentity: vi.fn(async () => Promise.reject(new Error('down'))) });
    const e = await runShopperErasure(ctx, s).catch(x => x);
    expect(e.code).toBe('ERASURE_INCOMPLETE');
    expect(e.statusCode ?? e.status).toBe(503);
    expect(s.lockIdentity).toHaveBeenCalledTimes(1);
    // a real P1 with ids only
    expect(s.alert).toHaveBeenCalledTimes(1);
    const a = (s.alert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect([a.level, a.context]).toEqual(['p1', { storeId: 'st1', userId: 'u1' }]);
  });
});
