/**
 * StoreDO backup: nightly export of every table to R2 (NDJSON + manifest with row counts and sha256), and the
 * restore used by the drill. Phase 0 (Ruling INFRA-CF-1). Serialization is canonical (rows ORDER BY primary key,
 * one JSON array per line of column values) so the checksum of a restored DO equals the manifest's.
 */
import { exportOrder, storeTables } from './tables';

export interface TableManifest {
  rows: number;
  sha256: string;
}
export interface BackupManifest {
  version: 1;
  storeId: string;
  takenAt: string;
  tables: Record<string, TableManifest>;
}

export interface SqlLike {
  exec(
    q: string,
    ...b: unknown[]
  ): { toArray(): Array<Record<string, unknown>>; columnNames?: string[] };
}

export const sha256Hex = async (text: string): Promise<string> => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
};

/** Synchronous: the whole export is read with no await, so it is one consistent snapshot of the DO. */
export function dumpTables(sql: SqlLike): Record<string, { columns: string[]; lines: string[] }> {
  const out: Record<string, { columns: string[]; lines: string[] }> = {};
  for (const t of storeTables(sql)) {
    const cur = sql.exec(`SELECT * FROM "${t}" ORDER BY ${exportOrder(sql, t)}`);
    const rows = cur.toArray();
    const columns = rows.length ? Object.keys(rows[0]) : (cur.columnNames ?? []);
    out[t] = { columns, lines: rows.map(r => JSON.stringify(columns.map(c => r[c]))) };
  }
  return out;
}

export async function buildBackup(
  storeId: string,
  dump: ReturnType<typeof dumpTables>,
  now = new Date()
): Promise<{ manifest: BackupManifest; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  const tables: Record<string, TableManifest> = {};
  for (const [t, d] of Object.entries(dump)) {
    // First line = the column names, so a restore never depends on the current table definition order.
    const body = [JSON.stringify(d.columns), ...d.lines].join('\n') + '\n';
    files[`${t}.ndjson`] = body;
    tables[t] = { rows: d.lines.length, sha256: await sha256Hex(body) };
  }
  return {
    manifest: { version: 1, storeId, takenAt: now.toISOString(), tables },
    files,
  };
}

/** Load NDJSON files into EMPTY tables (restore target), inside the caller's transaction. */
export function loadBackup(sql: SqlLike, files: Record<string, string>, tables: string[]): void {
  // Tables arrive in any order: foreign keys are checked at COMMIT, not per row (the caller's transaction).
  sql.exec('PRAGMA defer_foreign_keys = ON');
  for (const t of tables) {
    const body = files[`${t}.ndjson`];
    if (!body) throw new Error(`backup is missing ${t}.ndjson`);
    const [head, ...lines] = body.split('\n').filter(Boolean);
    const columns = JSON.parse(head) as string[];
    const ph = columns.map(() => '?').join(',');
    for (const line of lines)
      sql.exec(
        `INSERT INTO "${t}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${ph})`,
        ...(JSON.parse(line) as unknown[])
      );
  }
}

export const backupKey = (storeId: string, day: string, file: string) =>
  `store-do-backups/${storeId}/${day}/${file}`;

/**
 * Read every object of a just-written backup back from R2 and compare to the manifest: the manifest exists,
 * and each table file's sha256 and line count (minus the header) equal what was computed before the write.
 * Throws on the first mismatch so the alarm's failure path (and the sweep's missing-manifest alert) fire.
 */
export async function verifyWritten(
  r2: { get(key: string): Promise<{ text(): Promise<string> } | null> },
  storeId: string,
  day: string,
  manifest: BackupManifest
): Promise<void> {
  const m = await r2.get(backupKey(storeId, day, 'manifest.json'));
  if (!m) throw new Error('backup verify: manifest not readable after write');
  const stored = JSON.parse(await m.text()) as BackupManifest;
  for (const [t, want] of Object.entries(manifest.tables)) {
    if (stored.tables[t]?.rows !== want.rows)
      throw new Error(`backup verify: ${t} manifest rows differ`);
    const f = await r2.get(backupKey(storeId, day, `${t}.ndjson`));
    if (!f) throw new Error(`backup verify: ${t}.ndjson missing after write`);
    const body = await f.text();
    if ((await sha256Hex(body)) !== want.sha256)
      throw new Error(`backup verify: ${t} checksum differs`);
    if (body.split('\n').filter(Boolean).length - 1 !== want.rows)
      throw new Error(`backup verify: ${t} line count differs from manifest rows`);
  }
}
