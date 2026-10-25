// One-shot copy of the admin-namespace identities (users.store_id IS NULL) from the Store's Postgres into D1 ebda-identity.
// Ruling ID-3 (merchants, staff, super admins; customers stay in the Store). User ids are kept, so every foreign key in the
// Store (stores.owner_id, store_staff.user_id, audit logs) stays valid.
//
//   PG_URL=<read-only url> node scripts/migrate-from-pg.mjs --out /tmp/identity.sql            # export + print counts
//   PG_URL=... node scripts/migrate-from-pg.mjs --apply [--remote] [--db ebda-identity]        # export, import, verify
//
// Postgres access is READ-ONLY (a SELECT inside a session forced to default_transaction_read_only=on). Verification reads the
// rows back out of D1 and compares per-table row counts and a sha256 over the canonical rows with the Postgres side; any
// difference exits non-zero. Re-running is safe: INSERT OR REPLACE of identical rows. It REFUSES to continue when a migrated
// user has MFA enabled (their secret is encrypted with the Store's ENCRYPTION_KEY, which the identity service does not have).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const arg = n => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1
    ? process.argv[i + 1]?.startsWith('--')
      ? true
      : (process.argv[i + 1] ?? true)
    : undefined;
};
const apply = process.argv.includes('--apply');
const remote = process.argv.includes('--remote');
const db = arg('db') || 'ebda-identity';
const out = arg('out');
if (!process.env.PG_URL) throw new Error('PG_URL env var required (read-only)');

const ts = c => `to_char(${c} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const TABLES = {
  users: {
    order: 'id',
    pg: `select id, email, password_hash, first_name, last_name, phone, role::text as role, status::text as status,
      case when email_verified then 1 else 0 end as email_verified, avatar, language, ${ts('last_login_at')} as last_login_at,
      ${ts('created_at')} as created_at, ${ts('updated_at')} as updated_at, ${ts('deleted_at')} as deleted_at,
      case when mfa_enabled then 1 else 0 end as mfa_enabled, mfa_secret, to_json(mfa_backup_codes)::text as mfa_backup_codes,
      ${ts('mfa_enrolled_at')} as mfa_enrolled_at, token_version, null::int as mfa_last_step
      from users where store_id is null`,
  },
  refresh_tokens: {
    order: 'id',
    pg: `select id, token, user_id, null::text as sid, ${ts('expires_at')} as expires_at, ${ts('created_at')} as created_at,
      replaced_by_id, ${ts('revoked_at')} as revoked_at, revoked_reason
      from refresh_tokens where user_id in (select id from users where store_id is null)`,
  },
  verification_tokens: {
    order: 'id',
    pg: `select id, token, user_id, type::text as type, ${ts('expires_at')} as expires_at, ${ts('used_at')} as used_at,
      ${ts('created_at')} as created_at, 0 as attempts
      from verification_tokens where user_id in (select id from users where store_id is null)`,
  },
  passkey_credentials: {
    order: 'id',
    pg: `select id, user_id, credential_id, public_key, counter::bigint as counter, to_json(transports)::text as transports,
      device_type, case when backed_up then 1 else 0 end as backed_up, rp_id, name, ${ts('created_at')} as created_at,
      ${ts('last_used_at')} as last_used_at
      from passkey_credentials where user_id in (select id from users where store_id is null)`,
  },
};

function psql(sql) {
  const r = spawnSync(
    'psql',
    [process.env.PG_URL, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    {
      env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }
  );
  if (r.status !== 0)
    throw new Error(
      `psql failed: ${r.stderr.replace(process.env.PG_URL, '<PG_URL>').slice(0, 300)}`
    );
  return r.stdout.trim();
}

const rowsOf = name => {
  const t = TABLES[name];
  const txt = psql(
    `select coalesce(json_agg(t order by t.${t.order}), '[]'::json) from (${t.pg}) t`
  );
  return JSON.parse(txt);
};
const canonical = rows =>
  JSON.stringify(
    rows.map(r =>
      Object.keys(r)
        .sort()
        .map(k => [k, r[k] === undefined ? null : r[k]])
    )
  );
const digest = rows => createHash('sha256').update(canonical(rows)).digest('hex');
const lit = v =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;

const data = Object.fromEntries(Object.keys(TABLES).map(n => [n, rowsOf(n)]));
const mfa = data.users.filter(u => u.mfa_enabled === 1 || u.mfa_secret);
if (mfa.length)
  throw new Error(
    `${mfa.length} user(s) have MFA: their secrets cannot be moved (Store ENCRYPTION_KEY). Re-enrol first.`
  );

const sql = [];
for (const [name, rows] of Object.entries(data)) {
  for (const r of rows) {
    const cols = Object.keys(r);
    sql.push(
      `INSERT OR REPLACE INTO ${name} (${cols.join(',')}) VALUES (${cols.map(c => lit(r[c])).join(',')});`
    );
  }
}
const summary = Object.fromEntries(
  Object.entries(data).map(([n, r]) => [n, { rows: r.length, sha256: digest(r).slice(0, 16) }])
);
console.log('postgres:', JSON.stringify(summary));
if (out) writeFileSync(out, sql.join('\n') + '\n', { mode: 0o600 });
if (!apply) process.exit(0);

const wr = (args, input) => {
  const r = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input,
  });
  if (r.status !== 0)
    throw new Error(`wrangler ${args[0]} failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return r.stdout;
};
const file = out || `/tmp/identity-migrate-${process.pid}.sql`;
if (!out) writeFileSync(file, sql.join('\n') + '\n', { mode: 0o600 });
const where = remote ? ['--remote'] : ['--local'];
if (sql.length) wr(['d1', 'execute', db, ...where, '--yes', '--file', file]);

// verify by reading D1 back
let bad = 0;
for (const [name, rows] of Object.entries(data)) {
  const cols = rows[0] ? Object.keys(rows[0]) : Object.keys(TABLES[name].pg ? {} : {});
  const j = JSON.parse(
    wr([
      'd1',
      'execute',
      db,
      ...where,
      '--json',
      '--command',
      `select * from ${name} order by ${TABLES[name].order}`,
    ])
  );
  const back = (j[0]?.results ?? []).map(r =>
    Object.fromEntries(Object.keys(rows[0] ?? r).map(k => [k, r[k] ?? null]))
  );
  const ok = back.length === rows.length && digest(back) === digest(rows);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} postgres=${rows.length} d1=${back.length}`
  );
  if (!ok) bad++;
  void cols;
}
process.exit(bad ? 1 : 0);
