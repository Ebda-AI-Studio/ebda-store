import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ruling ROLE-GUARD-LAZY-1: guard + the real ConnectionScope hook, with Postgres faked at the pg/adapter edge.
const h = vi.hoisted(() => ({
  pgReachable: true,
  connects: 0,
  rows: [] as unknown[][],
  queryRaw: vi.fn(),
}));

vi.mock('pg', () => ({ default: { Pool: class {}, Client: class {} } }));
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    async connect() {
      h.connects++;
      if (!h.pgReachable) throw new Error('connect ECONNREFUSED (neon quota)');
      return {
        dispose: async () => undefined,
        queryRaw: h.queryRaw.mockImplementation(async () => ({
          columnNames: ['currentUser', 'bypass'],
          rows: h.rows,
        })),
      };
    }
  },
}));

import { ConnectionScope } from '../../packages/database/src/client-pool';
import {
  createDatabaseRoleGuard,
  queryDatabaseRole,
} from '../../apps/api/src/cf/database-role-guard';

const mk = () => {
  const guard = createDatabaseRoleGuard();
  const onConnect = (a: never) => guard(() => queryDatabaseRole(a));
  const newScope = () =>
    new ConnectionScope('postgresql://u:p@x/db', () => undefined, 1, onConnect);
  return { newScope };
};

describe('lazy role guard (worker.ts onConnect)', () => {
  beforeEach(() => {
    h.pgReachable = true;
    h.connects = 0;
    h.rows = [['ebda_app', false]];
    h.queryRaw.mockClear();
  });

  it('a D1/DO-only request succeeds with Postgres unreachable: nothing connects, no check', async () => {
    h.pgReachable = false;
    const { newScope } = mk();
    const s = newScope();
    // the request never calls s.get(): it is served from D1 / the Durable Object
    await s.close();
    expect(h.connects).toBe(0);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('a Postgres-using request with a good role is served, and success is cached across requests', async () => {
    const { newScope } = mk();
    await expect(newScope().get()).resolves.toBeDefined();
    await expect(newScope().get()).resolves.toBeDefined();
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['BYPASSRLS / superuser', [['owner', true]]],
    ['no role row', []],
  ])('a Postgres-using request with %s is refused', async (_n, rows) => {
    h.rows = rows;
    const { newScope } = mk();
    await expect(newScope().get()).rejects.toThrow(/Unsafe or unverifiable/);
  });

  it('a failed check is not cached: the next request re-checks and can pass', async () => {
    const { newScope } = mk();
    h.rows = [['owner', true]];
    await expect(newScope().get()).rejects.toThrow(/Unsafe/);
    h.rows = [['ebda_app', false]];
    await expect(newScope().get()).resolves.toBeDefined();
    h.queryRaw.mockClear();
    await newScope().get();
    expect(h.queryRaw).not.toHaveBeenCalled(); // now cached
  });

  it('Postgres unreachable on a request that needs it fails closed (no check result, no adapter)', async () => {
    h.pgReachable = false;
    const { newScope } = mk();
    await expect(newScope().get()).rejects.toThrow(/ECONNREFUSED/);
  });
});
