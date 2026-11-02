#!/usr/bin/env node
/**
 * Ruling MIGRATION-DRIFT-1: fail when a migration on disk is missing from production Postgres's `_prisma_migrations`
 * while Postgres still holds stores. EBDA_SKIP_PG_MIGRATE=1 (CUTOVER-NOW-1) makes the deploy skip `prisma migrate
 * deploy`, so every PG-side feature added afterwards silently lacks its tables (2026-11-02: ci_hint_logs, ci_store_gates
 * and the catalog-import tables were missing for 2 days; ci/overview answered 500 DATABASE_ERROR). READ-ONLY: two
 * SELECTs. Usage: PGURL=<connection string> node scripts/ci/pg-migration-drift.mjs [migrationsDir]
 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Migrations present on disk but not (finished) in the database. Pure, unit-tested. */
export function missingMigrations(onDisk, applied) {
  const done = new Set(applied);
  return onDisk.filter(m => !done.has(m)).sort();
}

export function listOnDisk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function psql(url, sql) {
  return execFileSync('psql', [url, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

function main() {
  const url = process.env.PGURL;
  if (!url) {
    console.error('pg-migration-drift: PGURL is not set');
    process.exit(2);
  }
  const dir = process.argv[2] ?? path.join(ROOT, 'packages/database/prisma/migrations');
  const applied = psql(
    url,
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
  )
    .split('\n')
    .filter(Boolean);
  const missing = missingMigrations(listOnDisk(dir), applied);
  const stores = Number(psql(url, 'SELECT count(*) FROM stores'));
  if (missing.length === 0) {
    console.log(
      `pg-migration-drift: ok (${applied.length} applied, ${stores} store rows in Postgres)`
    );
    return;
  }
  const line = `${missing.length} migration(s) on disk are missing from production Postgres: ${missing.join(', ')}`;
  if (stores > 0) {
    console.error(`pg-migration-drift: FAIL ${line}; Postgres still holds ${stores} store row(s).`);
    console.error(
      'Fix: run `prisma migrate deploy` with the owner URL (additive migrations only), or retire those stores.'
    );
    process.exit(1);
  }
  console.log(`pg-migration-drift: ${line}; no stores in Postgres, nothing depends on them.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
