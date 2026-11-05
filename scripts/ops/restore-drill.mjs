#!/usr/bin/env node
// Restore drill CLI (Ruling NZ-BACKUP-1; runbook docs/DB-BACKUP-RESTORE.md "Real recovery"). READ-ONLY on production: the only thing it
// does to Cloudflare is `wrangler r2 object get`. Everything it writes goes to a local workerd under --workdir.
//
//   node scripts/ops/restore-drill.mjs [--tier daily|weekly|monthly] [--day YYYY-MM-DD]      newest daily, from R2 (needs CLOUDFLARE_*)
//        [--dir <fixture dir>]            read the "bucket" from a local directory instead of R2
//        [--target api|harness]           api (default): boot the real API Worker + local D1, then public/admin API checks
//                                         harness: the cutover harness DO only (no API), D1 loaded in memory (CI fixture drill)
//        [--identity-file f | --keychain ebda-db-backup-age-key]   age private key (Keychain hex output is decoded)
//        [--extract <dir>]                only fetch + decrypt + verify the artifacts into <dir> (real recovery step 1), then exit
//        [--workdir d] [--port 8798] [--report out.txt]
// Exit 0 = DRILL PASS (every check), 1 = FAIL.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { runDrill, formatReport, assertLoopback, apiChecksForStore } from './lib/cf-drill.mjs';
import { assertPlatformTables, digestSqlite } from './lib/cf-backup.mjs';
import {
  ageDecrypt,
  dirR2,
  identityFromKeychain,
  wranglerR2,
  d1Digests,
  normalizeD1Sql,
} from './lib/cf-backup-io.mjs';
import { stripAiBinding, stripImagesBinding } from '../ci/workerd-smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');
const { values: a } = parseArgs({
  options: {
    tier: { type: 'string', default: 'daily' },
    day: { type: 'string' },
    dir: { type: 'string' },
    target: { type: 'string', default: 'api' },
    'identity-file': { type: 'string' },
    keychain: { type: 'string', default: 'ebda-db-backup-age-key' },
    workdir: { type: 'string' },
    port: { type: 'string', default: '8798' },
    report: { type: 'string' },
    extract: { type: 'string' },
  },
});
const work = a.workdir ?? mkdtempSync(path.join(tmpdir(), 'ebda-drill-'));
mkdirSync(work, { recursive: true });
const base = `http://127.0.0.1:${a.port}`;
assertLoopback(base);
const cutoverSecret = `drill-${randomBytes(16).toString('hex')}`;
const jwtSecret = `drill-jwt-${randomBytes(24).toString('hex')}`;

const identity = a['identity-file']
  ? readFileSync(a['identity-file'], 'utf8')
  : identityFromKeychain(a.keychain);
const io = a.dir ? dirR2(a.dir) : wranglerR2({ readOnly: true });

if (a.extract) {
  const { fetchBackupSet } = await import('./lib/cf-backup.mjs');
  const { manifest, files } = await fetchBackupSet({
    io,
    tier: a.tier,
    day: a.day,
    decrypt: ageDecrypt(identity),
  });
  mkdirSync(a.extract, { recursive: true });
  for (const [name, buf] of Object.entries(files))
    writeFileSync(
      path.join(a.extract, `${name}.${manifest.artifacts[name].ext}`),
      name === 'd1-ebda-platform' ? Buffer.from(normalizeD1Sql(buf.toString('utf8'))) : buf,
      {
        mode: 0o600,
      }
    );
  writeFileSync(path.join(a.extract, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(
    `extracted ${Object.keys(files).length} artifact(s) of ${manifest.tier}/${manifest.day} into ${a.extract} (checksums verified)`
  );
  process.exit(0);
}

let child = null;
let bootError = null;
const logTail = () => {
  try {
    return readFileSync(path.join(work, 'wrangler.log'), 'utf8')
      .split('\n')
      .slice(-12)
      .join(' | ')
      .slice(-900);
  } catch {
    return '(no log)';
  }
};
const cleanups = [];
const stop = () => {
  try {
    if (child) process.kill(-child.pid, 'SIGKILL');
  } catch {} // only the group this script started
  for (const f of cleanups)
    try {
      f();
    } catch {}
};
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

async function waitUp(pathname) {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(base + pathname, { signal: AbortSignal.timeout(3000) })).status) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`worker did not come up on ${base}${pathname}`);
}
function boot(args, cwd, pathname) {
  const logf = createWriteStream(path.join(work, 'wrangler.log'));
  child = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--port',
      a.port,
      '--persist-to',
      path.join(work, 'state'),
      ...args,
    ],
    {
      cwd,
      detached: true,
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost' },
    }
  );
  child.stdout.pipe(logf);
  child.stderr.pipe(logf);
  return waitUp(pathname);
}

const post = async (p, body, ctype) => {
  let res;
  try {
    res = await fetch(base + p, {
      method: 'POST',
      headers: { authorization: `Bearer ${cutoverSecret}`, 'content-type': ctype },
      body,
    });
  } catch (e) {
    throw new Error(
      `${p}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''} - the local worker is not answering${bootError ? `; it never came up: ${bootError}` : ' (it was never started or has died)'}`
    );
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${j.error ?? ''}`);
  return j;
};

const targets = { decrypt: ageDecrypt(identity), post };
if (a.target === 'harness') {
  targets.loadD1 = async sql => {
    const tables = assertPlatformTables(await d1Digests(sql));
    return { tables, stores: [] };
  };
  await boot(
    [
      '-c',
      'packages/cf-migrate/harness/.wrangler.smoke.jsonc',
      '--var',
      `CUTOVER_IMPORT_SECRET:${cutoverSecret}`,
    ],
    ROOT,
    '/'
  );
} else {
  const cfg = path.join(API, '.wrangler.drill.jsonc');
  const devVars = path.join(API, '.dev.vars');
  if (existsSync(devVars))
    throw new Error(`${devVars} exists; refusing to overwrite a developer file`);
  writeFileSync(
    cfg,
    stripImagesBinding(stripAiBinding(readFileSync(path.join(API, 'wrangler.jsonc'), 'utf8')))
  );
  writeFileSync(
    devVars,
    [
      'NODE_ENV=development',
      'WEB_URL=http://localhost:3000',
      'ADMIN_URL=http://localhost:3001',
      `API_URL=${base}`,
      'BUILD_COMMIT_SHA=drill',
      `JWT_SECRET=${jwtSecret}`,
      'SUITE_BUYER_KEY_SECRET=drill-only-suite-buyer-key-secret-0123456789',
      `ENCRYPTION_KEY=${'0'.repeat(64)}`,
      'TAP_API_KEY=k',
      'TAP_SECRET_KEY=s',
      'TAP_WEBHOOK_SECRET=drill-only-tap-webhook-secret',
      'SEARCH_SEMANTIC_ENABLED=false',
      `CUTOVER_IMPORT_SECRET=${cutoverSecret}`,
    ].join('\n') + '\n'
  );
  cleanups.push(
    () => rmSync(devVars, { force: true }),
    () => rmSync(cfg, { force: true })
  );
  targets.loadD1 = async sql => {
    const f = path.join(work, 'd1.sql');
    writeFileSync(f, normalizeD1Sql(sql)); // old artifacts (alphabetical, rows interleaved) are made order-safe here too
    const r = spawnSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'PLATFORM_DB',
        '--local',
        '--persist-to',
        path.join(work, 'state'),
        '--config',
        '.wrangler.drill.jsonc',
        '--file',
        f,
      ],
      { cwd: API, encoding: 'utf8' }
    );
    if (r.status !== 0) throw new Error(`local D1 load failed: ${r.stderr || r.stdout}`);
    const dir = path.join(work, 'state/v3/d1/miniflare-D1DatabaseObject');
    const files = readdirSync(dir).filter(n => n.endsWith('.sqlite') && n !== 'metadata.sqlite');
    if (files.length !== 1)
      throw new Error(`expected one local D1 sqlite file, found ${files.length}`);
    const db = new DatabaseSync(path.join(dir, files[0]), { readOnly: true });
    try {
      const tables = await digestSqlite(db);
      const stores = db
        .prepare("SELECT id, slug, domain, owner_id FROM stores WHERE storage_backend = 'do'")
        .all();
      return { tables, stores };
    } finally {
      db.close();
    }
  };
  targets.apiChecks = async (store, productCount) => {
    const http = async (method, p, { headers, body } = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    return apiChecksForStore(http, { store, productCount });
  };
  // D1 must exist before the worker boots against it, and DO import needs the worker: load D1 first via a lazy boot hook.
  // The worker boots whatever the D1 load did: a failed load must not hide every later stage. The load error is rethrown after.
  const loadD1 = targets.loadD1;
  targets.loadD1 = async sql => {
    let loadErr = null;
    let r = null;
    try {
      r = await loadD1(sql);
    } catch (e) {
      loadErr = e;
    }
    try {
      await boot(['--config', '.wrangler.drill.jsonc'], API, '/health');
    } catch (e) {
      bootError = `${e.message}; wrangler log tail: ${logTail()}`;
    }
    if (loadErr) throw loadErr;
    return r;
  };
}

const rep = await runDrill({ io, targets, tier: a.tier, day: a.day });
const text = formatReport(rep);
console.log(text);
if (a.report) writeFileSync(a.report, text + '\n');
stop();
process.exit(rep.pass ? 0 : 1);
