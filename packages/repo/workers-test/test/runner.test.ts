import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

const fresh = async (name: string) => {
  const s = env.LITE_DO.get(env.LITE_DO.idFromName(`${name}-${Math.random()}`));
  await (s as any).seed();
  return s as any;
};

describe('prisma-lite on a real Durable Object (workerd)', () => {
  it('basic write + read through the DO runner', async () => {
    const s = await fresh('basic');
    expect(await s.names()).toEqual({ p1: 'alpha', p2: 'beta' });
  });

  it('an unrelated request that runs while an interactive transaction waits on a timer is NOT rolled back with it', async () => {
    const s = await fresh('interleave');
    const [a, b] = await Promise.all([s.txThatFailsAfterTimer(), s.unrelatedWrite()]);
    expect(a).toBe('A fails');
    expect(b).toBe('ok');
    const names = await s.names();
    expect(names.p1).toBe('alpha'); // A rolled back
    expect(names.p2).toBe('OUTSIDE'); // B survived
  });

  it('a failing nested create leaves nothing behind and maps the unique violation with plain column names', async () => {
    const s = await fresh('nested');
    const r = await s.nestedAtomicity();
    expect(r.startsWith('P2002|')).toBe(true);
    expect(r).not.toContain('SQLITE_CONSTRAINT');
    expect(await s.exists('half')).toBe(false);
  });

  it('an error caught inside an interactive transaction leaves no half-applied nested write', async () => {
    const s = await fresh('caught');
    expect(await s.caughtInsideTx()).toBe(0);
    expect(await s.exists('after')).toBe(true);
    expect(await s.exists('half2')).toBe(false);
  });

  it("the DO refuses a write that carries another store's id", async () => {
    const s = await fresh('store');
    expect(await s.foreignStoreWrite()).toMatch(/this store/);
  });
});
