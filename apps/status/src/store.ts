import { DurableObject } from 'cloudflare:workers';
import { COMPONENTS, HISTORY_DAYS, SLOW_STREAK_FAILS } from './config';
import { probeErrorAr } from './probe';
import type {
  ComponentSnapshot,
  ComponentStatus,
  DayBucket,
  Impact,
  Incident,
  IncidentStatus,
  IncidentUpdate,
  ProbeResult,
  RecordOutcome,
  Snapshot,
  Thresholds,
} from './types';

const DAY_MS = 86_400_000;
const RECENT_DAYS = 14;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

interface StateRow extends Record<string, SqlStorageValue> {
  id: string;
  status: string;
  consec_fail: number;
  consec_ok: number;
  last_checked: number | null;
  last_latency: number | null;
  last_error: string | null;
  last_slow: number;
  consec_slow: number;
}

/**
 * Single global instance holding everything the status page shows. It is a SQLite-backed
 * Durable Object on purpose: access is serialised, so "N consecutive failures" and "open one
 * incident" can never race between overlapping cron runs, and there is no external database
 * to provision. History is kept as DAILY ROLLUPS (checks / ok per component per UTC day) for
 * 90 days, so storage stays tiny however often probes run.
 */
export class StatusStore extends DurableObject<Cloudflare.Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS component_state (
          id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'up',
          consec_fail INTEGER NOT NULL DEFAULT 0, consec_ok INTEGER NOT NULL DEFAULT 0,
          last_checked INTEGER, last_latency INTEGER, last_error TEXT);
        CREATE TABLE IF NOT EXISTS daily (
          day TEXT NOT NULL, component TEXT NOT NULL,
          checks INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, component));
        CREATE TABLE IF NOT EXISTS incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT, title TEXT NOT NULL,
          title_ar TEXT, impact TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
          opened_at INTEGER NOT NULL, resolved_at INTEGER);
        CREATE TABLE IF NOT EXISTS incident_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, at INTEGER NOT NULL,
          status TEXT NOT NULL, body TEXT NOT NULL, body_ar TEXT);
      `);
      // slow-state columns (added after launch): idempotent for an existing database
      for (const col of ['last_slow', 'consec_slow']) {
        try {
          this.sql.exec(`ALTER TABLE component_state ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
        } catch {
          /* column already exists */
        }
      }
    });
  }

  /** Apply one round of probe results. `now` is injected so tests control time. */
  record(results: ProbeResult[], now: number, t: Thresholds): RecordOutcome {
    const outcome: RecordOutcome = { opened: [], resolved: [] };
    const day = utcDay(now);
    for (const raw of results) {
      let r = raw;
      this.sql.exec(`INSERT OR IGNORE INTO component_state (id) VALUES (?)`, r.id);
      const prev = this.sql
        .exec<StateRow>(`SELECT * FROM component_state WHERE id = ?`, r.id)
        .one();
      // Slow (8 s < t <= 15 s) is degraded, not down; only a streak of slow probes counts as a failure.
      const slowStreak = r.ok && r.slow ? prev.consec_slow + 1 : 0;
      if (r.ok && slowStreak >= SLOW_STREAK_FAILS) {
        r = { ...r, ok: false, error: `slow ${slowStreak} probes in a row (${r.latencyMs}ms)` };
      }
      this.sql.exec(
        `INSERT INTO daily (day, component, checks, ok) VALUES (?, ?, 1, ?)
         ON CONFLICT(day, component) DO UPDATE SET checks = checks + 1, ok = ok + excluded.ok`,
        day,
        r.id,
        r.ok ? 1 : 0
      );
      const s = prev;

      let { status, consec_fail: fail, consec_ok: ok } = s;
      if (r.ok) {
        ok += 1;
        fail = 0;
      } else {
        fail += 1;
        ok = 0;
        // two slow probes in a row ARE the down verdict (no further failing round needed)
        if (slowStreak >= SLOW_STREAK_FAILS) fail = Math.max(fail, t.fail);
      }

      if (status === 'up' && fail >= t.fail) {
        status = 'down';
        const existing = this.sql
          .exec<{
            id: number;
          }>(
            `SELECT id FROM incidents WHERE component = ? AND source = 'auto' AND status != 'resolved'`,
            r.id
          )
          .toArray();
        if (!existing.length) {
          const name = COMPONENTS.find(c => c.id === r.id)?.name;
          const id = this.insertIncident({
            component: r.id,
            title: `${name?.en ?? r.id} is not responding`,
            titleAr: `مفيش رد من ${name?.ar ?? r.id}`,
            impact: 'outage',
            source: 'auto',
            status: 'investigating',
            body: `${fail} consecutive probes failed (${r.error ?? 'unknown error'}).`,
            bodyAr: `${fail} فحوصات ورا بعض فشلوا (${probeErrorAr(r.error)}).`,
            now,
          });
          outcome.opened.push(id);
        }
      } else if (status === 'down' && ok >= t.recover) {
        status = 'up';
        const open = this.sql
          .exec<{
            id: number;
          }>(
            `SELECT id FROM incidents WHERE component = ? AND source = 'auto' AND status != 'resolved'`,
            r.id
          )
          .toArray();
        for (const inc of open) {
          this.addUpdate(
            inc.id,
            'resolved',
            `Recovered: ${ok} consecutive probes succeeded.`,
            `رجع اشتغل: ${ok} فحوصات ورا بعض نجحوا.`,
            now
          );
          outcome.resolved.push(inc.id);
        }
      }

      this.sql.exec(
        `UPDATE component_state SET status = ?, consec_fail = ?, consec_ok = ?, last_checked = ?,
           last_latency = ?, last_error = ?, last_slow = ?, consec_slow = ? WHERE id = ?`,
        status,
        fail,
        ok,
        now,
        r.latencyMs,
        r.error,
        r.ok && r.slow ? 1 : 0,
        slowStreak,
        r.id
      );
    }
    // Retention: keep HISTORY_DAYS of rollups.
    this.sql.exec(`DELETE FROM daily WHERE day < ?`, utcDay(now - HISTORY_DAYS * DAY_MS));
    return outcome;
  }

  createManualIncident(input: {
    component: string | null;
    title: string;
    titleAr: string | null;
    impact: Impact;
    body: string;
    bodyAr: string | null;
    now: number;
  }): number {
    return this.insertIncident({ ...input, source: 'manual', status: 'investigating' });
  }

  /** Returns false when the incident does not exist. */
  addManualUpdate(
    id: number,
    status: IncidentStatus,
    body: string,
    bodyAr: string | null,
    now: number
  ): boolean {
    const exists = this.sql.exec(`SELECT 1 FROM incidents WHERE id = ?`, id).toArray().length > 0;
    if (!exists) return false;
    this.addUpdate(id, status, body, bodyAr, now);
    return true;
  }

  snapshot(now: number): Snapshot {
    const since = utcDay(now - (HISTORY_DAYS - 1) * DAY_MS);
    const daily = this.sql
      .exec<{
        day: string;
        component: string;
        checks: number;
        ok: number;
      }>(`SELECT day, component, checks, ok FROM daily WHERE day >= ?`, since)
      .toArray();
    const states = new Map(
      this.sql
        .exec<StateRow>(`SELECT * FROM component_state`)
        .toArray()
        .map(s => [s.id, s])
    );
    const incidents = this.loadIncidents(now);
    const active = incidents.filter(i => i.status !== 'resolved');
    const recent = incidents.filter(i => i.status === 'resolved');

    const dayKeys: string[] = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) dayKeys.push(utcDay(now - i * DAY_MS));

    const components: ComponentSnapshot[] = COMPONENTS.map(c => {
      const rows = new Map(daily.filter(d => d.component === c.id).map(d => [d.day, d]));
      const days: DayBucket[] = dayKeys.map(day => ({
        day,
        checks: rows.get(day)?.checks ?? 0,
        ok: rows.get(day)?.ok ?? 0,
      }));
      const checks = days.reduce((n, d) => n + d.checks, 0);
      const okSum = days.reduce((n, d) => n + d.ok, 0);
      const s = states.get(c.id);
      let status: ComponentStatus = s?.last_checked == null ? 'unknown' : 'operational';
      if (s?.status === 'down') status = 'outage';
      else if (s?.last_slow) status = 'degraded';
      for (const i of active) {
        if (i.component !== c.id || i.source === 'auto') continue;
        status = worst(status, i.impact === 'outage' ? 'outage' : 'degraded');
      }
      return {
        id: c.id,
        status,
        lastChecked: s?.last_checked ?? null,
        latencyMs: s?.last_latency ?? null,
        slow: !!s?.last_slow && s?.status !== 'down',
        lastError: s?.status === 'down' ? (s.last_error ?? null) : null,
        uptime: checks ? Math.round((okSum / checks) * 10000) / 100 : null,
        days,
      };
    });

    let overall: ComponentStatus = 'unknown';
    for (const c of components) overall = worst(overall, c.status);
    // A platform-wide manual incident (no component) also moves the headline.
    for (const i of active) {
      if (i.component === null)
        overall = worst(overall, i.impact === 'outage' ? 'outage' : 'degraded');
    }
    return { generatedAt: now, overall, components, active, recent };
  }

  // ---- internals -------------------------------------------------------------------------

  private insertIncident(i: {
    component: string | null;
    title: string;
    titleAr: string | null;
    impact: Impact;
    source: 'auto' | 'manual';
    status: IncidentStatus;
    body: string;
    bodyAr: string | null;
    now: number;
  }): number {
    const id = this.sql
      .exec<{ id: number }>(
        `INSERT INTO incidents (component, title, title_ar, impact, status, source, opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        i.component,
        i.title,
        i.titleAr,
        i.impact,
        i.status,
        i.source,
        i.now
      )
      .one().id;
    this.sql.exec(
      `INSERT INTO incident_updates (incident_id, at, status, body, body_ar) VALUES (?, ?, ?, ?, ?)`,
      id,
      i.now,
      i.status,
      i.body,
      i.bodyAr
    );
    return id;
  }

  private addUpdate(
    id: number,
    status: IncidentStatus,
    body: string,
    bodyAr: string | null,
    now: number
  ): void {
    this.sql.exec(
      `INSERT INTO incident_updates (incident_id, at, status, body, body_ar) VALUES (?, ?, ?, ?, ?)`,
      id,
      now,
      status,
      body,
      bodyAr
    );
    this.sql.exec(
      `UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?`,
      status,
      status === 'resolved' ? now : null,
      id
    );
  }

  private loadIncidents(now: number): Incident[] {
    const cutoff = now - RECENT_DAYS * DAY_MS;
    const rows = this.sql
      .exec<{
        id: number;
        component: string | null;
        title: string;
        title_ar: string | null;
        impact: string;
        status: string;
        source: string;
        opened_at: number;
        resolved_at: number | null;
      }>(
        `SELECT * FROM incidents WHERE status != 'resolved' OR resolved_at >= ? ORDER BY opened_at DESC LIMIT 50`,
        cutoff
      )
      .toArray();
    return rows.map(r => ({
      id: r.id,
      component: r.component,
      title: r.title,
      titleAr: r.title_ar,
      impact: r.impact as Impact,
      status: r.status as IncidentStatus,
      source: r.source as 'auto' | 'manual',
      openedAt: r.opened_at,
      resolvedAt: r.resolved_at,
      updates: this.sql
        .exec<{ at: number; status: string; body: string; body_ar: string | null }>(
          `SELECT at, status, body, body_ar FROM incident_updates WHERE incident_id = ? ORDER BY id DESC LIMIT 10`,
          r.id
        )
        .toArray()
        .map(
          (u): IncidentUpdate => ({
            at: u.at,
            status: u.status as IncidentStatus,
            body: u.body,
            bodyAr: u.body_ar,
          })
        ),
    }));
  }
}

const RANK: Record<ComponentStatus, number> = {
  unknown: 0,
  operational: 1,
  degraded: 2,
  outage: 3,
};
const worst = (a: ComponentStatus, b: ComponentStatus): ComponentStatus =>
  RANK[b] > RANK[a] ? b : a;
