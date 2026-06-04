/**
 * db-retry unit tests — retryOnWriteConflict
 *
 * A Serializable transaction aborts conflicting writers with Prisma P2034
 * ("write conflict or deadlock — please retry"). The retry wrapper must retry
 * P2034 a bounded number of times, must NOT retry business/other errors, and
 * must give up after the cap. Verified here against the real Prisma error type.
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@force/database';
import { retryOnWriteConflict } from '../../apps/api/src/lib/db-retry';

function p2034(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('write conflict', {
    code: 'P2034',
    clientVersion: 'test',
  });
}

describe('retryOnWriteConflict', () => {
  it('returns the result without retrying when fn succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retryOnWriteConflict(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on P2034 and succeeds on a later attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockResolvedValue('ok');
    const result = await retryOnWriteConflict(fn, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry cap and rethrows the P2034', async () => {
    const fn = vi.fn().mockRejectedValue(p2034());
    await expect(retryOnWriteConflict(fn, { retries: 2, baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'P2034',
    });
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does NOT retry a non-P2034 error (e.g. a business error) — propagates immediately', async () => {
    const businessError = Object.assign(new Error('Not enough inventory'), {
      code: 'INSUFFICIENT_INVENTORY',
    });
    const fn = vi.fn().mockRejectedValue(businessError);
    await expect(retryOnWriteConflict(fn, { baseDelayMs: 1 })).rejects.toThrow(
      'Not enough inventory'
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a different Prisma error code (e.g. P2002 unique constraint)', async () => {
    const fn = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    await expect(retryOnWriteConflict(fn, { baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
