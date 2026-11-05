/**
 * G5 per-store alarms: next-run math (DST-safe for Africa/Cairo), the alarm flag, store scoping of
 * handlers, and the per-store concurrency gate. The Durable Object itself is exercised on workerd
 * (apps/api/workers-test/store-schedule.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';
import { nextRunAfter } from '@api/lib/jobs/next-run';
import { ALARM_READY, jobRunsOnAlarm } from '@api/lib/jobs/alarm-flag';
import { JOBS_MAP } from '@api/lib/jobs/jobs-map';
import { acrossOpts, alarmStoreId, storeFilter } from '@api/lib/jobs/store-scope';
import { gatesFor } from '@api/lib/jobs/gate';
import { allJobs, clearJobRegistry, registerJob } from '@api/lib/jobs/registry';
import { alarmEntries } from '@api/lib/jobs/store-schedule';

const cairo = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));

describe('nextRunAfter', () => {
  it('a daily Cairo cron stays at 01:00 local across both DST changes (a 23 h and a 25 h day)', () => {
    let t = Date.UTC(2026, 0, 1);
    const gaps: number[] = [];
    let prev: number | undefined;
    for (let i = 0; i < 400; i++) {
      t = nextRunAfter('TZ=Africa/Cairo 0 1 * * *', t);
      expect(cairo(t)).toBe('01:00');
      if (prev !== undefined) gaps.push((t - prev) / 3_600_000);
      prev = t;
    }
    expect(gaps.filter(g => g === 24).length).toBe(gaps.length - 2);
    expect(gaps.filter(g => g === 23).length).toBe(1); // spring forward
    expect(gaps.filter(g => g === 25).length).toBe(1); // fall back
  });

  it('is strictly after the given instant', () => {
    const at = Date.UTC(2026, 5, 1, 3, 0);
    expect(nextRunAfter('0 3 * * *', at)).toBe(Date.UTC(2026, 5, 2, 3, 0));
    expect(nextRunAfter('0 3 * * *', at - 1)).toBe(at);
  });

  it('weekly, monthly and stepped hour expressions', () => {
    // Sunday 04:00 UTC after Mon 2026-06-01
    expect(new Date(nextRunAfter('0 4 * * 0', Date.UTC(2026, 5, 1))).toISOString()).toBe(
      '2026-06-07T04:00:00.000Z'
    );
    expect(new Date(nextRunAfter('0 3 1 * *', Date.UTC(2026, 5, 2))).toISOString()).toBe(
      '2026-07-01T03:00:00.000Z'
    );
    expect(new Date(nextRunAfter('0 */6 * * *', Date.UTC(2026, 5, 1, 6, 0))).toISOString()).toBe(
      '2026-06-01T12:00:00.000Z'
    );
  });

  it('a weekly Cairo cron whose local hour wraps past midnight lands on the right local weekday', () => {
    const t = nextRunAfter('TZ=Africa/Cairo 0 1 * * 0', Date.UTC(2026, 5, 1));
    const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short' });
    expect(wd.format(new Date(t))).toBe('Sun');
    expect(cairo(t)).toBe('01:00');
  });

  it('rejects what it cannot schedule', () => {
    expect(() => nextRunAfter('TZ=Africa/Cairo */5 * * * *', 0)).toThrow();
    expect(() => nextRunAfter('0 3 31 2 *', 0)).toThrow(/never fires/);
  });
});

describe('alarm flag', () => {
  beforeEach(() => {
    setCfBindings({
      JOBS_WORKFLOW: { create: async () => ({ id: 'i' }) },
      JOBS_QUEUE: { send: async () => undefined },
      STORE_SCHEDULE: { idFromName: (n: string) => n, get: () => ({}) as never },
    });
  });
  afterEach(() => {
    clearCfBindings();
    delete process.env.JOBS_CF_ALARMS;
  });

  it('off by default; on for a listed alarm-ready job or all', () => {
    expect(jobRunsOnAlarm('accounting-daily-close')).toBe(false);
    process.env.JOBS_CF_ALARMS = 'accounting-daily-close';
    expect(jobRunsOnAlarm('accounting-daily-close')).toBe(true);
    expect(jobRunsOnAlarm('stock-reorder-scan-cron')).toBe(false);
    process.env.JOBS_CF_ALARMS = 'all';
    expect(jobRunsOnAlarm('stock-reorder-scan-cron')).toBe(true);
  });

  it('never for a job that is not alarm-ready, even with all', () => {
    process.env.JOBS_CF_ALARMS = 'all';
    expect(jobRunsOnAlarm('audit-log-archive-weekly')).toBe(false);
    expect(jobRunsOnAlarm('ai-autofill-sweep')).toBe(false);
    expect(jobRunsOnAlarm('heartbeat')).toBe(false);
  });

  it('needs the Worker and DO bindings', () => {
    process.env.JOBS_CF_ALARMS = 'all';
    clearCfBindings();
    expect(jobRunsOnAlarm('accounting-daily-close')).toBe(false);
  });

  it('every alarm-ready job is an alarm job in the map with a cron trigger', () => {
    for (const id of ALARM_READY) {
      expect(JOBS_MAP[id]?.alarm, id).toBe(true);
      expect(JOBS_MAP[id]?.trigger, id).toBe('cron');
    }
  });

  it('alarmEntries lists only the enabled jobs with their cron', () => {
    clearJobRegistry();
    registerJob(
      { id: 'accounting-daily-close', triggers: [{ cron: 'TZ=Africa/Cairo 0 1 * * *' }] },
      async () => undefined
    );
    registerJob(
      { id: 'stock-reorder-scan-cron', triggers: [{ cron: 'TZ=Africa/Cairo 0 6 * * *' }] },
      async () => undefined
    );
    process.env.JOBS_CF_ALARMS = 'accounting-daily-close';
    expect(allJobs().length).toBe(2);
    expect(alarmEntries()).toEqual([
      { job: 'accounting-daily-close', cron: 'TZ=Africa/Cairo 0 1 * * *' },
    ]);
    clearJobRegistry();
  });
});

describe('store scope of an alarm run', () => {
  const alarm = { data: { alarm: true, storeId: 's1' } };
  it('only an alarm event is scoped (a cron or a manual event with a storeId is not)', () => {
    expect(alarmStoreId(alarm)).toBe('s1');
    expect(alarmStoreId({ data: { storeId: 's1' } })).toBeUndefined();
    expect(alarmStoreId({ data: { alarm: true } })).toBeUndefined();
    expect(alarmStoreId(undefined)).toBeUndefined();
  });
  it('storeFilter keeps the alarm store AND the handler predicate', () => {
    const pred = (s: { id: string; on: boolean }) => s.on;
    const rows = [
      { id: 's1', on: true },
      { id: 's2', on: true },
      { id: 's1', on: false },
    ];
    expect(rows.filter(storeFilter(alarm, pred))).toEqual([{ id: 's1', on: true }]);
    expect(rows.filter(storeFilter({ data: {} }, pred)).length).toBe(2);
  });
  it('acrossOpts restricts acrossStores to the alarm store', () => {
    expect(acrossOpts(alarm)).toEqual({ storeIds: ['s1'] });
    expect(acrossOpts({ data: {} })).toEqual({});
  });
  it('a global limit-1 gate becomes per store for an alarm run', () => {
    const def = { id: 'accounting-daily-close', options: { id: 'x', concurrency: { limit: 1 } } };
    const ev = (data: Record<string, unknown>) => ({ name: 'inngest/scheduled.timer', data });
    expect(gatesFor(def as never, ev({ cron: 'x' }))[0].gateId).toBe('accounting-daily-close|*');
    expect(gatesFor(def as never, ev({ alarm: true, storeId: 's1' }))[0].gateId).toBe(
      'accounting-daily-close|s1'
    );
  });
});
