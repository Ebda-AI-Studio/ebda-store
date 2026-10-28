#!/usr/bin/env node
// Read-only old-skin gate (Ruling SKIN-DEL-8). Runs scripts/skins/preflight.sql against the DSN
// passed as argv[2] (or PREFLIGHT_DATABASE_URL) with the OWNER-role client: `stores` is under strict
// RLS, so the app role would see zero rows and the gate would pass on invisible data. The owner
// client refuses an RLS-bound connection on its first query; this script turns that into exit 2.
//
//   exit 0  no old-skin store outside the excluded list
//   exit 1  at least one old-skin store (or the gate could not be evaluated)
//   exit 2  connected as a role that cannot see every store (ebda_app)
//
//   node --import tsx scripts/skins/preflight.mjs "$OWNER_DSN"
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The statements of preflight.sql, comments stripped, split on the terminating semicolons. */
export function loadStatements(sqlText = readFileSync(path.join(here, 'preflight.sql'), 'utf8')) {
  return sqlText
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** True for a DSN whose user is the RLS-bound app role: the gate would read zero rows. */
export function isAppRoleDsn(dsn) {
  try {
    return decodeURIComponent(new URL(dsn).username) === 'ebda_app';
  } catch {
    return false;
  }
}

export function isLoopbackDsn(dsn) {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(dsn).hostname);
  } catch {
    return false;
  }
}

async function main() {
  const dsn = process.argv[2] ?? process.env.PREFLIGHT_DATABASE_URL;
  if (!dsn) {
    console.error('usage: preflight.mjs <owner DSN>   (or set PREFLIGHT_DATABASE_URL)');
    process.exit(1);
  }
  if (isAppRoleDsn(dsn)) {
    console.error(
      'preflight: refusing the ebda_app role. `stores` is under strict RLS; this gate must run as the owner role or it reads zero rows and passes on invisible data.'
    );
    process.exit(2);
  }
  const { createPrismaClient } = await import('@ebda/database');
  const db = createPrismaClient({ connectionString: dsn, role: 'owner' });
  let oldSkinStores = null;
  try {
    for (const sql of loadStatements()) {
      let rows;
      try {
        rows = await db.$queryRawUnsafe(sql);
      } catch (err) {
        if (String(err?.message ?? err).includes('does not bypass RLS')) {
          console.error(`preflight: ${err.message}`);
          process.exit(2);
        }
        throw err;
      }
      const printable = rows.map(r =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
        )
      );
      if (printable[0] && 'old_skin_stores' in printable[0])
        oldSkinStores = printable[0].old_skin_stores;
      console.table(printable);
    }
  } finally {
    await db.$disconnect();
  }
  if (isLoopbackDsn(dsn)) {
    console.warn(
      'gate NOT evidence of production until run with the owner DSN of the production database'
    );
  }
  if (oldSkinStores === null) {
    console.error('preflight: the old-skin count was not produced; the gate is NOT evaluated');
    process.exit(1);
  }
  if (oldSkinStores > 0) {
    console.error(`preflight: ${oldSkinStores} old-skin store(s) outside the excluded list`);
    process.exit(1);
  }
  console.log('preflight: old_skin_stores = 0 (excluded list printed above, never migrated)');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
