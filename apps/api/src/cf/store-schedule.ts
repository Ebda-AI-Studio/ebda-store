/**
 * StoreSchedule: one SQLite Durable Object per store that owns the store's recurring jobs as an
 * ALARM (G5, Ruling G5-2). It replaces the "list every store" step of a global cron: the alarm of
 * store S fires S's jobs, scoped to S (`event.data = { alarm, storeId }`, lib/jobs/store-scope.ts).
 *
 *  - Time: each entry is a cron expression (Africa/Cairo ones are DST-safe, lib/jobs/next-run.ts).
 *    The next occurrence is computed after every fire, from the real clock.
 *  - Exactly-once-ish: the event id is `alarm-<job>-<store>-<scheduledFor>`; a Workflow instance with
 *    that id is created once, so a re-fire (crash between dispatch and save) is a no-op. A queue-kind
 *    job has no instance id, but those are whole-run idempotent by construction (jobs-map.ts).
 *    The concurrency gate is keyed `<job>|<store>` for alarm events, so two runs of one store's job
 *    never overlap (lease + fencing, lib/jobs/run-workflow.ts).
 *  - Failure: a dispatch error retries with backoff (30 s .. 15 min); after MAX_ATTEMPTS that
 *    occurrence is skipped and logged (the next one runs normally). A late alarm beyond CATCH_UP_MS
 *    (the DO was unreachable for a long time) skips the stale occurrence instead of stampeding.
 *  - Arming: `arm(storeId, entries)` is idempotent and also REMOVES entries no longer wanted
 *    (a job switched back to cron). The hourly sync cron (lib/jobs/store-schedule.ts) and store
 *    creation call it.
 */
import { DurableObject } from 'cloudflare:workers';
import { nextRunAfter } from '../lib/jobs/next-run';

export interface ScheduleEntry {
  job: string;
  cron: string;
}

export interface ScheduleRow {
  job: string;
  cron: string;
  next_at: number;
  last_at: number | null;
  fence: number;
  attempts: number;
  retry_at: number | null;
}

export interface FireResult {
  started: string[];
  skipped: string[];
  failed: string[];
  /** Due but held back by the write freeze: same due time, looked at again FREEZE_RETRY_MS later. */
  parked: string[];
}

/** While frozen a due alarm waits this long before looking at the flag again (no attempt is spent). */
export const FREEZE_RETRY_MS = 5 * 60_000;

export const CATCH_UP_MS = 24 * 60 * 60_000;
export const MAX_ATTEMPTS = 5;
const MIN_ALARM_GAP_MS = 1000;

export function retryBackoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export abstract class StoreScheduleBase<Env = unknown> extends DurableObject<Env> {
  /** Start the job for one alarm occurrence. Throws when it could not be started. */
  protected abstract dispatch(job: string, event: AlarmEvent): Promise<unknown>;

  /** An occurrence was given up on after MAX_ATTEMPTS failed starts: tell the alert channel. */
  protected async onGaveUp(_job: string, _event: AlarmEvent, _err: unknown): Promise<void> {}

  /** Is the write freeze on (WRITES_FROZEN=1, Ruling CF-JOBS-2)? The base loads in a bare test worker, so it never freezes. */
  protected isFrozen(): boolean {
    return false;
  }

  /** Structured log line. A no-op here (the base loads in a bare test worker); the deployed class logs. */
  protected log(_level: 'warn' | 'error', _fields: LogFields, _msg: string): void {}

  private init(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(
      `CREATE TABLE IF NOT EXISTS schedule (
         job TEXT PRIMARY KEY, cron TEXT NOT NULL, next_at INTEGER NOT NULL, last_at INTEGER,
         fence INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER)`
    );
  }

  private storeId(): string | undefined {
    const r = this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = 'store_id'`).toArray()[0];
    return r ? String(r.v) : undefined;
  }

  private rows(): ScheduleRow[] {
    return this.ctx.storage.sql
      .exec(`SELECT * FROM schedule ORDER BY next_at, job`)
      .toArray() as unknown as ScheduleRow[];
  }

  /** Idempotent: keep the pending time of an unchanged entry, recompute a changed cron, drop the rest. */
  async arm(storeId: string, entries: ScheduleEntry[], now = Date.now()): Promise<ScheduleRow[]> {
    this.init();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO meta (k, v) VALUES ('store_id', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
        storeId
      );
      const want = new Map(entries.map(e => [e.job, e.cron]));
      for (const r of this.rows())
        if (!want.has(r.job)) sql.exec(`DELETE FROM schedule WHERE job = ?`, r.job);
      for (const [job, cron] of want) {
        const cur = sql.exec(`SELECT cron FROM schedule WHERE job = ?`, job).toArray()[0];
        if (cur && cur.cron === cron) continue;
        const next = nextRunAfter(cron, now);
        if (cur) {
          sql.exec(
            `UPDATE schedule SET cron = ?, next_at = ?, attempts = 0, retry_at = NULL WHERE job = ?`,
            cron,
            next,
            job
          );
        } else {
          sql.exec(`INSERT INTO schedule (job, cron, next_at) VALUES (?, ?, ?)`, job, cron, next);
        }
      }
    });
    await this.rearm(now);
    return this.rows();
  }

  async status(): Promise<{
    storeId: string | undefined;
    alarmAt: number | null;
    rows: ScheduleRow[];
  }> {
    this.init();
    return {
      storeId: this.storeId(),
      alarmAt: await this.ctx.storage.getAlarm(),
      rows: this.rows(),
    };
  }

  /** The alarm body (also callable directly, with a clock, by tests and operators). */
  async fire(now = Date.now()): Promise<FireResult> {
    this.init();
    const out: FireResult = { started: [], skipped: [], failed: [], parked: [] };
    const storeId = this.storeId();
    if (!storeId) return out;
    const sql = this.ctx.storage.sql;
    const due = this.rows().filter(r => (r.retry_at ?? r.next_at) <= now && r.next_at <= now);
    if (this.isFrozen()) {
      // Write freeze: keep every due occurrence exactly as it is (next_at, fence, attempts) and look again shortly.
      for (const r of due) {
        sql.exec(`UPDATE schedule SET retry_at = ? WHERE job = ?`, now + FREEZE_RETRY_MS, r.job);
        out.parked.push(r.job);
      }
      if (due.length > 0)
        this.log(
          'warn',
          { job: due.map(r => r.job).join(','), storeId },
          '[store-schedule] write freeze: alarm parked'
        );
      return out;
    }
    for (const r of due) {
      if (now - r.next_at > CATCH_UP_MS) {
        this.log(
          'warn',
          { job: r.job, storeId, due: r.next_at },
          '[store-schedule] stale occurrence skipped'
        );
        sql.exec(
          `UPDATE schedule SET next_at = ?, attempts = 0, retry_at = NULL WHERE job = ?`,
          nextRunAfter(r.cron, now),
          r.job
        );
        out.skipped.push(r.job);
        continue;
      }
      const fence = r.fence + 1;
      const event: AlarmEvent = {
        id: `alarm-${r.job}-${storeId}-${r.next_at}`,
        name: 'inngest/scheduled.timer',
        ts: r.next_at,
        data: {
          cron: r.cron,
          alarm: true,
          storeId,
          fence,
          scheduledFor: new Date(r.next_at).toISOString(),
        },
      };
      try {
        await this.dispatch(r.job, event);
        sql.exec(
          `UPDATE schedule SET fence = ?, last_at = ?, next_at = ?, attempts = 0, retry_at = NULL WHERE job = ?`,
          fence,
          now,
          nextRunAfter(r.cron, now),
          r.job
        );
        out.started.push(r.job);
      } catch (err) {
        const attempts = r.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.log(
            'error',
            { err, job: r.job, storeId, due: r.next_at },
            '[store-schedule] occurrence skipped after repeated start failures'
          );
          await this.onGaveUp(r.job, event, err).catch(() => undefined);
          sql.exec(
            `UPDATE schedule SET next_at = ?, attempts = 0, retry_at = NULL WHERE job = ?`,
            nextRunAfter(r.cron, now),
            r.job
          );
        } else {
          this.log(
            'warn',
            { err, job: r.job, storeId, attempts },
            '[store-schedule] start failed, retrying'
          );
          sql.exec(
            `UPDATE schedule SET attempts = ?, retry_at = ? WHERE job = ?`,
            attempts,
            now + retryBackoffMs(attempts),
            r.job
          );
        }
        out.failed.push(r.job);
      }
    }
    return out;
  }

  /** One alarm at the earliest pending time (a retry time wins over its next occurrence). */
  private async rearm(now = Date.now()): Promise<void> {
    const rows = this.rows();
    if (rows.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const at = Math.min(
      ...rows.map(r => (r.retry_at && r.retry_at > now ? r.retry_at : r.next_at))
    );
    await this.ctx.storage.setAlarm(Math.max(at, now + MIN_ALARM_GAP_MS));
  }

  async alarm(): Promise<void> {
    try {
      await this.fire();
    } finally {
      // Re-arm even if firing threw: a bad night must not stop the next one.
      await this.rearm();
    }
  }
}

export interface LogFields {
  job: string;
  storeId: string;
  due?: number;
  attempts?: number;
  err?: unknown;
}

export interface AlarmEvent {
  id: string;
  name: string;
  ts: number;
  data: {
    cron: string;
    alarm: true;
    storeId: string;
    fence: number;
    scheduledFor: string;
  };
}
