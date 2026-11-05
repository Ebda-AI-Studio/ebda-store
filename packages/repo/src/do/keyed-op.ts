import { MoneyError, type SyncSql } from './sync-sql';

/**
 * The idempotency-marker discipline shared by the named StoreDO operations (stock-ops since D2a, money-ops since D2b):
 * the first run stores its result under the key INSIDE the same `transactionSync` section, a replay returns it without
 * touching a row, the same key for other arguments is `IDEMPOTENCY_KEY_REUSED` 409, a refused or failed operation stores
 * nothing (it rolled back), keys live 24 h and are pruned on the next keyed write.
 */
export const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const KEY_TTL_MS = 24 * 60 * 60 * 1000;

export function ensureKeyedSchema(db: SyncSql, table: string): void {
  if (!/^_[a-z_]+$/.test(table)) throw new Error('bad marker table');
  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, op TEXT NOT NULL, fp TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)`,
    []
  );
}

/** JSON with object keys sorted, so the same arguments built in another key order fingerprint the same (Opus M1). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Two independent 32-bit FNV-1a lanes (64 bits) over the canonical string, plus its length. */
export function fingerprint(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return `${s.length}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** Run `body` as one section, honouring `key`. THROWS `MoneyError` for a refusal; everything `body` wrote rolls back with it. */
export function runKeyed(
  db: SyncSql,
  table: string,
  op: string,
  args: unknown,
  key: string | undefined,
  now: () => number,
  body: () => unknown
): unknown {
  if (!/^_[a-z_]+$/.test(table)) throw new Error('bad marker table');
  if (key !== undefined && !KEY_RE.test(key))
    throw new MoneyError('BAD_IDEMPOTENCY_KEY', 'key', 400);
  const fp = fingerprint(`${op}:${canonicalJson(args)}`);
  return db.transactionSync(() => {
    if (key) {
      const prior = db.all(`SELECT op, fp, result, at FROM ${table} WHERE k = ?`, [key])[0];
      if (prior && (prior.at as number) > now() - KEY_TTL_MS) {
        if (prior.fp !== fp)
          throw new MoneyError('IDEMPOTENCY_KEY_REUSED', 'key used for another operation', 409);
        return JSON.parse(prior.result as string);
      }
      if (prior) db.run(`DELETE FROM ${table} WHERE k = ?`, [key]);
    }
    const out = body();
    if (key) {
      db.run(`DELETE FROM ${table} WHERE at < ?`, [now() - KEY_TTL_MS]);
      db.run(`INSERT INTO ${table} (k, op, fp, result, at) VALUES (?, ?, ?, ?, ?)`, [
        key,
        op,
        fp,
        JSON.stringify(out),
        now(),
      ]);
    }
    return out;
  });
}
