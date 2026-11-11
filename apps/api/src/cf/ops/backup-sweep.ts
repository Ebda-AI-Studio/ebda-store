/**
 * Nightly backup sweep (G8, Ruling INFRA-CF-1). Runs from the 03:00 Cron Trigger and does three things:
 *
 *  1. arms the StoreDO nightly alarm for every store (the Phase 0 alarm only existed for a DO the loader
 *     had touched; a store nobody visited was never backed up),
 *  2. checks that yesterday's StoreDO backup landed (a manifest per store in R2): the alarm itself cannot
 *     report that it did not fire,
 *  3. exports every bound D1 database (platform, identity) to R2 as NDJSON + a manifest, asserting row
 *     counts (rule N11: a backup that is not read back is not a backup).
 *
 * The Mac pull (ops/backup-ebda-cloudflare.sh in the ops repo) re-verifies the same manifests off
 * Cloudflare. Pure functions over structural types so it runs on local workerd with miniflare bindings.
 */
import { buildBackup, sha256Hex, type BackupManifest } from '../store-do/backup';

export interface R2PutGet {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  /** Optional (real R2 has it): lets the sweep tell a brand-new store from one whose nightly alarm stopped. */
  list?(opts: { prefix: string; limit?: number }): Promise<{ objects: unknown[] }>;
}
export interface D1Like {
  prepare(sql: string): { all(): Promise<{ results: Array<Record<string, unknown>> }> };
  batch(
    stmts: Array<{ all(): Promise<unknown> }>
  ): Promise<Array<{ results: Array<Record<string, unknown>> }>>;
}
interface StoreStub {
  ensureBackupAlarm(): Promise<number>;
  backupNow(storeId: string): Promise<unknown>;
}
export interface SweepEnv {
  STORE_BACKUPS?: unknown;
  STORE_DO?: {
    idFromName(n: string): unknown;
    get(id: unknown): Record<string, unknown>;
  };
  /** Optional D1 databases; each present binding is exported. Phase 1/2 add the real ones. */
  PLATFORM_DB?: unknown;
  IDENTITY_DB?: unknown;
}
export const D1_BINDINGS = ['PLATFORM_DB', 'IDENTITY_DB'] as const;
/** One table is read in one batch (one consistent read); above this the exporter must page. */
export const D1_MAX_TABLE_ROWS = 100_000;

export const d1BackupKey = (name: string, day: string, file: string) =>
  `d1-backups/${name}/${day}/${file}`;
export const storeBackupManifestKey = (storeId: string, day: string) =>
  `store-do-backups/${storeId}/${day}/manifest.json`;

export async function backupD1(
  name: string,
  db: D1Like,
  r2: R2PutGet,
  now = new Date()
): Promise<BackupManifest> {
  const { results: tableRows } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
    .all();
  const tables = tableRows.map(r => r.name as string);
  const dump: Record<string, { columns: string[]; lines: string[] }> = {};
  for (const t of tables) {
    const q = `"${t.replace(/"/g, '""')}"`;
    // count + rows in ONE batch (one transaction): the assert below compares two reads of the same snapshot.
    const [c, r] = await db.batch([
      db.prepare(`SELECT count(*) AS n FROM ${q}`) as never,
      db.prepare(`SELECT * FROM ${q}`) as never,
    ]);
    const count = c.results[0].n as number;
    if (count > D1_MAX_TABLE_ROWS)
      throw new Error(`D1 ${name}.${t}: ${count} rows exceeds ${D1_MAX_TABLE_ROWS}; add paging`);
    if (r.results.length !== count)
      throw new Error(`D1 ${name}.${t}: read ${r.results.length} rows, count said ${count}`);
    const columns = r.results.length ? Object.keys(r.results[0]) : [];
    dump[t] = { columns, lines: r.results.map(row => JSON.stringify(columns.map(k => row[k]))) };
  }
  const { manifest, files } = await buildBackup(`d1:${name}`, dump, now);
  const { results: ddl } = await db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
    .all();
  const day = manifest.takenAt.slice(0, 10);
  await r2.put(d1BackupKey(name, day, 'schema.sql'), ddl.map(d => `${d.sql};`).join('\n') + '\n');
  for (const [file, body] of Object.entries(files))
    await r2.put(d1BackupKey(name, day, file), body);
  // Manifest last: a day folder without one is incomplete and ignored by the restore and the Mac pull.
  await r2.put(d1BackupKey(name, day, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // Read-back: the stored manifest must parse and list every table with the counts we just computed.
  const back = await r2.get(d1BackupKey(name, day, 'manifest.json'));
  if (!back) throw new Error(`D1 ${name}: manifest not readable after write`);
  const stored = JSON.parse(await back.text()) as BackupManifest;
  for (const t of tables)
    if (stored.tables[t]?.rows !== dump[t].lines.length)
      throw new Error(`D1 ${name}.${t}: stored manifest row count differs`);
  return manifest;
}

export interface SweepReport {
  day: string;
  stores: {
    armed: number;
    missingYesterday: string[];
    errors: string[];
    /** Stores whose missing backup was taken by the bounded in-sweep retry (no P1 for these). */
    recovered: string[];
    /** Stores this tick did not reach (deadline / cap); the next tick starts at `cursor`. Normal above the cap: not an alert by itself. */
    deferred: number;
    /** Nights the current walk over the fleet has been running (1 = it started tonight). */
    walkNights: number;
    /** True only when deferral is abnormal: the walk is older than `maxDeferredNights`, or this tick made no progress. */
    deferredAlert: boolean;
    /** Stores whose backup alarm did not fire (no yesterday manifest) even though the in-sweep retry then recovered them. */
    alarmMissed: string[];
  };
  d1: Record<string, { ok: boolean; tables?: number; rows?: number; error?: string }>;
  ok: boolean;
}

export interface SweepDeps {
  listStoreIds: (env: SweepEnv) => string[] | Promise<string[]>;
  alert: (title: string, body: string) => Promise<unknown>;
  now?: Date;
  /** Wall-clock budget for the per-store loop (default 10 min; the cron invocation limit is 15). */
  budgetMs?: number;
  /** Per-store ceiling on subrequest-heavy work (3-4 each; default 250 keeps one tick under the 1,000 subrequest cap). */
  maxStores?: number;
  /** One hung StoreDO must not eat the whole budget (default 60 s). */
  storeTimeoutMs?: number;
  /** Upper bound of `backupNow` retries per tick (default 25). */
  maxRetries?: number;
  /** A walk over the whole fleet may span this many nights before a still-deferred store pages (default 3). */
  maxDeferredNights?: number;
  clock?: () => number;
}

export const SWEEP_CURSOR_KEY = 'ops-reports/backup-sweep/cursor.json';

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

export async function runBackupSweep(env: SweepEnv, deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budgetMs = deps.budgetMs ?? 10 * 60_000;
  const maxStores = deps.maxStores ?? 250;
  const storeTimeoutMs = deps.storeTimeoutMs ?? 60_000;
  const r2 = env.STORE_BACKUPS as R2PutGet | undefined;
  if (!r2) throw new Error('STORE_BACKUPS binding missing: nothing can be backed up');
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000));
  const report: SweepReport = {
    day: dayOf(now),
    stores: {
      armed: 0,
      missingYesterday: [],
      errors: [],
      recovered: [],
      deferred: 0,
      walkNights: 1,
      deferredAlert: false,
      alarmMissed: [],
    },
    d1: {},
    ok: true,
  };

  // D1 FIRST (P2-5): the account-level export is the part a slow or hung StoreDO must never starve.
  for (const name of D1_BINDINGS) {
    const db = env[name] as D1Like | undefined;
    if (!db) continue;
    try {
      const m = await backupD1(name, db, r2, now);
      const tabs = Object.values(m.tables);
      report.d1[name] = {
        ok: true,
        tables: tabs.length,
        rows: tabs.reduce((a, t) => a + t.rows, 0),
      };
    } catch (e) {
      report.d1[name] = { ok: false, error: (e as Error).message };
    }
  }

  const stubOf = (id: string) => {
    const ns = env.STORE_DO;
    if (!ns) throw new Error('STORE_DO binding missing');
    return ns.get(ns.idFromName(id)) as unknown as StoreStub;
  };

  // Bounded loop: ids in a stable order, resuming after the last tick's cursor, stopping at the deadline or the cap.
  const all = [...(await deps.listStoreIds(env))].sort();
  let start = 0;
  let prev: { day?: string; next?: string | null; nights?: number; visited?: number } = {};
  try {
    const cur = await r2.get(SWEEP_CURSOR_KEY);
    if (cur) prev = JSON.parse(await cur.text()) as typeof prev;
    const next = prev.next ?? null;
    if (next)
      start = Math.max(
        0,
        all.findIndex(id => id >= next)
      );
  } catch {
    // an unreadable cursor restarts from the top: never skips a store
    prev = {};
  }
  const order = [...all.slice(start), ...all.slice(0, start)];
  let done = 0;
  const missing: string[] = [];
  for (const id of order) {
    if (done >= maxStores || clock() - started > budgetMs) break;
    done++;
    try {
      await withTimeout(
        (async () => {
          const stub = stubOf(id);
          await stub.ensureBackupAlarm();
          report.stores.armed++;
          if (!(await r2.get(storeBackupManifestKey(id, yesterday)))) {
            // A store that has NEVER been backed up is new: its first alarm is armed above for +24h, so yesterday's manifest
            // cannot exist (Amelia, created 2026-11-10, false P1 2026-11-11). Take its baseline backup now instead of
            // flagging it; a failure there lands in `errors`. A store WITH history but no yesterday means the alarm failed.
            const hasHistory =
              !r2.list ||
              (await r2.list({ prefix: `store-do-backups/${id}/`, limit: 1 })).objects.length > 0;
            if (hasHistory) missing.push(id);
            else await stub.backupNow(id);
          }
        })(),
        storeTimeoutMs,
        `store ${id}`
      );
    } catch (e) {
      report.stores.errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  report.stores.deferred = order.length - done;
  const nextId = report.stores.deferred > 0 ? order[done] : null;
  // A walk over a fleet bigger than one tick's cap legitimately spans several nights (the next tick resumes at the cursor), so
  // deferral alone never pages. It pages when the walk is older than N nights, or when a tick reached no store at all.
  // The cursor carries the state of ONE walk: nights it has run and stores visited since it began. The walk is complete once it has
  // visited the whole fleet; the counters then reset, so a fleet that always needs 3 nights never pages and a stuck walk does.
  const prevNights = prev.nights ?? 0;
  const nights = prevNights + (prev.day === report.day && prevNights > 0 ? 0 : 1);
  const visited = (prev.visited ?? 0) + done;
  const complete = visited >= all.length;
  report.stores.walkNights = nights;
  report.stores.deferredAlert =
    !complete &&
    report.stores.deferred > 0 &&
    (nights > (deps.maxDeferredNights ?? 3) || done === 0);
  try {
    await r2.put(
      SWEEP_CURSOR_KEY,
      JSON.stringify({
        day: report.day,
        next: nextId,
        nights: complete ? 0 : nights,
        visited: complete ? 0 : visited,
      })
    );
  } catch (e) {
    report.stores.errors.push(`cursor: ${(e as Error).message}`);
  }

  // One bounded retry (P2-5): a store with history but no yesterday manifest gets `backupNow` once, now, instead of waiting a
  // full night for the next alarm. Still failing = stays in `missingYesterday` and in `errors`.
  const maxRetries = deps.maxRetries ?? 25;
  let retried = 0;
  for (const id of missing) {
    if (retried >= maxRetries || clock() - started > budgetMs) {
      report.stores.missingYesterday.push(id);
      continue;
    }
    retried++;
    try {
      await withTimeout(stubOf(id).backupNow(id), storeTimeoutMs, `backupNow ${id}`);
      report.stores.recovered.push(id);
      // The retry fixed tonight's backup, not the alarm that missed yesterday's: record it and page anyway.
      report.stores.alarmMissed.push(id);
    } catch (e) {
      report.stores.missingYesterday.push(id);
      report.stores.errors.push(`${id}: retry backupNow failed: ${(e as Error).message}`);
    }
  }

  report.ok =
    report.stores.errors.length === 0 &&
    report.stores.missingYesterday.length === 0 &&
    !report.stores.deferredAlert &&
    report.stores.alarmMissed.length === 0 &&
    Object.values(report.d1).every(v => v.ok);
  await r2.put(`ops-reports/backup-sweep/${report.day}.json`, JSON.stringify(report, null, 2));
  if (!report.ok)
    await deps.alert(
      'Ebda Store nightly backup sweep FAILED',
      JSON.stringify(
        {
          missingYesterday: report.stores.missingYesterday,
          storeErrors: report.stores.errors,
          deferredStores: report.stores.deferred,
          deferredAlert: report.stores.deferredAlert,
          walkNights: report.stores.walkNights,
          alarmMissedRecoveredByRetry: report.stores.alarmMissed,
          recovered: report.stores.recovered,
          d1: report.d1,
        },
        null,
        2
      )
    );
  return report;
}

export interface D1Writable extends D1Like {
  prepare(
    sql: string
  ): ReturnType<D1Like['prepare']> & { bind(...v: unknown[]): { run(): Promise<unknown> } };
  exec(sql: string): Promise<unknown>;
}

/**
 * Restore drill for a D1 export (G8): load day `day` of `name` from R2 into an EMPTY database, then re-export
 * it with the same canonical serialization and compare every table's row count and sha256 to the manifest.
 * Used by the drill test and by the runbook (docs/DB-BACKUP-RESTORE.md "Cloudflare storage").
 */
export async function restoreD1FromBackup(
  name: string,
  day: string,
  r2: R2PutGet,
  target: D1Writable
): Promise<Record<string, { rows: number; ok: boolean }>> {
  const mObj = await r2.get(d1BackupKey(name, day, 'manifest.json'));
  if (!mObj) throw new Error('no manifest: incomplete or missing backup');
  const manifest = JSON.parse(await mObj.text()) as BackupManifest;
  const schema = await r2.get(d1BackupKey(name, day, 'schema.sql'));
  if (!schema) throw new Error('schema.sql missing');
  const existing = await target
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    )
    .all();
  if ((existing.results[0].n as number) !== 0) throw new Error('restore target must be empty');
  await target.exec((await schema.text()).split('\n').filter(Boolean).join(' '));
  for (const t of Object.keys(manifest.tables)) {
    const f = await r2.get(d1BackupKey(name, day, `${t}.ndjson`));
    if (!f) throw new Error(`missing ${t}.ndjson`);
    const body = await f.text();
    if ((await sha256Hex(body)) !== manifest.tables[t].sha256)
      throw new Error(`${t}: file checksum differs from manifest`);
    const [head, ...lines] = body.split('\n').filter(Boolean);
    const cols = JSON.parse(head) as string[];
    const ins = target.prepare(
      `INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (let i = 0; i < lines.length; i += 50)
      await target.batch(
        lines.slice(i, i + 50).map(l => ins.bind(...(JSON.parse(l) as unknown[]))) as never
      );
  }
  const scratch = new Map<string, string>();
  const again = await backupD1(
    name,
    target,
    {
      put: async (k, v) => void scratch.set(k, v),
      get: async k => (scratch.has(k) ? { text: async () => scratch.get(k)! } : null),
    },
    new Date(manifest.takenAt)
  );
  const out: Record<string, { rows: number; ok: boolean }> = {};
  for (const [t, want] of Object.entries(manifest.tables)) {
    const got = again.tables[t];
    out[t] = { rows: got?.rows ?? -1, ok: got?.rows === want.rows && got?.sha256 === want.sha256 };
  }
  return out;
}
