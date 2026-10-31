import { describe, expect, it } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { CATCH_UP_MS, MAX_ATTEMPTS, type ScheduleRow } from '../src/cf/store-schedule';
import type { AlarmEvent } from '../src/cf/store-schedule';

/**
 * G5 per-store alarms on real workerd: the alarm logic of StoreSchedule (a recording dispatcher
 * stands in for the job starter), driven with `runDurableObjectAlarm`. The deployed class in the
 * built Worker is covered at the bottom through its RPC (the heartbeat job needs no database).
 */
interface Sched {
  arm(storeId: string, e: { job: string; cron: string }[], now?: number): Promise<ScheduleRow[]>;
  status(): Promise<{ storeId?: string; alarmAt: number | null; rows: ScheduleRow[] }>;
  fire(
    now?: number
  ): Promise<{ started: string[]; skipped: string[]; failed: string[]; parked: string[] }>;
  setFrozen(on: boolean): Promise<void>;
  failNext(n: number): Promise<void>;
  calls(): Promise<{ job: string; event: AlarmEvent }[]>;
  gaveUp(): Promise<string[]>;
}
const e = env as unknown as {
  TEST_SCHEDULE: { idFromName(n: string): unknown; get(id: unknown): Sched };
  STORE_SCHEDULE: { idFromName(n: string): unknown; get(id: unknown): Sched };
};
const fresh = () => e.TEST_SCHEDULE.get(e.TEST_SCHEDULE.idFromName(`s-${Math.random()}`));
const CAIRO_1AM = 'TZ=Africa/Cairo 0 1 * * *';
const HOUR = 3_600_000;

/** Make every row due `msAgo` ago (the alarm itself fires on the real clock in tests). */
async function makeDue(stub: Sched, msAgo = 1000) {
  await runInDurableObject(stub as never, (_i, state) => {
    state.storage.sql.exec('UPDATE schedule SET next_at = ?', Date.now() - msAgo);
  });
}

describe('StoreSchedule alarm under the write freeze (Ruling CF-JOBS-2)', () => {
  it('a frozen alarm starts NOTHING, keeps its due time and attempts, re-arms 5 minutes out, and runs after the thaw', async () => {
    const s = fresh();
    await s.arm('store-f', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    await makeDue(s);
    const before = (await s.status()).rows[0];
    await s.setFrozen(true);
    const t0 = Date.now();
    expect(await runDurableObjectAlarm(s as never)).toBe(true);
    expect(await s.calls()).toEqual([]);
    const held = await s.status();
    expect(held.rows[0]).toMatchObject({
      next_at: before.next_at,
      attempts: 0,
      fence: before.fence,
    });
    expect(held.rows[0].retry_at).toBeGreaterThanOrEqual(t0 + 5 * 60_000 - 1000);
    expect(held.alarmAt).toBeGreaterThanOrEqual(t0 + 5 * 60_000 - 1000); // re-armed, not dropped
    // still frozen at the retry time: still nothing
    expect((await s.fire(held.rows[0].retry_at! + 1)).parked).toEqual(['accounting-daily-close']);
    expect(await s.calls()).toEqual([]);
    // thaw: the SAME occurrence runs, with its original event id
    await s.setFrozen(false);
    const again = (await s.status()).rows[0];
    expect(again.next_at).toBe(before.next_at); // parking twice still did not move the occurrence
    const out = await s.fire(again.retry_at! + 1);
    expect(out.started).toEqual(['accounting-daily-close']);
    const calls = await s.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].event.id).toBe(`alarm-accounting-daily-close-store-f-${before.next_at}`);
  });
});

describe('StoreSchedule alarm', () => {
  it('arm sets the alarm at the next 01:00 Cairo and is idempotent', async () => {
    const s = fresh();
    const rows = await s.arm('store-1', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    expect(rows).toHaveLength(1);
    const st = await s.status();
    expect(st.alarmAt).toBe(rows[0].next_at);
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(rows[0].next_at));
    expect(local).toBe('01:00');
    const again = await s.arm('store-1', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    expect(again[0].next_at).toBe(rows[0].next_at);
  });

  it('the alarm starts the due job scoped to its store, with a stable event id, and re-arms', async () => {
    const s = fresh();
    await s.arm('store-7', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    await makeDue(s);
    const before = (await s.status()).rows[0];
    expect(await runDurableObjectAlarm(s as never)).toBe(true);
    const calls = await s.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0].job).toBe('accounting-daily-close');
    expect(calls[0].event.id).toBe(`alarm-accounting-daily-close-store-7-${before.next_at}`);
    expect(calls[0].event.data).toMatchObject({ alarm: true, storeId: 'store-7', fence: 1 });
    const after = await s.status();
    expect(after.rows[0].next_at).toBeGreaterThan(Date.now());
    expect(after.rows[0].fence).toBe(1);
    expect(after.alarmAt).toBe(after.rows[0].next_at);
  });

  it('only due jobs fire; the others keep their time', async () => {
    const s = fresh();
    await s.arm('store-2', [
      { job: 'accounting-daily-close', cron: CAIRO_1AM },
      { job: 'stock-reorder-scan-cron', cron: 'TZ=Africa/Cairo 0 6 * * *' },
    ]);
    await runInDurableObject(s as never, (_i, state) => {
      state.storage.sql.exec(
        `UPDATE schedule SET next_at = ? WHERE job = 'accounting-daily-close'`,
        Date.now() - 1000
      );
    });
    const rows0 = (await s.status()).rows;
    const reorderAt = rows0.find(r => r.job === 'stock-reorder-scan-cron')!.next_at;
    await runDurableObjectAlarm(s as never);
    expect((await s.calls()).map(c => c.job)).toEqual(['accounting-daily-close']);
    expect((await s.status()).rows.find(r => r.job === 'stock-reorder-scan-cron')!.next_at).toBe(
      reorderAt
    );
  });

  it('a failed start retries with backoff, then runs once on success (no duplicate)', async () => {
    const s = fresh();
    await s.arm('store-3', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    await makeDue(s);
    await s.failNext(1);
    await runDurableObjectAlarm(s as never);
    expect(await s.calls()).toHaveLength(0);
    const r1 = (await s.status()).rows[0];
    expect(r1.attempts).toBe(1);
    expect(r1.retry_at).toBeGreaterThan(Date.now());
    // The retry time passes: the same occurrence (same event id) is started.
    await runInDurableObject(s as never, (_i, state) => {
      state.storage.sql.exec('UPDATE schedule SET retry_at = ?', Date.now() - 1);
    });
    await runDurableObjectAlarm(s as never);
    expect(await s.calls()).toHaveLength(1);
    expect((await s.calls())[0].event.id).toContain(String(r1.next_at));
    expect((await s.status()).rows[0].attempts).toBe(0);
  });

  it('gives up on an occurrence after MAX_ATTEMPTS: alert hook once, next occurrence still scheduled', async () => {
    const s = fresh();
    await s.arm('store-4', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    await makeDue(s);
    await s.failNext(MAX_ATTEMPTS);
    const first = (await s.status()).rows[0].next_at;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runInDurableObject(s as never, (_inst, state) => {
        state.storage.sql.exec('UPDATE schedule SET retry_at = NULL');
      });
      await s.fire(Date.now());
    }
    expect(await s.calls()).toHaveLength(0);
    expect(await s.gaveUp()).toEqual(['accounting-daily-close']);
    const row = (await s.status()).rows[0];
    expect(row.next_at).toBeGreaterThan(first);
    expect(row.attempts).toBe(0);
  });

  it('an occurrence older than the catch-up window is skipped, not run', async () => {
    const s = fresh();
    await s.arm('store-5', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    await makeDue(s, CATCH_UP_MS + HOUR);
    await runDurableObjectAlarm(s as never);
    expect(await s.calls()).toHaveLength(0);
    expect((await s.status()).rows[0].next_at).toBeGreaterThan(Date.now());
  });

  it('re-arming with fewer entries removes the rest, and none clears the alarm', async () => {
    const s = fresh();
    await s.arm('store-6', [
      { job: 'accounting-daily-close', cron: CAIRO_1AM },
      { job: 'wholesale-pending-nudge-cron', cron: 'TZ=Africa/Cairo 0 9 * * *' },
    ]);
    expect(
      (await s.arm('store-6', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }])).length
    ).toBe(1);
    expect((await s.arm('store-6', [])).length).toBe(0);
    expect((await s.status()).alarmAt).toBeNull();
  });

  it('a changed cron recomputes that entry only', async () => {
    const s = fresh();
    const a = await s.arm('store-8', [{ job: 'accounting-daily-close', cron: CAIRO_1AM }]);
    const b = await s.arm('store-8', [
      { job: 'accounting-daily-close', cron: 'TZ=Africa/Cairo 0 3 * * *' },
    ]);
    expect(b[0].next_at).not.toBe(a[0].next_at);
  });
});

describe('StoreSchedule in the built Worker', () => {
  it('arms and reports through the real class (no database needed)', async () => {
    const s = e.STORE_SCHEDULE.get(e.STORE_SCHEDULE.idFromName(`real-${Math.random()}`));
    const rows = await s.arm('store-real', [{ job: 'heartbeat', cron: '0 3 * * *' }]);
    expect(rows[0].job).toBe('heartbeat');
    const st = await s.status();
    expect(st.storeId).toBe('store-real');
    expect(st.alarmAt).toBe(rows[0].next_at);
  });
});
