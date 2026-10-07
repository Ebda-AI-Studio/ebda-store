#!/usr/bin/env node
// Fresh database for the editor live-preview E2E (playwright.editor-live.config.ts): drop and
// recreate EDITOR_E2E_DB on the LOCAL Postgres named by EDITOR_E2E_PG (a superuser URL, any
// database), migrate it, give the strict-RLS role `ebda_app` a login, and seed the Dahab demo store
// through its own seed (scripts/dahab-demo/seed-dahab.mjs) with an owner who can log in.
// Loopback / Apple `container` addresses only: it DROPS the database.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const server = process.env.EDITOR_E2E_PG;
const db = process.env.EDITOR_E2E_DB || 'ebda_editor_e2e';
const appPw = process.env.EDITOR_E2E_APP_PW || 'editor-e2e-app-pw';
const ownerPw = process.env.EDITOR_E2E_OWNER_PW || 'Editor-e2e#2026';
if (!server) throw new Error('EDITOR_E2E_PG (local superuser postgres URL) is required');
const u = new URL(server);
if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname) && !/^192\.168\./.test(u.hostname))
  throw new Error(`refusing non-local postgres host ${u.hostname}`);
if (!/^[a-z0-9_]+$/.test(db)) throw new Error('EDITOR_E2E_DB must be [a-z0-9_]');

const psql = (url, sql) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qAtc', sql], { stdio: 'pipe' });
psql(server, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
psql(server, `CREATE DATABASE ${db}`);
const url = new URL(server);
url.pathname = `/${db}`;
const env = { ...process.env, DATABASE_URL: url.href, DIRECT_URL: url.href };
for (const pkg of ['database', 'shared'])
  if (!existsSync(resolve(root, `packages/${pkg}/dist`)))
    execFileSync('npm', ['run', 'build', '-w', `packages/${pkg}`], { cwd: root, stdio: 'inherit' });
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: resolve(root, 'packages/database'), env, stdio: 'inherit' });
psql(url.href, `ALTER ROLE ebda_app LOGIN PASSWORD '${appPw}'`);
execFileSync('npx', ['tsx', 'scripts/dahab-demo/seed-dahab.mjs'], {
  cwd: root,
  env: { ...env, OWNER_PASSWORD: ownerPw },
  stdio: 'inherit',
});
console.log(`editor e2e database ${db} ready`);
