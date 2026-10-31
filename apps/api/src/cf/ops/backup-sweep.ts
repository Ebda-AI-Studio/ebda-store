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
}
export interface D1Like {
  prepare(sql: string): { all(): Promise<{ results: Array<Record<string, unknown>> }> };
  batch(
    stmts: Array<{ all(): Promise<unknown> }>
  ): Promise<Array<{ results: Array<Record<string, unknown>> }>>;
}
interface StoreStub {
  ensureBackupAlarm(): Promise<number>;
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
  stores: { armed: number; missingYesterday: string[]; errors: string[] };
  d1: Record<string, { ok: boolean; tables?: number; rows?: number; error?: string }>;
  ok: boolean;
}

export interface SweepDeps {
  listStoreIds: (env: SweepEnv) => string[] | Promise<string[]>;
  alert: (title: string, body: string) => Promise<unknown>;
  now?: Date;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export async function runBackupSweep(env: SweepEnv, deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now ?? new Date();
  const r2 = env.STORE_BACKUPS as R2PutGet | undefined;
  if (!r2) throw new Error('STORE_BACKUPS binding missing: nothing can be backed up');
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000));
  const report: SweepReport = {
    day: dayOf(now),
    stores: { armed: 0, missingYesterday: [], errors: [] },
    d1: {},
    ok: true,
  };

  for (const id of await deps.listStoreIds(env)) {
    try {
      const ns = env.STORE_DO;
      if (!ns) throw new Error('STORE_DO binding missing');
      const stub = ns.get(ns.idFromName(id)) as unknown as StoreStub;
      await stub.ensureBackupAlarm();
      report.stores.armed++;
      if (!(await r2.get(storeBackupManifestKey(id, yesterday))))
        report.stores.missingYesterday.push(id);
    } catch (e) {
      report.stores.errors.push(`${id}: ${(e as Error).message}`);
    }
  }

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

  report.ok =
    report.stores.errors.length === 0 &&
    report.stores.missingYesterday.length === 0 &&
    Object.values(report.d1).every(v => v.ok);
  await r2.put(`ops-reports/backup-sweep/${report.day}.json`, JSON.stringify(report, null, 2));
  if (!report.ok)
    await deps.alert(
      'Ebda Store nightly backup sweep FAILED',
      JSON.stringify(
        {
          missingYesterday: report.stores.missingYesterday,
          storeErrors: report.stores.errors,
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
