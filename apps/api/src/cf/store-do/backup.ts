/**
 * StoreDO backup: nightly export of every table to R2 (NDJSON + manifest with row counts and sha256), and the
 * restore used by the drill. Phase 0 (Ruling INFRA-CF-1). Serialization is canonical (rows ORDER BY rowid,
 * one JSON array per line of column values) so the checksum of a restored DO equals the manifest's.
 */
import { STORE_TABLES } from './tables';

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
  for (const t of STORE_TABLES) {
    const cur = sql.exec(`SELECT * FROM ${t} ORDER BY rowid`);
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
export function loadBackup(sql: SqlLike, files: Record<string, string>): void {
  // Parents first so foreign keys hold.
  for (const t of STORE_TABLES) {
    const body = files[`${t}.ndjson`];
    if (!body) throw new Error(`backup is missing ${t}.ndjson`);
    const [head, ...lines] = body.split('\n').filter(Boolean);
    const columns = JSON.parse(head) as string[];
    const ph = columns.map(() => '?').join(',');
    for (const line of lines)
      sql.exec(
        `INSERT INTO ${t} (${columns.join(',')}) VALUES (${ph})`,
        ...(JSON.parse(line) as unknown[])
      );
  }
}

export const backupKey = (storeId: string, day: string, file: string) =>
  `store-do-backups/${storeId}/${day}/${file}`;
