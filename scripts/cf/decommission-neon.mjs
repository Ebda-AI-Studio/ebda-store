#!/usr/bin/env node
// Phase 7: decommission Neon after 7 clean days on Cloudflare (docs/runbooks/neon-decommission.md).
//
//   node scripts/cf/decommission-neon.mjs preflight  --flipped-at <ISO> --api https://api.ebda.app --attest-sentry-clean
//   node scripts/cf/decommission-neon.mjs final-dump --r2-account <id> --lifecycle-checked     (read-only on Neon)
//   node scripts/cf/decommission-neon.mjs restore-drill --manifest <file> --scratch-pg-url <url>   (mandatory)
//   node scripts/cf/decommission-neon.mjs residue [--strict]                         (code cleanup gate)
//   node scripts/cf/decommission-neon.mjs remove-bindings --manifest <file> --yes   (Hyperdrive + DATABASE_URL secrets)
//   node scripts/cf/decommission-neon.mjs delete-neon --manifest <file> --ahmad-yes "<message ref>"
//
// Order is enforced by the script, not by memory: remove-bindings needs a verified final-dump manifest, and
// delete-neon needs the manifest, the bindings gone, a clean `residue --strict`, and Ahmad's explicit yes
// typed back as the project id. Nothing here runs on its own; every destructive command prints first.
// Neon is only ever READ (pg_dump) until delete-neon, which is the one irreversible step.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { residueFilesOf } from './residue-exempt.mjs';

export const NEON_PROJECT = 'lucky-truth-54548746';
// one backup scheme: the ops agent's nightly db-backup.yml (age to EBDA_BACKUP_AGE_PUBLIC_KEY, bucket ebda-db-backups,
// custom-format dump verified by scripts/ops/verify-db-dump.sh). The final dump uses the same format under final/ so it
// is NOT swept by the 35-day expiry of db/.
export const R2_BUCKET = 'ebda-db-backups';
export const R2_PREFIX = 'final/';
export const AGE_KEY_KEYCHAIN = 'ebda-db-backup-age-key';
const VERIFY_DUMP = 'scripts/ops/verify-db-dump.sh';
const HOME = os.homedir();
const DUMP_DIR = path.join(HOME, 'Desktop/projects/_backups/ebda/decommission');
const WORKER = 'ebda-api';
/** secrets/vars that exist only because of Postgres; removed from the Worker and from GitHub */
export const WORKER_SECRETS = ['DATABASE_URL', 'DIRECT_URL', 'OWNER_DATABASE_URL'];
export const GH_SECRETS = ['EBDA_MIGRATE_DATABASE_URL'];
export const GH_VARS = ['EBDA_HYPERDRIVE_ID'];
/** a path that still names Postgres after the cleanup is a bug; migration tooling and archives are exempt */
export const RESIDUE_PATTERN =
  '@prisma/client|@prisma/adapter-pg|\\$queryRaw|\\$executeRaw|pg_advisory|[Hh][Yy][Pp][Ee][Rr][Dd][Rr][Ii][Vv][Ee]|HYPERDRIVE|DATABASE_URL|DIRECT_URL|NEON_';
export const RESIDUE_EXEMPT = [
  'docs/',
  'scripts/cf/',
  'packages/cf-migrate/',
  'packages/cf-schema/',
  'graphify-out/',
  'scripts/backup-db.sh',
  // NZ-17 Ruling NZ-17-EX-1: the applied Postgres migration history is an archive (kept for the restore drill and
  // to rebuild the Prisma schema's history); nothing executes it in production.
  'packages/database/prisma/migrations/',
];

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    api: { type: 'string', default: 'https://api.ebda.app' },
    'flipped-at': { type: 'string' },
    'attest-sentry-clean': { type: 'boolean', default: false },
    'r2-account': { type: 'string' },
    'scratch-pg-url': { type: 'string' },
    'lifecycle-checked': { type: 'boolean', default: false },
    manifest: { type: 'string' },
    yes: { type: 'boolean', default: false },
    'ahmad-yes': { type: 'string' },
    strict: { type: 'boolean', default: false },
    'min-days': { type: 'string', default: '7' },
  },
});

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const fail = m => {
  throw new Error(m);
};
const say = m => console.log(m);

// ---------------------------------------------------------------- preflight
async function preflight() {
  const problems = [];
  if (!v['flipped-at'])
    fail('--flipped-at <ISO time of the flip to the Cloudflare side> is required');
  const days = (Date.now() - Date.parse(v['flipped-at'])) / 86_400_000;
  say(`days since the flip: ${days.toFixed(1)} (need >= ${v['min-days']})`);
  if (!(days >= Number(v['min-days'])))
    problems.push(`only ${days.toFixed(1)} days since the flip`);

  const h = await fetch(`${v.api}/health`)
    .then(r => r.json())
    .catch(() => null);
  if (!h) problems.push('/health did not answer');
  else {
    // Counts are super_admin only (public /health would disclose the store count): GET /api/v1/health with OPS_HEALTH_TOKEN.
    const deep = await fetch(`${v.api}/api/v1/health`, {
      headers: { authorization: `Bearer ${process.env.OPS_HEALTH_TOKEN ?? ''}` },
    })
      .then(r => r.json())
      .catch(() => null);
    const sb = deep?.data?.storage_backend ?? {};
    if (!deep?.data?.storage_backend)
      problems.push('storage_backend unreadable: set OPS_HEALTH_TOKEN to a super_admin token');
    say(
      `/health storage_backend: ${JSON.stringify(sb)}, commit ${h.commit ?? h.data?.commit ?? '?'}`
    );
    const keys = Object.keys(sb);
    if (keys.length !== 1 || keys[0] !== 'do')
      problems.push(`storage_backend is not 100% "do": ${JSON.stringify(sb)}`);
    const main = (() => {
      try {
        return run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
      } catch {
        return '';
      }
    })();
    const deployed = String(h.commit ?? h.data?.commit ?? '');
    if (main && deployed && !main.startsWith(deployed) && !deployed.startsWith(main.slice(0, 7)))
      problems.push(
        `/health commit ${deployed} is not the tip of main ${main.slice(0, 7)} (a deploy may be missing)`
      );
  }
  if (!v['attest-sentry-clean'])
    problems.push(
      'Sentry clean for the period is not attested (--attest-sentry-clean after checking the dashboard)'
    );

  // the Worker must already be free of Postgres bindings, or removing them breaks the API
  const wr = fs.readFileSync('apps/api/wrangler.jsonc', 'utf8');
  if (/"hyperdrive"\s*:/.test(wr))
    problems.push(
      'apps/api/wrangler.jsonc still has a hyperdrive binding: merge the code cleanup first (residue --strict)'
    );

  say(problems.length ? `PREFLIGHT FAILED:\n - ${problems.join('\n - ')}` : 'PREFLIGHT OK');
  process.exit(problems.length ? 1 : 0);
}

// ---------------------------------------------------------------- residue
function residue() {
  const r = spawnSync(
    'git',
    [
      'grep',
      '-n',
      '-E',
      RESIDUE_PATTERN,
      '--',
      'apps',
      'packages',
      'scripts',
      '.github',
      'tests',
      'package.json',
      'docker-compose.yml',
      'Dockerfile.api',
      '.env.example',
    ],
    { encoding: 'utf8' }
  );
  const files = residueFilesOf(
    (r.stdout ?? '').split('\n').filter(Boolean),
    f => RESIDUE_EXEMPT.some(e => f.startsWith(e)) || f.endsWith('.md')
  );
  const byDir = {};
  for (const f of files)
    byDir[f.split('/').slice(0, 2).join('/')] =
      (byDir[f.split('/').slice(0, 2).join('/')] ?? 0) + 1;
  say(`${files.length} file(s) still name Postgres/Neon/Hyperdrive outside the exempt paths`);
  for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1]))
    say(`  ${String(n).padStart(4)}  ${d}`);
  if (v.strict && files.length) {
    files.slice(0, 40).forEach(f => say(`    ${f}`));
    process.exit(1);
  }
  return files.length;
}

// ---------------------------------------------------------------- final dump
function pgUrl() {
  if (process.env.DECOMMISSION_PG_URL) return process.env.DECOMMISSION_PG_URL;
  return run('neonctl', [
    'connection-string',
    '--project-id',
    NEON_PROJECT,
    '--role-name',
    'neondb_owner',
  ]);
}

function agePublicKey() {
  if (process.env.EBDA_BACKUP_AGE_PUBLIC_KEY) return process.env.EBDA_BACKUP_AGE_PUBLIC_KEY.trim();
  return run('gh', [
    'variable',
    'get',
    'EBDA_BACKUP_AGE_PUBLIC_KEY',
    '--repo',
    'Ebda-AI-Studio/ebda-store',
  ]);
}

/** COPY rows of one table inside a custom-format dump */
function dumpRows(dump, table) {
  const out = run('pg_restore', ['--data-only', '--table', table, '--file', '-', dump], {
    maxBuffer: 1 << 30,
  });
  const m = out.match(/^COPY [^\n]*FROM stdin;\n([\s\S]*?)^\\\.$/m);
  return m ? m[1].split('\n').filter(Boolean).length : 0;
}

const COUNT_TABLES = ['stores', 'orders', 'users', 'products', 'customers'];

function finalDump() {
  if (!v['r2-account'])
    fail('--r2-account <Cloudflare account id that owns the ebda-db-backups bucket>');
  const url = pgUrl();
  if (/-pooler\./.test(url)) fail('refusing a pooler URL: use the DIRECT endpoint');
  if (!fs.existsSync(VERIFY_DUMP))
    fail(
      `${VERIFY_DUMP} is missing: merge the ops backup work (fix/deploy-pipeline-gates) first, there is one backup scheme`
    );
  const ver = run('pg_dump', ['--version']);
  if (!/ (1[7-9]|[2-9]\d)\./.test(ver)) fail(`pg_dump >= 17 required (have: ${ver})`);
  const pub = agePublicKey();
  if (!/^age1[0-9a-z]{50,}$/.test(pub)) fail('EBDA_BACKUP_AGE_PUBLIC_KEY is not an age public key');

  // the bucket's lifecycle rules decide whether final/ survives: show them, make a human have read them
  say(`R2 lifecycle rules of ${R2_BUCKET} (final/ must NOT be covered by the 35-day expiry):`);
  const lc = spawnSync('npx', ['wrangler', 'r2', 'bucket', 'lifecycle', 'list', R2_BUCKET], {
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: v['r2-account'] },
  });
  say((lc.stdout || lc.stderr || '').trim());
  if (!v['lifecycle-checked'])
    fail(
      `read the lifecycle rules above, make sure no rule expires ${R2_PREFIX}, then pass --lifecycle-checked`
    );

  fs.mkdirSync(DUMP_DIR, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dump = path.join(DUMP_DIR, `ebda-neon-final-${ts}.dump`);
  say('1/6 pg_dump --format=custom (read-only on Neon, same flags as db-backup.yml)');
  const r = spawnSync(
    '/usr/bin/env',
    [
      'pg_dump',
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--dbname=${url}`,
      `--file=${dump}`,
    ],
    {
      env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on' },
      encoding: 'utf8',
    }
  );
  if (r.status !== 0) fail(`pg_dump failed: ${(r.stderr ?? '').slice(0, 400)}`);
  fs.chmodSync(dump, 0o600);

  say('2/6 verify with the ops script (refuses an empty or truncated dump)');
  run('bash', [VERIFY_DUMP, dump]);

  say('3/6 row counts: dump vs live Neon (SELECT count only)');
  const counts = {};
  for (const t of COUNT_TABLES) {
    const live = Number(run('psql', [url, '-Atc', `SELECT count(*) FROM ${t}`]));
    const inDump = dumpRows(dump, t);
    counts[t] = { live, inDump };
    if (live !== inDump)
      fail(
        `row count mismatch for ${t}: live ${live}, dump ${inDump} (a write happened during the dump?)`
      );
  }

  say(
    '4/6 encrypt with age to the shared backup public key (the private key stays in the Keychain)'
  );
  const enc = `${dump}.age`;
  run('age', ['-r', pub, '-o', enc, dump]);
  const key = `${R2_PREFIX}${path.basename(enc)}`;

  say(`5/6 upload to R2 ${R2_BUCKET}/${key}, read it back, compare`);
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: v['r2-account'] };
  run(
    'npx',
    ['wrangler', 'r2', 'object', 'put', `${R2_BUCKET}/${key}`, '--file', enc, '--remote'],
    { env }
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ebda-decom-'));
  const back = path.join(tmp, 'back.age');
  try {
    run(
      'npx',
      ['wrangler', 'r2', 'object', 'get', `${R2_BUCKET}/${key}`, '--file', back, '--remote'],
      { env }
    );
    if (sha256File(back) !== sha256File(enc))
      fail('the object in R2 differs from the local encrypted file');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  say('6/6 manifest');
  const manifest = {
    project: NEON_PROJECT,
    at: new Date().toISOString(),
    bucket: R2_BUCKET,
    key,
    format: 'pg_dump custom, age-encrypted',
    sha256Enc: sha256File(enc),
    bytesEnc: fs.statSync(enc).size,
    localDump: dump,
    counts,
    verified: true,
    drillOk: false,
  };
  const mf = `${dump}.manifest.json`;
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  say(`FINAL DUMP STORED AND READ BACK. manifest: ${mf}`);
  say(
    'NEXT (mandatory): restore-drill. A dump that has not been restored is not a backup. Keep the local plaintext dump until the drill passes, then delete it.'
  );
}

// Decrypt with the Keychain key (this Mac, Ahmad's session), restore into a SCRATCH database, compare counts.
function restoreDrill() {
  const m = readManifest(0);
  const scratch = v['scratch-pg-url'];
  if (!scratch) fail('--scratch-pg-url <url of an empty scratch database> is required');
  const dbName = new URL(scratch).pathname.slice(1);
  if (!/scratch|drill|rehearsal/.test(dbName) || /neon\.tech/.test(scratch))
    fail(
      `refusing to restore into "${dbName}": the database name must contain scratch, drill or rehearsal, and never be Neon`
    );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ebda-drill-'));
  try {
    const encPath = path.join(tmp, 'x.dump.age');
    run(
      'npx',
      ['wrangler', 'r2', 'object', 'get', `${m.bucket}/${m.key}`, '--file', encPath, '--remote'],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: v['r2-account'] ?? process.env.CLOUDFLARE_ACCOUNT_ID,
        },
      }
    );
    if (sha256File(encPath) !== m.sha256Enc)
      fail('the object in R2 no longer matches the manifest sha256');
    const keyFile = path.join(tmp, 'k');
    fs.writeFileSync(
      keyFile,
      run('security', ['find-generic-password', '-s', AGE_KEY_KEYCHAIN, '-w']) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    const dec = path.join(tmp, 'x.dump');
    run('age', ['-d', '-i', keyFile, '-o', dec, encPath]);
    fs.rmSync(keyFile, { force: true });
    run('bash', [VERIFY_DUMP, dec]);
    run('pg_restore', [
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      `--dbname=${scratch}`,
      dec,
    ]);
    for (const t of COUNT_TABLES) {
      const got = Number(run('psql', [scratch, '-Atc', `SELECT count(*) FROM ${t}`]));
      if (got !== m.counts[t].live)
        fail(`restore drill: ${t} has ${got} rows, the manifest says ${m.counts[t].live}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  m.drillOk = true;
  m.drillAt = new Date().toISOString();
  fs.writeFileSync(v.manifest, JSON.stringify(m, null, 2), { mode: 0o600 });
  say(
    `RESTORE DRILL PASSED: decrypted from R2, restored into ${dbName}, ${COUNT_TABLES.length} table counts equal. Drop the scratch database now.`
  );
}

function readManifest(maxAgeHours, { needDrill = false } = {}) {
  if (!v.manifest) fail('--manifest <file written by final-dump> is required');
  const m = JSON.parse(fs.readFileSync(v.manifest, 'utf8'));
  if (!m.verified || m.project !== NEON_PROJECT)
    fail('the manifest is not a verified final dump of the Ebda Neon project');
  if (needDrill && !m.drillOk)
    fail(
      'the restore drill has not passed for this manifest: run restore-drill first (a dump that was never restored is not a backup)'
    );
  if (maxAgeHours && Date.now() - Date.parse(m.at) > maxAgeHours * 3_600_000)
    fail(`the final dump is older than ${maxAgeHours} h: take a fresh one`);
  return m;
}

// ---------------------------------------------------------------- remove bindings
function removeBindings() {
  readManifest(24 * 7, { needDrill: true });
  if (residue() !== 0)
    fail(
      'code cleanup is not finished: `residue --strict` must be clean before the bindings go (the Worker would break)'
    );
  const steps = [
    ['npx', ['wrangler', 'hyperdrive', 'list']],
    ...WORKER_SECRETS.map(s => ['npx', ['wrangler', 'secret', 'delete', s, '--name', WORKER]]),
    ...GH_SECRETS.map(s => ['gh', ['secret', 'delete', s, '--repo', 'Ebda-AI-Studio/ebda-store']]),
    ...GH_VARS.map(s => ['gh', ['variable', 'delete', s, '--repo', 'Ebda-AI-Studio/ebda-store']]),
  ];
  const hdId = process.env.EBDA_HYPERDRIVE_ID;
  if (hdId) steps.push(['npx', ['wrangler', 'hyperdrive', 'delete', hdId]]);
  else
    say(
      'note: set EBDA_HYPERDRIVE_ID (from `wrangler hyperdrive list`) to include deleting the Hyperdrive config itself'
    );
  steps.forEach(([c, a]) => say(`${v.yes ? 'RUN ' : 'PLAN'} ${c} ${a.join(' ')}`));
  if (!v.yes) return say('plan only: pass --yes to execute');
  for (const [c, a] of steps) {
    const r = spawnSync(c, a, { encoding: 'utf8' });
    say(`  -> exit ${r.status}${r.status ? ` ${String(r.stderr).slice(0, 200)}` : ''}`);
    if (r.status && !/not found|does not exist|Secret.*not.*exist/i.test(`${r.stderr}${r.stdout}`))
      fail(`${c} ${a.join(' ')} failed`);
  }
  say(
    'Now run the API checks of the runbook (step 5): /health green, one guest-cart smoke, Sentry quiet for 1 h.'
  );
}

// ---------------------------------------------------------------- delete neon
async function deleteNeon() {
  readManifest(24 * 30, { needDrill: true });
  if (!v['ahmad-yes'])
    fail(
      '--ahmad-yes "<where Ahmad said yes: register line or message reference>" is required. Deleting the Neon project is irreversible and only Ahmad can approve it.'
    );
  if (residue() !== 0) fail('code cleanup is not finished');
  const health = await fetch(`${v.api}/health`)
    .then(r => r.json())
    .catch(() => null);
  if (!health) fail('/health did not answer: do not delete Neon while the API is unhealthy');
  if (!process.stdin.isTTY)
    fail('typing the project id back needs a terminal (no unattended deletes)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(
    `Type the project id to DELETE Neon project ${NEON_PROJECT} (approval: ${v['ahmad-yes']}): `
  );
  rl.close();
  if (typed.trim() !== NEON_PROJECT) fail('the id did not match: nothing deleted');
  say(run('neonctl', ['projects', 'delete', NEON_PROJECT]));
  const left = run('neonctl', ['projects', 'list']);
  if (left.includes(NEON_PROJECT)) fail('the project is still listed');
  say(
    'Neon project deleted and no longer listed. Now: /health, one guest-cart smoke, then update DEPLOYMENT, INCIDENT, CLAUDE.md, DB-BACKUP-RESTORE (runbook step 8).'
  );
}

const cmds = {
  preflight,
  'final-dump': finalDump,
  'restore-drill': restoreDrill,
  residue,
  'remove-bindings': removeBindings,
  'delete-neon': deleteNeon,
};
const cmd = positionals[0];
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (!cmds[cmd]) fail(`usage: decommission-neon.mjs ${Object.keys(cmds).join('|')}`);
    await cmds[cmd]();
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  }
}
