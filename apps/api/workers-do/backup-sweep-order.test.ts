// P2-5 (2026-11-12 data-jobs audit): the sweep exports D1 FIRST, bounds the per-store loop (deadline / cap / per-store timeout,
// resumed from an id cursor) and retries backupNow once for a store whose yesterday manifest is missing.
import { describe, expect, it } from 'vitest';
import {
  runBackupSweep,
  SWEEP_CURSOR_KEY,
  type SweepEnv,
  type D1Like,
} from '../src/cf/ops/backup-sweep';

const memR2 = (log: string[] = []) => {
  const m = new Map<string, string>();
  return {
    m,
    put: async (k: string, v: string) => {
      log.push(`put:${k}`);
      m.set(k, v);
    },
    get: async (k: string) => (m.has(k) ? { text: async () => m.get(k)! } : null),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })),
    }),
  };
};
const emptyD1 = (log: string[]): D1Like =>
  ({
    prepare: (sql: string) => ({
      all: async () => {
        log.push('d1');
        return sql.includes('SELECT name') ? { results: [] } : { results: [] };
      },
    }),
    batch: async () => [],
  }) as never;

type Stub = { ensureBackupAlarm(): Promise<number>; backupNow(id: string): Promise<unknown> };
const fakeEnv = (
  r2: ReturnType<typeof memR2>,
  stubs: Record<string, Partial<Stub>>,
  log: string[]
): SweepEnv =>
  ({
    STORE_BACKUPS: r2,
    PLATFORM_DB: emptyD1(log),
    STORE_DO: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        ensureBackupAlarm: async () => {
          log.push(`store:${id}`);
          return 1;
        },
        backupNow: async () => void log.push(`backup:${id}`),
        ...stubs[id],
      }),
    },
  }) as never;

const day = new Date('2026-11-03T03:00:00Z');
const yesterdayKey = (id: string) => `store-do-backups/${id}/2026-11-02/manifest.json`;

describe('backup sweep order, bounds and retry (P2-5)', () => {
  it('exports D1 before it touches any store', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    r2.m.set(yesterdayKey('s1'), '{}');
    await runBackupSweep(fakeEnv(r2, {}, log), {
      listStoreIds: () => ['s1'],
      alert: async () => {},
      now: day,
    });
    expect(log.indexOf('d1')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('d1')).toBeLessThan(log.indexOf('store:s1'));
  });

  it('a hung store times out and the rest of the loop and D1 still complete', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    for (const id of ['a', 'b']) r2.m.set(yesterdayKey(id), '{}');
    const rep = await runBackupSweep(
      fakeEnv(r2, { a: { ensureBackupAlarm: () => new Promise(() => {}) } }, log),
      { listStoreIds: () => ['a', 'b'], alert: async () => {}, now: day, storeTimeoutMs: 40 }
    );
    expect(rep.stores.errors.join()).toMatch(/store a timed out/);
    expect(log).toContain('store:b');
    expect(rep.d1.PLATFORM_DB.ok).toBe(true);
  });

  it('stops at the cap, reports the deferred stores, and the next tick resumes at the cursor', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    const ids = ['s1', 's2', 's3', 's4', 's5'];
    for (const id of ids) r2.m.set(yesterdayKey(id), '{}');
    const alerts: string[] = [];
    const deps = {
      listStoreIds: () => ids,
      alert: async (t: string) => void alerts.push(t),
      now: day,
      maxStores: 2,
    };
    const first = await runBackupSweep(fakeEnv(r2, {}, log), deps);
    expect(first.stores.armed).toBe(2);
    expect(first.stores.deferred).toBe(3);
    expect(first.ok).toBe(true); // normal deferral above the cap is not an alert (see backup-sweep-scale.test.ts)
    expect(JSON.parse(r2.m.get(SWEEP_CURSOR_KEY)!).next).toBe('s3');
    log.length = 0;
    const second = await runBackupSweep(fakeEnv(r2, {}, log), deps);
    expect(log.filter(l => l.startsWith('store:'))).toEqual(['store:s3', 'store:s4']);
    expect(second.stores.deferred).toBe(3);
    expect(JSON.parse(r2.m.get(SWEEP_CURSOR_KEY)!).next).toBe('s5');
    const third = await runBackupSweep(fakeEnv(r2, {}, log), { ...deps, maxStores: 10 });
    expect(third.stores.deferred).toBe(0); // starts at s5, wraps around to s1..s4
    expect(JSON.parse(r2.m.get(SWEEP_CURSOR_KEY)!).next).toBeNull();
  });

  it('stops at the wall-clock budget', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    const ids = ['s1', 's2', 's3'];
    for (const id of ids) r2.m.set(yesterdayKey(id), '{}');
    let t = 0;
    const rep = await runBackupSweep(fakeEnv(r2, {}, log), {
      listStoreIds: () => ids,
      alert: async () => {},
      now: day,
      budgetMs: 10,
      clock: () => (t += 6),
    });
    expect(rep.stores.deferred).toBeGreaterThan(0);
  });

  it('retries backupNow ONCE for a store with history but no yesterday manifest, and recovers the store', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    r2.m.set('store-do-backups/old/2026-10-30/manifest.json', '{}');
    const alerts: string[] = [];
    const rep = await runBackupSweep(fakeEnv(r2, {}, log), {
      listStoreIds: () => ['old'],
      alert: async t => void alerts.push(t),
      now: day,
    });
    expect(log.filter(l => l === 'backup:old')).toHaveLength(1);
    expect(rep.stores.recovered).toEqual(['old']);
    expect(rep.stores.missingYesterday).toEqual([]);
    expect(rep.ok).toBe(false); // the alarm failure still pages (see backup-sweep-scale.test.ts)
    expect(alerts).toHaveLength(1);
  });

  it('a retry that fails is attempted once, stays missing and pages', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    r2.m.set('store-do-backups/bad/2026-10-30/manifest.json', '{}');
    let calls = 0;
    const alerts: string[] = [];
    const rep = await runBackupSweep(
      fakeEnv(
        r2,
        {
          bad: {
            backupNow: async () => {
              calls++;
              throw new Error('boom');
            },
          },
        },
        log
      ),
      { listStoreIds: () => ['bad'], alert: async t => void alerts.push(t), now: day }
    );
    expect(calls).toBe(1);
    expect(rep.stores.missingYesterday).toEqual(['bad']);
    expect(rep.stores.errors.join()).toMatch(/retry backupNow failed: boom/);
    expect(alerts).toHaveLength(1);
  });
});
