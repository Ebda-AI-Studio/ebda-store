#!/usr/bin/env node
// Identity stage 5 (contract phase) soak gate. Usage:
//   STORE_DATABASE_URL_READONLY=... node scripts/ops/identity-soak-gate.mjs --since 2026-10-27T00:00:00Z [--min-days 7] [--dry]
// Reads (never writes): the Store Postgres through psql (URL from the environment, never printed), the identity D1 through wrangler
// (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from the environment), and the admin and orders sources. Writes
// docs/soak/identity-stage5-report.json and exits 1 unless all four criteria pass. tests/unit/stage5-approval.test.ts then
// requires that report to be fresh AND docs/soak/identity-stage5-approval.json (Ahmad's go), so the stage-5 PR cannot merge before both.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { evaluateSoak, scanLegacySignIn } from './identity-soak-lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const root = new URL('../..', import.meta.url).pathname;
const since = opt('since', new Date(Date.now() - 7 * 86400_000).toISOString());
const minDays = Number(opt('min-days', '7'));
const windowDays = Math.floor((Date.now() - Date.parse(since)) / 86400_000);

const ADMIN_NS = `u.store_id IS NULL AND u.role::text <> 'customer'`;
function pg(sql) {
  const url = process.env.STORE_DATABASE_URL_READONLY;
  if (!url) return undefined;
  try {
    const out = execFileSync('psql', [url, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
      encoding: 'utf8',
    });
    return Number(out.trim());
  } catch {
    return undefined; // unmeasurable is a failure, and the error text (which could echo the URL) is not printed
  }
}
function d1(sql) {
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', 'ebda-identity', '--remote', '--json', '--command', sql],
      {
        cwd: join(root, 'apps/accounts'),
        encoding: 'utf8',
      }
    );
    return JSON.parse(out)[0]?.results ?? [];
  } catch {
    return undefined;
  }
}
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next' || e === '__tests__' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e) && !/\.(test|spec)\./.test(e)) out.push(p);
  }
  return out;
}

const hs256AdminLogins = pg(
  `SELECT count(*) FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE ${ADMIN_NS} AND rt.created_at >= '${since}'`
);
const liveLegacyRefresh = pg(
  `SELECT count(*) FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE ${ADMIN_NS} AND rt.revoked_at IS NULL AND rt.expires_at > now()`
);
const rows = d1(
  `SELECT u.email AS email, u.mfa_enabled AS mfa, (SELECT count(*) FROM passkey_credentials p WHERE p.user_id = u.id) AS passkeys FROM users u WHERE u.role = 'super_admin' AND u.status = 'active' AND u.deleted_at IS NULL`
);
const superAdmins = rows?.map(r => ({
  email: r.email,
  mfaEnabled: !!r.mfa,
  passkeys: Number(r.passkeys),
}));
const files = ['apps/admin/src', 'apps/orders/src'].flatMap(d =>
  walk(join(root, d)).map(p => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }))
);
const legacySignInRefs = scanLegacySignIn(files);

const result = evaluateSoak({
  windowDays,
  minWindowDays: minDays,
  hs256AdminLogins,
  superAdmins,
  legacySignInRefs,
  liveLegacyRefresh,
});
let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* not a git checkout */
}
const report = {
  generatedAt: new Date().toISOString(),
  since,
  windowDays,
  minWindowDays: minDays,
  commit,
  pass: result.pass,
  // super-admin emails are not written to the repo: only counts
  criteria: result.criteria,
};
for (const c of report.criteria)
  console.log(
    `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail.replace(/[\w.+-]+@[\w.-]+/g, '<email>')}`
  );
if (!args.includes('--dry'))
  writeFileSync(
    join(root, 'docs/soak/identity-stage5-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
console.log(result.pass ? 'SOAK GATE: PASS' : 'SOAK GATE: REFUSED');
process.exit(result.pass ? 0 : 1);
