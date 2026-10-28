// Read-only Postgres access for the migration. Three independent locks: the session default
// (options -c default_transaction_read_only=on), BEGIN READ ONLY, and a post-connect assertion. A
// migration tool must be physically unable to write to the source.
import pg from 'pg';

export async function connectReadOnly(url, { allowProd = false } = {}) {
  if (!url) throw new Error('set CUTOVER_PG_URL (or --pg-url)');
  const host = new URL(url).hostname;
  if (/neon\.tech$/.test(host) && !allowProd)
    throw new Error(
      `${host} is a production Neon host: pass --allow-prod-read to confirm this run only READS it`
    );
  const client = new pg.Client({
    connectionString: url,
    options: '-c default_transaction_read_only=on -c statement_timeout=120000',
    application_name: 'ebda-cf-migrate',
  });
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const ro = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  if (ro !== 'on') throw new Error('refusing to continue: the source session is not read-only');
  return client;
}

/** Map<table, Set<column>> of the public schema */
export async function pgColumns(client) {
  const r = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const m = new Map();
  for (const { table_name, column_name } of r.rows) {
    if (!m.has(table_name)) m.set(table_name, new Set());
    m.get(table_name).add(column_name);
  }
  return m;
}

/** Stream a query through a server-side cursor in pages of `size` rows (one snapshot, id-ordered). */
export async function* cursorPages(client, sqlText, params, size = 1000) {
  const name = `c_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sqlText}`, params);
  try {
    for (;;) {
      const r = await client.query(`FETCH ${size} FROM ${name}`);
      if (r.rows.length === 0) return;
      yield r.rows;
      if (r.rows.length < size) return;
    }
  } finally {
    await client.query(`CLOSE ${name}`);
  }
}

export async function resolveStore(client, ref) {
  const r = await client.query(`SELECT id, slug FROM stores WHERE id = $1 OR slug = $1`, [ref]);
  if (r.rows.length !== 1)
    throw new Error(`store "${ref}" resolved to ${r.rows.length} rows (must be exactly 1)`);
  return r.rows[0];
}

/**
 * WRITABLE connection, used ONLY by the rollback replay (flip-backend --to pg). Everything runs in ONE
 * transaction that the caller commits only after the replay is verified. A Neon host needs
 * --allow-prod-write, so a replay can never touch production by accident.
 */
export async function connectWritable(url, { allowProd = false } = {}) {
  if (!url) throw new Error('set CUTOVER_REPLAY_PG_URL (or --replay-pg-url)');
  const host = new URL(url).hostname;
  if (/neon\.tech$/.test(host) && !allowProd)
    throw new Error(
      `${host} is a production Neon host: pass --allow-prod-write to confirm the rollback replay may WRITE to it`
    );
  const client = new pg.Client({
    connectionString: url,
    options: '-c statement_timeout=120000',
    application_name: 'ebda-cf-rollback-replay',
  });
  await client.connect();
  await client.query('BEGIN');
  return client;
}
