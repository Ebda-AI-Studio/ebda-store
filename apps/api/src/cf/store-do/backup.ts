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
  // Gold price guard triggers (store/0002_invariants.sql) ABORT any gold-rate product/variant insert unless do_flags.gold_reprice = 1:
  // raise it for the load and clear it before commit (same as cf-migrate __import). do_flags rows are INSERT OR IGNOREd so the
  // backup's own gold_reprice row cannot collide with, or reset, the raised flag.
  const gold = tables.includes('products') || tables.includes('product_variants');
  if (gold)
    sql.exec(
      `INSERT INTO do_flags (name, value) VALUES ('gold_reprice', 1) ON CONFLICT (name) DO UPDATE SET value = 1`
    );
  for (const t of tables) {
    const body = files[`${t}.ndjson`];
    if (!body) throw new Error(`backup is missing ${t}.ndjson`);
    const [head, ...lines] = body.split('\n').filter(Boolean);
    const columns = JSON.parse(head) as string[];
    const ph = columns.map(() => '?').join(',');
    for (const line of lines)
      sql.exec(
        `INSERT ${t === 'do_flags' ? 'OR IGNORE ' : ''}INTO "${t}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${ph})`,
        ...(JSON.parse(line) as unknown[])
      );
  }
  if (gold) sql.exec(`UPDATE do_flags SET value = 0 WHERE name = 'gold_reprice'`);
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
