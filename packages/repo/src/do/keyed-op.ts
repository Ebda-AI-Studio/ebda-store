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

export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${s.length}:${h.toString(16)}`;
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
  const fp = fingerprint(`${op}:${JSON.stringify(args)}`);
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
