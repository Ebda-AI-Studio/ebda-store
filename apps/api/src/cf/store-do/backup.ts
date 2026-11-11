/**
 * StoreDO backup: nightly export of every table to R2 (NDJSON + manifest with row counts and sha256), and the
 * restore used by the drill. Phase 0 (Ruling INFRA-CF-1). Serialization is canonical (rows ORDER BY primary key,
 * one JSON array per line of column values) so the checksum of a restored DO equals the manifest's.
 */
import { exportOrder, storeTables } from './tables';

export interface BackupPart {
  file: string;
  rows: number;
  sha256: string;
}
export interface TableManifest {
  rows: number;
  /** Single-file table: sha256 of `<table>.ndjson`. Multi-part table: sha256 of the part sha256s joined by `\n` (`tableDigest`). */
  sha256: string;
  /**
   * Absent = legacy layout, ONE file `<table>.ndjson` (every backup written before 2026-11-12 and every small table).
   * Present = the table was paged by primary key into `<table>.part-NNNN.ndjson` files, each with its own header line.
   */
  parts?: BackupPart[];
}
export interface BackupManifest {
  version: 1;
  storeId: string;
  takenAt: string;
  tables: Record<string, TableManifest>;
  /** Page size the paged export used (rows per part before the byte cap): a restore re-export must page identically to reproduce the digests. */
  partRows?: number;
  /**
   * The storefront customers' credentials (`_cauth_users`, `_cauth_passkeys`), ENCRYPTED (AES-256-GCM, envelope key from the
   * Worker secret CUSTOMER_AUTH_BACKUP_KEY) in `customer-auth.enc`. Refresh and one-time token rows are never backed up:
   * sessions and links are re-issued. Absent when the store has no customer accounts.
   */
  customerAuth?: { file: string; sha256: string; users: number; passkeys: number };
}

export interface SqlLike {
  exec(
    q: string,
    ...b: unknown[]
  ): { toArray(): Array<Record<string, unknown>>; columnNames?: string[] };
}

/** Paging limits (P2-4, 2026-11-12 audit): a DO has 128 MB of RAM, so no export or restore step may hold more than a page or two. */
export const BACKUP_PART_ROWS = 5_000;
export const BACKUP_PART_BYTES = 4 * 1024 * 1024;
/** At or below this many rows in total a store is exported as one synchronous snapshot (the legacy path); above it, paged. */
export const BACKUP_SNAPSHOT_ROWS = 20_000;
export interface BackupOpts {
  snapshotRows?: number;
  partRows?: number;
}

export const partFile = (t: string, i: number) => `${t}.part-${String(i).padStart(4, '0')}.ndjson`;
/** Every R2 file a table of a manifest lives in (legacy: the one file). */
export const tableFiles = (t: string, tm: TableManifest): string[] =>
  tm.parts ? tm.parts.map(p => p.file) : [`${t}.ndjson`];

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

export interface Page {
  columns: string[];
  lines: string[];
}

/** Primary-key columns in key order, or null for a rowid table (same rule as `exportOrder`). */
function keyColumns(sql: SqlLike, table: string): string[] | null {
  const pk = sql
    .exec(`PRAGMA table_info("${table.replace(/"/g, '""')}")`)
    .toArray()
    .filter(c => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(c => String(c.name));
  return pk.length ? pk : null;
}

/** Keep lines until the byte budget is spent (always at least one, so a single huge row still makes progress). */
export function fitBytes(lines: string[], budget = BACKUP_PART_BYTES): number {
  let n = 0;
  let bytes = 0;
  for (const l of lines) {
    bytes += l.length + 1; // UTF-16 units: a cheap upper-bound-ish proxy, the cap is a memory guard, not a quota
    if (n > 0 && bytes > budget) break;
    n++;
  }
  return n;
}

/**
 * One table as consecutive pages in primary-key order (keyset pagination: `WHERE (pk) > (last pk)`, never OFFSET). Each page is a
 * synchronous read; the consumer awaits R2 between pages. Yields at least one page (an empty table yields its header only) and
 * never a trailing empty page.
 */
export function* pageTable(sql: SqlLike, t: string, partRows = BACKUP_PART_ROWS): Generator<Page> {
  const key = keyColumns(sql, t);
  const q = `"${t.replace(/"/g, '""')}"`;
  const order = key ? key.map(k => `"${k.replace(/"/g, '""')}"`).join(', ') : 'rowid';
  let after: unknown[] | null = null;
  for (let first = true; ; first = false) {
    const where: string = !after
      ? ''
      : key
        ? `WHERE (${key.map(k => `"${k.replace(/"/g, '""')}"`).join(', ')}) > (${key.map(() => '?').join(', ')})`
        : 'WHERE rowid > ?';
    const cur = sql.exec(
      `SELECT ${key ? '*' : 'rowid AS "__rowid", *'} FROM ${q} ${where} ORDER BY ${order} LIMIT ?`,
      ...(after ?? []),
      partRows
    );
    const rows = cur.toArray();
    if (rows.length === 0 && !first) return;
    const columns = (rows.length ? Object.keys(rows[0]) : (cur.columnNames ?? [])).filter(
      c => c !== '__rowid'
    );
    const all = rows.map(r => JSON.stringify(columns.map(c => r[c])));
    const kept = fitBytes(all);
    yield { columns, lines: all.slice(0, kept) };
    if (rows.length < partRows && kept === rows.length) return;
    const last = rows[kept - 1];
    after = key ? key.map(k => last[k]) : [last.__rowid];
  }
}

/** sha256 of a multi-part table: the part digests joined, so no step ever needs the whole table in memory. */
export const tableDigest = (parts: BackupPart[]) => sha256Hex(parts.map(p => p.sha256).join('\n'));

/**
 * Write one table from its pages. A table that fits one page keeps the legacy single `<table>.ndjson` (same bytes and checksum as
 * before this change); a longer one becomes `<table>.part-NNNN.ndjson` files written one by one. At most two pages are in memory.
 */
export async function writeTablePages(
  t: string,
  pages: AsyncIterable<Page> | Iterable<Page>,
  put: (file: string, body: string) => Promise<unknown>
): Promise<TableManifest> {
  const parts: BackupPart[] = [];
  const emit = async (p: Page) => {
    const body = [JSON.stringify(p.columns), ...p.lines].join('\n') + '\n';
    const file = partFile(t, parts.length + 1);
    await put(file, body);
    parts.push({ file, rows: p.lines.length, sha256: await sha256Hex(body) });
  };
  let prev: Page | null = null;
  for await (const page of pages) {
    if (prev) await emit(prev);
    prev = page;
  }
  if (!prev) throw new Error(`backup: ${t} produced no page`);
  if (parts.length === 0) {
    const body = [JSON.stringify(prev.columns), ...prev.lines].join('\n') + '\n';
    await put(`${t}.ndjson`, body);
    return { rows: prev.lines.length, sha256: await sha256Hex(body) };
  }
  await emit(prev);
  return { rows: parts.reduce((a, p) => a + p.rows, 0), sha256: await tableDigest(parts), parts };
}

/** Paged export of every table (the large-store path). The caller must keep the store quiescent for a consistent snapshot. */
export async function exportChunked(
  sql: SqlLike,
  put: (file: string, body: string) => Promise<unknown>,
  partRows = BACKUP_PART_ROWS
): Promise<Record<string, TableManifest>> {
  const tables: Record<string, TableManifest> = {};
  for (const t of storeTables(sql))
    tables[t] = await writeTablePages(t, pageTable(sql, t, partRows), put);
  return tables;
}

export function totalRows(sql: SqlLike): number {
  let n = 0;
  for (const t of storeTables(sql))
    n += Number(sql.exec(`SELECT count(*) AS n FROM "${t}"`).toArray()[0].n);
  return n;
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

/** The backup's own `gold_reprice` value in a `do_flags` NDJSON body (undefined when the backup carried no such row). */
export function goldFlagOf(body: string | undefined): unknown {
  const [fh, ...fl] = (body ?? '').split('\n').filter(Boolean);
  let flag: unknown;
  if (fh) {
    const cols = JSON.parse(fh) as string[];
    for (const l of fl) {
      const r = JSON.parse(l) as unknown[];
      if (r[cols.indexOf('name')] === 'gold_reprice') flag = r[cols.indexOf('value')];
    }
  }
  return flag;
}

/** Gold price guard triggers (store/0002_invariants.sql) ABORT any gold-rate product/variant insert unless do_flags.gold_reprice = 1:
 * raise it for the load and clear it before commit (same as cf-migrate __import). do_flags rows are INSERT OR IGNOREd so the
 * backup's own gold_reprice row cannot collide with, or reset, the raised flag. */
export function beginLoad(sql: SqlLike, tables: string[]): boolean {
  // Tables arrive in any order: foreign keys are checked at COMMIT, not per row (the caller's transaction).
  sql.exec('PRAGMA defer_foreign_keys = ON');
  const gold = tables.includes('products') || tables.includes('product_variants');
  if (gold)
    sql.exec(
      `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1) ON CONFLICT (name) DO UPDATE SET value = 1`
    );
  return gold;
}
/** The flag row's state after the load is the backup's own (a row the backup lacked is deleted again, so the restored do_flags
 * re-export equals the manifest). */
export function endLoad(sql: SqlLike, gold: boolean, backupFlag: unknown): void {
  if (!gold) return;
  if (backupFlag === undefined) sql.exec(`DELETE FROM do_flags WHERE name = 'gold_reprice'`);
  else sql.exec(`UPDATE do_flags SET value = ? WHERE name = 'gold_reprice'`, backupFlag);
}

/** Insert one NDJSON file (header line = column names, then one JSON array per row) into its table. */
export function loadTableBody(sql: SqlLike, t: string, body: string): void {
  const [head, ...lines] = body.split('\n').filter(Boolean);
  const columns = JSON.parse(head) as string[];
  const ph = columns.map(() => '?').join(',');
  for (const line of lines)
    sql.exec(
      `INSERT ${t === 'do_flags' ? 'OR IGNORE ' : ''}INTO "${t}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${ph})`,
      ...(JSON.parse(line) as unknown[])
    );
}

/** Load NDJSON files into EMPTY tables (restore target), inside the caller's transaction. Legacy single-file layout only. */
export function loadBackup(sql: SqlLike, files: Record<string, string>, tables: string[]): void {
  const gold = beginLoad(sql, tables);
  for (const t of tables) {
    const body = files[`${t}.ndjson`];
    if (!body) throw new Error(`backup is missing ${t}.ndjson`);
    loadTableBody(sql, t, body);
  }
  endLoad(sql, gold, goldFlagOf(files['do_flags.ndjson']));
}

/** Every table a restore writes: the backup's tables plus the encrypted customer-credential tables. Single source for the cleanup. */
export const restoreWrittenTables = (
  backupTables: string[],
  hasCustomerAuth: boolean
): string[] => [...new Set([...backupTables, ...(hasCustomerAuth ? CAUTH_BACKUP_TABLES : [])])];

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
    // Legacy: one file whose sha256 is the table's. Paged: every part, then the digest of the part digests.
    const units: BackupPart[] = want.parts ?? [
      { file: `${t}.ndjson`, rows: want.rows, sha256: want.sha256 },
    ];
    for (const u of units) {
      const f = await r2.get(backupKey(storeId, day, u.file));
      if (!f) throw new Error(`backup verify: ${u.file} missing after write`);
      const body = await f.text();
      if ((await sha256Hex(body)) !== u.sha256)
        throw new Error(`backup verify: ${t} checksum differs`);
      if (body.split('\n').filter(Boolean).length - 1 !== u.rows)
        throw new Error(`backup verify: ${t} line count differs from manifest rows`);
    }
    if (want.parts && (await tableDigest(want.parts)) !== want.sha256)
      throw new Error(`backup verify: ${t} part digest differs from manifest`);
  }
  if (manifest.customerAuth) {
    const f = await r2.get(backupKey(storeId, day, manifest.customerAuth.file));
    if (!f) throw new Error('backup verify: customer-auth.enc missing after write');
    if ((await sha256Hex(await f.text())) !== manifest.customerAuth.sha256)
      throw new Error('backup verify: customer-auth.enc checksum differs');
  }
}

// ---- customer credentials (N-9, Ruling NZ-N9-3): encrypted, never plaintext in R2 -----------------------------------------
export const CUSTOMER_AUTH_FILE = 'customer-auth.enc';
const CAUTH_BACKUP_TABLES = ['_cauth_users', '_cauth_passkeys'] as const;

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (t: string) => Uint8Array.from(atob(t), c => c.charCodeAt(0));

async function aesKey(
  secret: string | undefined
): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  const raw = secret ? unb64(secret.trim()) : new Uint8Array(0);
  if (raw.length !== 32)
    throw new Error(
      'CUSTOMER_AUTH_BACKUP_KEY must be 32 bytes, base64 (customer credentials are backed up encrypted only)'
    );
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `iv.ciphertext` (base64), AES-256-GCM with a fresh random IV per file. */
export async function encryptBlob(secret: string | undefined, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(secret),
      new TextEncoder().encode(plaintext)
    )
  );
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decryptBlob(secret: string | undefined, blob: string): Promise<string> {
  const [iv, ct] = blob.trim().split('.');
  if (!iv || !ct) throw new Error('customer-auth backup is malformed');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv) },
    await aesKey(secret),
    unb64(ct)
  );
  return new TextDecoder().decode(pt);
}

/** Synchronous read of the two credential tables (same snapshot discipline as `dumpTables`). */
export function dumpCustomerAuth(
  sql: SqlLike
): Record<string, { columns: string[]; lines: string[] }> {
  const out: Record<string, { columns: string[]; lines: string[] }> = {};
  for (const t of CAUTH_BACKUP_TABLES) {
    const cur = sql.exec(`SELECT * FROM "${t}" ORDER BY "${t === '_cauth_users' ? 'id' : 'id'}"`);
    const rows = cur.toArray();
    const columns = rows.length ? Object.keys(rows[0]) : (cur.columnNames ?? []);
    out[t] = { columns, lines: rows.map(r => JSON.stringify(columns.map(c => r[c]))) };
  }
  return out;
}

/** Encrypted file + its manifest entry, or null when the store has no customer accounts. Throws without a usable key. */
export async function buildCustomerAuthBackup(
  dump: ReturnType<typeof dumpCustomerAuth>,
  secret: string | undefined
): Promise<{ blob: string; entry: NonNullable<BackupManifest['customerAuth']> } | null> {
  const users = dump._cauth_users.lines.length;
  if (users === 0 && dump._cauth_passkeys.lines.length === 0) return null;
  const blob = await encryptBlob(secret, JSON.stringify(dump));
  return {
    blob,
    entry: {
      file: CUSTOMER_AUTH_FILE,
      sha256: await sha256Hex(blob),
      users,
      passkeys: dump._cauth_passkeys.lines.length,
    },
  };
}

/** Decrypt + checksum-verify the file named by the manifest. Throws on a wrong key, a tampered blob or a checksum difference. */
export async function readCustomerAuthBackup(
  blob: string,
  entry: NonNullable<BackupManifest['customerAuth']>,
  secret: string | undefined
): Promise<ReturnType<typeof dumpCustomerAuth>> {
  if ((await sha256Hex(blob)) !== entry.sha256)
    throw new Error('customer-auth backup checksum differs from manifest');
  const dump = JSON.parse(await decryptBlob(secret, blob)) as ReturnType<typeof dumpCustomerAuth>;
  if (
    dump._cauth_users.lines.length !== entry.users ||
    dump._cauth_passkeys.lines.length !== entry.passkeys
  )
    throw new Error('customer-auth backup row counts differ from manifest');
  return dump;
}

/** Insert a decoded dump into EMPTY `_cauth_*` tables (caller's transaction). Refresh / one-time token rows are not restored. */
export function loadCustomerAuth(sql: SqlLike, dump: ReturnType<typeof dumpCustomerAuth>): void {
  for (const t of CAUTH_BACKUP_TABLES) {
    const n = Number(sql.exec(`SELECT count(*) AS n FROM "${t}"`).toArray()[0].n);
    if (n !== 0) throw new Error('restore target must be empty');
    const { columns, lines } = dump[t];
    const ph = columns.map(() => '?').join(',');
    for (const line of lines)
      sql.exec(
        `INSERT INTO "${t}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${ph})`,
        ...(JSON.parse(line) as unknown[])
      );
  }
}
