/**
 * Ruling NZ-MONEY-3 (review M-8 of PR 455): a money-out request's Idempotency-Key. Same key -> the first answer, never a second
 * effect; a request still running (or one that may have moved money and failed) -> 409; a failure before any money moved frees
 * the key. The store is an in-memory double of the `SET NX EX` client the Worker gets from the AuthState DO.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, string>();
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    getClient: () => ({
      set: async (k: string, v: string, ...rest: unknown[]) => {
        if (rest.includes('NX') && kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      },
      get: async (k: string) => kv.get(k) ?? null,
      del: async (k: string) => (kv.delete(k) ? 1 : 0),
    }),
  },
}));

const { withIdempotencyKey, idempotencyKeyOf } = await import('@api/lib/money-idempotency');
const never = () => false;

describe('withIdempotencyKey', () => {
  beforeEach(() => kv.clear());

  it('same key: the first answer comes back and the effect runs once', async () => {
    const effect = vi.fn(async () => ({ refundId: 'rf-1', amount: 100 }));
    const a = await withIdempotencyKey('refund:u1:tx', 'key-00001', effect, never);
    const b = await withIdempotencyKey('refund:u1:tx', 'key-00001', effect, never);
    expect(a).toEqual({ replayed: false, value: { refundId: 'rf-1', amount: 100 } });
    expect(b).toEqual({ replayed: true, value: { refundId: 'rf-1', amount: 100 } });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('a second request while the first runs is refused 409, nothing runs twice', async () => {
    let release!: () => void;
    const slow = vi.fn(() => new Promise<string>(r => (release = () => r('done'))));
    const first = withIdempotencyKey('refund:u1:tx', 'key-00002', slow, never);
    await new Promise(r => setTimeout(r, 0));
    await expect(
      withIdempotencyKey('refund:u1:tx', 'key-00002', slow, never)
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    release();
    await first;
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('a failure before money moved frees the key; one after which it may have moved keeps it (409 on retry)', async () => {
    const fails = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(withIdempotencyKey('s', 'key-00003', fails, never)).rejects.toThrow('nope');
    await expect(withIdempotencyKey('s', 'key-00003', async () => 'ok', never)).resolves.toEqual({
      replayed: false,
      value: 'ok',
    });
    await expect(withIdempotencyKey('s', 'key-00004', fails, () => true)).rejects.toThrow('nope');
    await expect(
      withIdempotencyKey('s', 'key-00004', async () => 'ok', never)
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('no key = the old behaviour; a malformed key is a 400', async () => {
    const effect = vi.fn(async () => 1);
    await withIdempotencyKey('s', undefined, effect, never);
    await withIdempotencyKey('s', undefined, effect, never);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(idempotencyKeyOf(undefined)).toBeUndefined();
    expect(() => idempotencyKeyOf('bad key!')).toThrow();
  });

  it('#628: a required scope refuses a missing key with 400 and runs nothing', async () => {
    const effect = vi.fn(async () => 1);
    await expect(
      withIdempotencyKey('refund', undefined, effect, never, { required: true })
    ).rejects.toMatchObject({ statusCode: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(effect).not.toHaveBeenCalled();
    await withIdempotencyKey('refund', 'key-00099', effect, never, { required: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
