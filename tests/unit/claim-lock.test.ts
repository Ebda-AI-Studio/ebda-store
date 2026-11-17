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

  it("M1: a holder whose lock expired and was re-acquired never deletes the new holder's lock", async () => {
    let releaseSlow!: () => void;
    const slow = withClaimLock('t:m1', 0.05, () => new Promise<void>(r => (releaseSlow = r)));
    await tick(80); // the first lock's 50 ms TTL is over
    let secondDone!: () => void;
    const second = withClaimLock('t:m1', 30, () => new Promise<void>(r => (secondDone = r)));
    await tick();
    releaseSlow(); // the first holder finishes and releases: must NOT clear the second holder's lock
    await slow;
    const third = await withClaimLock('t:m1', 30, async () => 'entered');
    expect(third).toEqual({ acquired: false });
    secondDone();
    await second;
  });

  it('M2: a holder that outlives the TTL is refused at its write, so two callers never both write', async () => {
    const writes: string[] = [];
    const run = (who: string, workMs: number) =>
      withClaimLock('t:m2', 0.2, async guard => {
        await tick(workMs);
        guard.assertHeld(); // immediately before the irreversible write
        writes.push(who);
      });
    const slow = run('slow', 260).catch(e => e); // longer than the 200 ms TTL
    await tick(220); // the lock expired: a second caller gets it
    const fast = await run('fast', 10);
    expect(fast).toMatchObject({ acquired: true });
    expect(await slow).toMatchObject({ code: 'CLAIM_EXPIRED' });
    expect(writes).toEqual(['fast']);
  });

  it('the guard deadline sits below the TTL (5 s, or 20% of a short TTL)', async () => {
    const { claimDeadlineMs } = await import('@api/lib/claim-lock');
    expect(claimDeadlineMs(60)).toBe(55_000);
    expect(claimDeadlineMs(30)).toBe(25_000);
    expect(claimDeadlineMs(1)).toBe(800);
  });

  it('M1 on the stores: release is ONE compare-and-delete script, the exact text the AuthState DO runs as delIfEquals', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/lib/claim-lock.ts'),
      'utf8'
    );
    expect(src).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
    expect(src).toMatch(/client\s*\.eval\(RELEASE_SCRIPT, 1, lockKey, token\)/);
    expect(src).not.toMatch(/client\.get\(lockKey\)/);
    const cf = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/cf/ioredis-cf.ts'),
      'utf8'
    );
    expect(cf).toContain(`script.includes('redis.call("get", KEYS[1]) == ARGV[1]')`);
  });
});
