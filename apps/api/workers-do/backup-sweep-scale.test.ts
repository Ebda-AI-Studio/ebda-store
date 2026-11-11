// P2-5 follow-up: a fleet above one tick's cap is walked across nights without paging every night, and a retry that recovers a store
// never hides the missed alarm.
import { describe, expect, it } from 'vitest';
import { runBackupSweep, type SweepEnv, type D1Like } from '../src/cf/ops/backup-sweep';

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

const day = (d: string) => new Date(`${d}T03:00:00Z`);
const yk = (id: string, d: string) => `store-do-backups/${id}/${d}/manifest.json`;
const ids = ['s1', 's2', 's3', 's4', 's5', 's6'];

describe('backup sweep at scale (P2-5 follow-up)', () => {
  it('walking a fleet bigger than the cap over several nights does not page, and visits every store', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    const alerts: string[] = [];
    const visited = new Set<string>();
    for (const [i, d] of ['2026-11-03', '2026-11-04', '2026-11-05'].entries()) {
      for (const id of ids)
        r2.m.set(yk(id, new Date(day(d).getTime() - 86_400_000).toISOString().slice(0, 10)), '{}');
      log.length = 0;
      const rep = await runBackupSweep(fakeEnv(r2, {}, log), {
        listStoreIds: () => ids,
        alert: async t => void alerts.push(t),
        now: day(d),
        maxStores: 2,
      });
      log.filter(l => l.startsWith('store:')).forEach(l => visited.add(l.slice(6)));
      expect(rep.stores.walkNights).toBe(i + 1);
      expect(rep.stores.deferred).toBe(4 - 0);
      expect(rep.ok).toBe(true);
    }
    expect(alerts).toEqual([]);
    expect([...visited].sort()).toEqual(ids);
  });

  it('pages when the walk has been running longer than the allowed nights', async () => {
    const r2 = memR2();
    const alerts: string[] = [];
    let last;
    for (const d of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']) {
      for (const id of ids)
        r2.m.set(yk(id, new Date(day(d).getTime() - 86_400_000).toISOString().slice(0, 10)), '{}');
      last = await runBackupSweep(fakeEnv(r2, {}, []), {
        listStoreIds: () => ids,
        alert: async t => void alerts.push(t),
        now: day(d),
        maxStores: 1,
        maxDeferredNights: 3,
      });
    }
    expect(last!.stores.walkNights).toBe(4);
    expect(last!.stores.deferredAlert).toBe(true);
    expect(last!.ok).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  it('pages when a tick reaches no store at all (no progress)', async () => {
    const r2 = memR2();
    const alerts: string[] = [];
    const rep = await runBackupSweep(fakeEnv(r2, {}, []), {
      listStoreIds: () => ids,
      alert: async t => void alerts.push(t),
      now: day('2026-11-03'),
      maxStores: 0,
    });
    expect(rep.stores.deferredAlert).toBe(true);
    expect(rep.ok).toBe(false);
    expect(alerts).toHaveLength(1);
  });

  it('a successful backupNow retry still records and pages the missed alarm', async () => {
    const log: string[] = [];
    const r2 = memR2(log);
    r2.m.set('store-do-backups/old/2026-10-30/manifest.json', '{}');
    const alerts: string[] = [];
    const rep = await runBackupSweep(fakeEnv(r2, {}, log), {
      listStoreIds: () => ['old'],
      alert: async (t, b) => void alerts.push(`${t}|${b}`),
      now: day('2026-11-03'),
    });
    expect(rep.stores.recovered).toEqual(['old']);
    expect(rep.stores.alarmMissed).toEqual(['old']);
    expect(rep.ok).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('alarmMissedRecoveredByRetry');
    expect(alerts[0]).toContain('old');
    const saved = JSON.parse(r2.m.get('ops-reports/backup-sweep/2026-11-03.json')!);
    expect(saved.stores.alarmMissed).toEqual(['old']);
  });
});
