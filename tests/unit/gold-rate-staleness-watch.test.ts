/**
 * Gold-rate pricing, Task 11 (Ruling B5-16): stale-rate alerts. Frozen clock at 21 h 59 / 22 h /
 * 25 h 59 / 26 h with a 26 h max age: nothing / warn / nothing new / block + P1. Each alert fires
 * ONCE per rate (a sentinel), a new rate resets the cycle, and an idle tick opens no step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  watch: [] as Array<{
    storeId: string;
    karat: number;
    rateId: string;
    appliedAt: Date;
    maxAgeMinutes: number;
  }>,
  sentinels: new Set<string>(),
  emails: [] as Array<{ kind: string; to: string; hours?: number }>,
  alerts: [] as Array<{ level: string; scope?: string; source?: string }>,
  redisDown: false,
  noRedis: false,
  failEmail: 0,
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  goldRateWatch: async () => h.watch,
  goldFeedStores: async () => [],
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    getClient: () => {
      if (h.redisDown) throw new Error('redis down');
      if (h.noRedis) return null;
      return {
        get: async (key: string) => (h.sentinels.has(key) ? '1' : null),
        set: async (key: string) => {
          h.sentinels.add(key);
          return 'OK';
        },
      };
    },
  },
}));
vi.mock('../../apps/api/src/services/email.service', () => ({
  EmailService: {
    sendGoldRateNotice: async (_s: string, kind: string, d: { to: string; hours?: number }) => {
      if (h.failEmail > 0) {
        h.failEmail--;
        throw new Error('smtp down');
      }
      h.emails.push({ kind, to: d.to, hours: d.hours });
    },
  },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: async (o: { level: string; scope?: string; source?: string }) => {
    h.alerts.push(o);
    return {};
  },
}));
// The notice reads the store's name and owner through its own backend (CF-JOBS-4): `withStoreDb`, faked as a Postgres store.
vi.mock('../../apps/api/src/lib/jobs/store-db', () => ({
  withStoreDb: async (_id: string, fn: (db: unknown) => unknown) =>
    fn({
      store: {
        findUnique: async () => ({
          name: 'Dahab',
          slug: 'dahab',
          owner: { email: 'owner@example.com' },
        }),
      },
    }),
}));

const { handleGoldRateStalenessWatch } =
  await import('../../apps/api/src/lib/inngest/functions/gold-rate-staleness-watch');

const APPLIED = new Date('2026-10-21T08:00:00Z');
const at = (mins: number) => new Date(APPLIED.getTime() + mins * 60_000);
const row = (rateId = 'r1', maxAgeMinutes = 1560) => ({
  storeId: 's1',
  karat: 21,
  rateId,
  appliedAt: APPLIED,
  maxAgeMinutes,
});
let steps = 0;
const step = {
  run: async <T>(_id: string, fn: () => Promise<T>) => {
    steps++;
    return fn();
  },
};
const tick = (now: Date) => handleGoldRateStalenessWatch({ step }, now);

beforeEach(() => {
  h.watch = [];
  h.sentinels.clear();
  h.emails.length = 0;
  h.alerts.length = 0;
  h.redisDown = false;
  h.noRedis = false;
  h.failEmail = 0;
  steps = 0;
});

describe('an idle tick costs one execution', () => {
  it('nothing in the window: returns before opening a step', async () => {
    expect(await tick(at(60))).toEqual({ stores: 0 });
    expect(steps).toBe(0);
  });
});

describe('frozen clock, 26 h max age (warn at 22 h, block at 26 h)', () => {
  beforeEach(() => {
    h.watch = [row()];
  });
  it('21 h 59: nothing is sent (the row is outside the warning window)', async () => {
    await tick(at(21 * 60 + 59));
    expect(h.emails).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
  it('22 h: one warning email, no P1', async () => {
    await tick(at(22 * 60));
    expect(h.emails).toEqual([{ kind: 'warning', to: 'owner@example.com', hours: 22 }]);
    expect(h.alerts).toEqual([]);
  });
  it('25 h 59: still only the warning that already went out (the sentinel holds)', async () => {
    await tick(at(22 * 60));
    h.emails.length = 0;
    await tick(at(25 * 60 + 59));
    expect(h.emails).toEqual([]);
  });
  it('26 h: the "selling paused" email AND a store-scoped P1, once', async () => {
    await tick(at(22 * 60));
    h.emails.length = 0;
    await tick(at(26 * 60));
    expect(h.emails).toEqual([{ kind: 'blocked', to: 'owner@example.com', hours: 26 }]);
    expect(h.alerts).toEqual([
      {
        level: 'p1',
        scope: 'store',
        store: expect.anything(),
        source: 'cron.gold-rate-staleness',
        title: expect.any(String),
        body: expect.any(String),
        context: expect.any(Object),
      },
    ]);
    // a second run sends nothing (sentinel)
    h.emails.length = 0;
    h.alerts.length = 0;
    await tick(at(27 * 60));
    expect(h.emails).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
  it('a NEW rate (new id) resets the cycle: its warning goes out again', async () => {
    await tick(at(22 * 60));
    expect(h.emails).toHaveLength(1);
    h.watch = [{ ...row('r2'), appliedAt: new Date(APPLIED.getTime() + 24 * 3600_000) }];
    h.emails.length = 0;
    await tick(new Date(APPLIED.getTime() + (24 + 22) * 3600_000));
    expect(h.emails).toEqual([{ kind: 'warning', to: 'owner@example.com', hours: 22 }]);
  });
  it('a lowered max age (1 h) shifts the windows: at 70 min of a 60 min limit it blocks', async () => {
    h.watch = [row('r3', 60)];
    await tick(at(70));
    expect(h.emails.map(e => e.kind)).toEqual(['blocked']);
  });
  it('the oldest karat decides the wording when a store has several', async () => {
    h.watch = [
      { ...row('r4'), karat: 18, appliedAt: new Date(APPLIED.getTime() + 3 * 3600_000) },
      row('r5'),
    ];
    await tick(at(26 * 60));
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0].kind).toBe('blocked');
  });
  it('no sentinel store (client throws): it sends nothing rather than email every hour, AND says so with a P1', async () => {
    h.redisDown = true;
    await tick(at(26 * 60));
    expect(h.emails).toEqual([]);
    expect(h.alerts.map(a => a.source)).toEqual(['cron.gold-rate-staleness-no-sentinel-store']);
  });
  it('no sentinel store (no client at all): the same, loudly', async () => {
    h.noRedis = true;
    const out = await tick(at(26 * 60));
    expect(h.emails).toEqual([]);
    expect(out).toMatchObject({ outcome: 'no-sentinel-store' });
    expect(h.alerts.map(a => a.level)).toEqual(['p1']);
  });
  // Ruling B5-36: the once-only marker is claimed AFTER the send, so a failed send is retried next run.
  it('a send that throws leaves the marker unset: the NEXT run sends it, and a P1 names the failure', async () => {
    h.failEmail = 1;
    await tick(at(22 * 60));
    expect(h.emails).toEqual([]);
    expect(h.sentinels.size).toBe(0);
    expect(h.alerts.map(a => a.source)).toEqual(['cron.gold-rate-staleness-failed']);
    h.alerts.length = 0;
    await tick(at(23 * 60));
    expect(h.emails).toEqual([{ kind: 'warning', to: 'owner@example.com', hours: 23 }]);
    expect(h.sentinels.size).toBe(1);
  });
  it('one store failing does not stop the stores after it', async () => {
    h.failEmail = 1;
    h.watch = [row('rA'), { ...row('rB'), storeId: 's2' }];
    await tick(at(22 * 60));
    expect(h.emails).toHaveLength(1); // s1 failed, s2 went out
  });
});
