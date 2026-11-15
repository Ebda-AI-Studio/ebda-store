/**
 * The claim lock serialises "who wrote first" decisions that D1's non-atomic updateMany count cannot (see the header of
 * lib/claim-lock.ts). Process-local stand-in under vitest (no Redis).
 */
import { describe, it, expect } from 'vitest';
import { withClaimLock } from '@api/lib/claim-lock';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

describe('withClaimLock', () => {
  it('lets exactly one concurrent caller run, the other gets acquired:false', async () => {
    let ran = 0;
    const fn = async () => {
      ran++;
      await tick();
      return 'done';
    };
    const [a, b] = await Promise.all([
      withClaimLock('t:one', 30, fn),
      withClaimLock('t:one', 30, fn),
    ]);
    expect(ran).toBe(1);
    expect([a.acquired, b.acquired].sort()).toEqual([false, true]);
  });

  it('releases after fn, also when fn throws, so the next caller runs', async () => {
    await expect(
      withClaimLock('t:two', 30, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const again = await withClaimLock('t:two', 30, async () => 1);
    expect(again).toEqual({ acquired: true, value: 1 });
  });

  it('different keys do not block each other', async () => {
    const [a, b] = await Promise.all([
      withClaimLock('t:a', 30, async () => tick()),
      withClaimLock('t:b', 30, async () => tick()),
    ]);
    expect([a.acquired, b.acquired]).toEqual([true, true]);
  });
});
