#!/usr/bin/env node
/**
 * Workerd boot smoke (Ruling DEPLOY-SAFETY-1). Node unit/integration tests cannot see a Worker
 * that dies at boot or on every request in workerd (2026-10-08: `Prisma.dmmf` threw -> Cloudflare
 * 1101 on every request, all Node tests green). This boots the Worker the way `wrangler deploy`
 * would build it (same config, same esbuild alias block) in a local workerd, against a REAL
 * migrated Postgres, and fails on any boot error or 5xx.
 *
 *   SMOKE_OWNER_DATABASE_URL  owner role, schema already migrated from scratch (seeds two stores)
 *   SMOKE_APP_DATABASE_URL    the non-bypass `ebda_app` login the Worker connects as
 *   node scripts/ci/workerd-smoke.mjs [--config .wrangler.deploy.jsonc] [--port 8799]
 *
 * Needs `wrangler` from the repo and `npx prisma` (to run the seed). Fake secrets only.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');

/**
 * The config the smoke boots: the given one minus its Workers AI line. An `AI` binding always runs
 * REMOTELY (also under `wrangler dev --local`), which needs a Cloudflare login CI does not have and
 * would bill the account; the Worker boots without it (no provider -> lexical search). Throws when
 * the line is missing, so a reshaped block cannot silently reach the smoke. Exported for the test.
 */
export function stripAiBinding(source) {
  const re = /^[ \t]*"ai":[ \t]*\{[ \t]*"binding":[ \t]*"AI"[ \t]*\},?[ \t]*\r?\n/m;
  if (!re.test(source)) throw new Error('wrangler config has no "ai" binding line to strip');
  return source.replace(re, '');
}

/**
 * The deploy config may carry the Cloudflare Images binding (EBDA_IMAGES_BINDING=true,
 * Ruling D1016-ICONS-1). Local workerd has no real Images service, and the boot check does not
 * need it (the icon route falls back without it), so the smoke strips it like the AI binding.
 * Absent = unchanged (no throw: the binding is optional).
 */
export function stripImagesBinding(source) {
  return source.replace(
    /^[ \t]*"images":[ \t]*\{[ \t]*"binding":[ \t]*"IMAGES"[ \t]*\},?[ \t]*\r?\n/gm,
    ''
  );
}

/** Pure verdict on a set of observed responses; exported for the unit test. */
export function smokeProblems(observed) {
  const problems = [];
  for (const o of observed) {
    if (o.status >= 500 || o.status === 0)
      problems.push(
        `${o.path} answered ${o.status || 'no response'} (5xx/no response is never acceptable)`
      );
    else if (o.status !== o.want) problems.push(`${o.path} answered ${o.status}, want ${o.want}`);
    else if (o.check && !o.check(o.body))
      problems.push(`${o.path} body shape wrong: ${String(o.body).slice(0, 200)}`);
  }
  return problems;
}

export const CHECKS = [
  { path: '/health', want: 200, check: b => safe(b)?.status === 'ok' },
  // Tenant-scoped public read through RLS (ebda_app role): a seeded store resolves ...
  { path: '/api/v1/public/stores/alpha', want: 200, check: b => /Alpha Store/.test(b) },
  // ... and an unknown one is a clean 404, not a 500 and not "first store".
  { path: '/api/v1/public/stores/smoke-no-such-store', want: 404 },
  { path: '/api/v1/definitely-not-a-route', want: 404 },
];

function safe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function get(base, p) {
  try {
    const res = await fetch(base + p, {
      headers: { 'cf-connecting-ip': '10.0.0.7' },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: '' };
  }
}

async function main() {
  const arg = n => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const owner = process.env.SMOKE_OWNER_DATABASE_URL;
  const app = process.env.SMOKE_APP_DATABASE_URL;
  if (!owner || !app)
    throw new Error('SMOKE_OWNER_DATABASE_URL and SMOKE_APP_DATABASE_URL are required');
  const config = arg('config') ?? 'wrangler.jsonc';
  // Before anything is written: a config with no AI line fails here, leaving no files behind.
  const smokeSource = stripImagesBinding(
    stripAiBinding(readFileSync(path.join(API, config), 'utf8'))
  );
  const port = Number(arg('port') ?? 8799);
  const base = `http://127.0.0.1:${port}`;

  const seed = spawnSync(
    'npx',
    ['prisma', 'db', 'execute', '--url', owner, '--file', path.join(API, 'scripts/cf-seed.sql')],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`);

  const devVars = path.join(API, '.dev.vars');
  if (existsSync(devVars))
    throw new Error(`${devVars} exists; refusing to overwrite a developer file`);
  writeFileSync(
    devVars,
    [
      'NODE_ENV=development',
      'WEB_URL=http://localhost:3000',
      'ADMIN_URL=http://localhost:3001',
      `API_URL=${base}`,
      'BUILD_COMMIT_SHA=smoke',
      'JWT_SECRET=smoke-only-jwt-secret-0123456789abcdef',
      'SUITE_BUYER_KEY_SECRET=smoke-only-suite-buyer-key-secret-0123456789',
      `ENCRYPTION_KEY=${'0'.repeat(64)}`,
      'TAP_API_KEY=k',
      'TAP_SECRET_KEY=s',
      'TAP_WEBHOOK_SECRET=smoke-only-tap-webhook-secret',
      // No AI binding in the smoke (stripAiBinding): say so explicitly, so a `true` set in the
      // config's vars cannot fail the boot check here for a reason production does not have.
      'SEARCH_SEMANTIC_ENABLED=false',
    ].join('\n') + '\n'
  );

  // Written next to the source config: `main`, `alias` and the other paths in it are relative.
  const smokeConfig = path.join(API, '.wrangler.smoke.jsonc');
  writeFileSync(smokeConfig, smokeSource);

  // The config binds the platform D1 (`PLATFORM_DB`, the per-store backend switch); a fresh local one has no `stores` table, so
  // every store read would 503 (STORE_BACKEND_UNAVAILABLE). Apply its migrations to the same local state `wrangler dev` reads.
  const d1 = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'PLATFORM_DB',
      '--local',
      '--config',
      '.wrangler.smoke.jsonc',
    ],
    { cwd: API, encoding: 'utf8' }
  );
  if (d1.status !== 0) {
    rmSync(devVars, { force: true });
    rmSync(smokeConfig, { force: true });
    throw new Error(`local D1 migrations failed: ${d1.stderr || d1.stdout}`);
  }

  // NEON-ZERO-1: with PLATFORM_DB bound the store directory (slug -> id) is read from D1 only, never Postgres, so the
  // seeded Postgres stores must also exist in the local D1 directory (the cutover copies them there in production).
  const dir = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'PLATFORM_DB',
      '--local',
      '--config',
      '.wrangler.smoke.jsonc',
      '--command',
      "INSERT OR REPLACE INTO stores (id, name, slug, owner_id, storage_backend) VALUES ('11111111-1111-4111-8111-111111111111', 'Alpha Store', 'alpha', '99999999-9999-4999-8999-999999999999', 'pg'), ('22222222-2222-4222-8222-222222222222', 'Bravo Store', 'bravo', '99999999-9999-4999-8999-999999999999', 'pg')",
    ],
    { cwd: API, encoding: 'utf8' }
  );
  if (dir.status !== 0) {
    rmSync(devVars, { force: true });
    rmSync(smokeConfig, { force: true });
    throw new Error(`local D1 directory seed failed: ${dir.stderr || dir.stdout}`);
  }

  const logPath = path.join(tmpdir(), `workerd-smoke-${process.pid}.log`);
  const log = createWriteStream(logPath);
  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(port), '--config', '.wrangler.smoke.jsonc'],
    {
      cwd: API,
      detached: true,
      env: {
        ...process.env,
        NO_PROXY: '127.0.0.1,localhost',
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: app,
      },
    }
  );
  // A chunk that was already in flight when the process group is killed must never crash the run: ending `log` while
  // the child's pipes are still attached made Node throw ERR_STREAM_WRITE_AFTER_END as an unhandled 'error', and the
  // script exited 1 AFTER printing "workerd smoke OK" (observed 2026-10-25, #207; load-dependent, so it looked like
  // infra flakiness). Detach the pipes before ending the file and swallow late stream errors.
  log.on('error', () => {});
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = null;
  child.on('exit', c => (exited = c ?? 'signal'));
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    rmSync(devVars, { force: true });
    rmSync(smokeConfig, { force: true });
  };

  let failure = null;
  try {
    let ready = false;
    for (let i = 0; i < 60 && exited === null && !ready; i++) {
      // `wrangler dev` does NOT exit on a failed bundle: it keeps listening and never answers.
      // Treat a logged build/boot error as the failure it is instead of waiting out the clock.
      const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      if (/\[ERROR\]|Build failed|Uncaught/.test(text.replace(/\x1b\[[0-9;]*m/g, '')))
        throw new Error('wrangler dev logged a build/boot error');
      ready = (await get(base, '/health')).status !== 0;
      if (!ready) await new Promise(r => setTimeout(r, 2000));
    }
    if (!ready)
      throw new Error(
        exited !== null
          ? `wrangler dev exited (${exited}) before serving`
          : 'worker never started serving in 120s'
      );

    const observed = [];
    for (const c of CHECKS) observed.push({ ...c, ...(await get(base, c.path)) });
    for (const o of observed) console.log(`${o.status}  ${o.path}`);
    const problems = smokeProblems(observed);
    if (problems.length) throw new Error(problems.join('\n'));
    console.log(`workerd smoke OK (${CHECKS.length} probes, no 5xx)`);
  } catch (err) {
    failure = err;
  } finally {
    stop();
    closeLog(child, log);
  }
  if (failure) {
    console.log(`::error::workerd smoke FAILED:\n${failure.message}`);
    try {
      console.log(
        '--- wrangler dev log (tail) ---\n' +
          readFileSync(logPath, 'utf8').split('\n').slice(-60).join('\n')
      );
    } catch {}
    process.exit(1);
  }
}

/** Detach the child's pipes from the log file and end it, so a late chunk can never write after end. */
export function closeLog(child, log) {
  child.stdout?.unpipe(log);
  child.stderr?.unpipe(log);
  log.end();
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
