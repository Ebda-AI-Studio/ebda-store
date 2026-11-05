import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ruling ROLE-GUARD-LAZY-1: the role check runs on a request's first Postgres use (ConnectionScope.get),
// never for a request that does not touch Postgres.
const h = vi.hoisted(() => ({
  pools: 0,
  connectFails: false,
  adapter: { dispose: vi.fn(async () => undefined), queryRaw: vi.fn() },
}));

vi.mock('pg', () => {
  class Pool {
    constructor() {
      h.pools++;
    }
  }
  return { default: { Pool, Client: class {} } };
});
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    async connect() {
      if (h.connectFails) throw new Error('connect ECONNREFUSED (postgres unreachable)');
      return h.adapter;
    }
  },
}));

import { ConnectionScope } from '../client-pool';

const scope = (onConnect?: (a: never) => Promise<void>) =>
  new ConnectionScope('postgresql://u:p@127.0.0.1:1/db', () => undefined, 1, onConnect as never);

describe('ConnectionScope onConnect (lazy role guard hook)', () => {
  beforeEach(() => {
    h.pools = 0;
    h.connectFails = false;
    h.adapter.dispose.mockClear();
  });

  it('a request that never queries opens nothing and never runs the check, even if connecting would throw', async () => {
    h.connectFails = true;
    const onConnect = vi.fn(async () => undefined);
    const s = scope(onConnect);
    await s.close();
    expect(h.pools).toBe(0);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('runs the check once per scope, before the adapter is handed out', async () => {
    const onConnect = vi.fn(async () => undefined);
    const s = scope(onConnect);
    const [a, b] = await Promise.all([s.get(), s.get()]);
    expect(a).toBe(h.adapter);
    expect(b).toBe(h.adapter);
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('refuses the scope and ends the pool when the check throws (fail closed)', async () => {
    const s = scope(async () => {
      throw new Error('Unsafe or unverifiable Hyperdrive database role');
    });
    await expect(s.get()).rejects.toThrow(/Unsafe or unverifiable/);
    await expect(s.get()).rejects.toThrow(/Unsafe or unverifiable/);
    expect(h.adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it('works without a hook (Node callers)', async () => {
    await expect(scope().get()).resolves.toBe(h.adapter);
  });
});
