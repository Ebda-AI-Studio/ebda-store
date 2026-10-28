#!/usr/bin/env node
/**
 * Buy-flow parity harness.
 *
 *   node scripts/buy-flow-parity/run.mjs --base origin/main --head <ref>
 *   node scripts/buy-flow-parity/run.mjs --api-url-base <url> --api-url-head <url> \
 *        --pg-url-base <url> --pg-url-head <url> [--redis-url <url>]   # runtime mode
 *
 * Runs the SAME deterministic buy scenarios against two git refs — each ref
 * checked out into its own temporary worktree, built, migrated onto its own
 * fresh local Postgres database and served by its own API process behind an
 * identical network stub — then diffs the observable outcome field by field.
 * Identical output = the change does not influence ordering or payment.
 *
 * Never touches a remote database, a remote API or a real payment gateway:
 * the API process gets a hand-built environment (no inherited DATABASE_URL,
 * no .env), and every non-loopback network call is intercepted (lib/preload.mjs).
 * In api-url mode a side is an already-running API (Node-Express, a Cloudflare
 * Worker, ...): no worktree/build/spawn, the harness only seeds its database and
 * drives it over HTTP. See scripts/buy-flow-parity/README.md.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStub } from './lib/stub.mjs';
import { PM_API_KEY, PM_SECRET_KEY } from './lib/fixture.mjs';
import { paymentEndpointProblems } from './lib/guards.mjs';
import { buildFixture } from './lib/fixture.mjs';
import { snapshotDb, psqlExec, psqlJson } from './lib/snapshot.mjs';
import { makeNormalizer, diff, parseAllows, allowFor } from './lib/compare.mjs';
import { Shopper, Admin, HARNESS_ENV } from './lib/client.mjs';
import { SCENARIOS } from './lib/scenarios.mjs';
import { createExecutor } from './lib/inngest-executor.mjs';

// The strict-RLS runtime role of the refs under test (the migration creates it NOLOGIN).
const APP_ROLE = process.env.PARITY_APP_ROLE || 'ebda_app';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const a = {
    base: null,
    head: 'HEAD',
    apiUrlBase: null,
    apiUrlHead: null,
    pgUrlBase: null,
    pgUrlHead: null,
    redisUrlBase: null,
    redisUrlHead: null,
    only: null,
    allow: [],
    keepWorktrees: false,
    keepDb: false,
    pgUrl: null,
    redisUrl: null,
    apiPort: 4610,
    stubPort: 4690,
    out: path.join(HERE, 'out'),
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--base') a.base = v();
    else if (k === '--head') a.head = v();
    else if (k === '--only') a.only = v().split(',');
    else if (k === '--allow') a.allow.push(v());
    else if (k === '--keep-worktrees') a.keepWorktrees = true;
    else if (k === '--keep-db') a.keepDb = true;
    else if (k === '--pg-url') a.pgUrl = v();
    else if (k === '--redis-url') a.redisUrl = v();
    else if (k === '--api-url-base') a.apiUrlBase = v();
    else if (k === '--api-url-head') a.apiUrlHead = v();
    else if (k === '--pg-url-base') a.pgUrlBase = v();
    else if (k === '--pg-url-head') a.pgUrlHead = v();
    else if (k === '--redis-url-base') a.redisUrlBase = v();
    else if (k === '--redis-url-head') a.redisUrlHead = v();
    else if (k === '--encryption-key') a.encryptionKey = v();
    else if (k === '--api-port') a.apiPort = Number(v());
    else if (k === '--stub-port') a.stubPort = Number(v());
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--list') a.list = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const log = (...m) => console.error('[bfp]', ...m);

// ---------------------------------------------------------------- git
/**
 * Child git with every GIT_* variable stripped: a harness launched from a git
 * hook (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE set) must never point its own
 * `git worktree add` at the caller's index or config.
 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, ...extra };
}
function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    env: cleanEnv(),
    encoding: 'utf8',
    ...opts,
  }).trim();
}
// `--default ''`: an unset core.bare is normal (git exits 1 for a missing key), not an error.
const coreBare = () => git(['config', '--default', '', '--get', 'core.bare']);

// ---------------------------------------------------------------- infra
// `-pgvector17`: migrations need the `vector` extension (search program P1) on production's major
// (17). The name carries the image because an existing container is reused as-is by name and would
// keep its old image (pg16 alpine, then pg16 pgvector): bump the name whenever the image changes.
const CONTAINER_PG = 'ebda-buyflow-pgvector17';
const CONTAINER_REDIS = 'ebda-buyflow-redis';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function containerState(name) {
  try {
    const out = sh('container', ['ls', '-a']);
    const line = out.split('\n').find(l => l.split(/\s+/)[0] === name);
    if (!line) return 'absent';
    return /\brunning\b/.test(line) ? 'running' : 'stopped';
  } catch {
    return 'unavailable';
  }
}

async function waitFor(fn, what, timeoutMs = 60000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function ensureInfra(args) {
  if (args.pgUrl && args.redisUrl) return { pgUrl: args.pgUrl, redisUrl: args.redisUrl };
  const ensure = (name, runArgs) => {
    const st = containerState(name);
    if (st === 'unavailable') {
      throw new Error(
        'Apple `container` CLI not available — pass --pg-url and --redis-url for an existing LOCAL postgres/redis'
      );
    }
    if (st === 'stopped') sh('container', ['start', name]);
    if (st === 'absent') sh('container', ['run', '-d', '--name', name, ...runArgs]);
  };
  if (!args.pgUrl) {
    ensure(CONTAINER_PG, [
      '-p',
      '127.0.0.1:55432:5432',
      '-e',
      'POSTGRES_USER=parity',
      '-e',
      'POSTGRES_PASSWORD=parity',
      '-m',
      '2048M',
      'docker.io/pgvector/pgvector:0.8.0-pg17',
    ]);
  }
  if (!args.redisUrl) {
    ensure(CONTAINER_REDIS, ['-p', '127.0.0.1:56379:6379', 'docker.io/library/redis:7-alpine']);
  }
  // Throwaway credentials of the local container above (never a real secret);
  // assembled with URL so no literal connection string sits in the source.
  const localPg = new URL('postgresql://127.0.0.1:55432/postgres');
  localPg.username = 'parity';
  localPg.password = 'parity';
  const pgUrl = args.pgUrl ?? localPg.toString();
  const redisUrl = args.redisUrl ?? 'redis://127.0.0.1:56379';
  await waitFor(() => psqlJson(pgUrl, `SELECT to_json(1)`) === 1, 'postgres');
  await waitFor(() => redisCmd(redisUrl, 'PING').then(r => r.startsWith('+PONG')), 'redis');
  return { pgUrl, redisUrl };
}

function assertLocal(url, what) {
  const h = new URL(url).hostname;
  if (!(h === 'localhost' || h.startsWith('127.') || h === '::1')) {
    throw new Error(
      `${what} must be a LOOPBACK address (got ${h}) — this harness writes and drops databases`
    );
  }
}

function redisCmd(redisUrl, ...parts) {
  const u = new URL(redisUrl);
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: u.hostname, port: Number(u.port || 6379) }, () => {
      s.write(
        `*${parts.length}\r\n${parts.map(p => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`
      );
    });
    s.once('data', d => {
      resolve(d.toString());
      s.end();
    });
    s.once('error', reject);
  });
}

const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/**
 * api-url mode: the API under test is already connected to its database, so the
 * database cannot be dropped and recreated. Instead every table is TRUNCATEd
 * (except Prisma's migration ledger) and the fixture is seeded again, so a side
 * can be re-run any number of times. The schema must already be migrated.
 */
const KEEP_TABLES = new Set(['_prisma_migrations']);
function resetData(owner) {
  const tables = psqlJson(
    owner,
    `SELECT coalesce(json_agg(tablename), '[]'::json) FROM pg_tables WHERE schemaname = 'public'`
  ).filter(t => !KEEP_TABLES.has(t));
  if (!tables.length) throw new Error('no tables in the target database — was it migrated?');
  psqlExec(
    owner,
    `TRUNCATE ${tables.map(t => `public."${t}"`).join(', ')} RESTART IDENTITY CASCADE;`
  );
}

async function waitForApi(origin, logFile) {
  await waitFor(
    async () => {
      const r = await fetch(`${origin}/health`).catch(() => null);
      return r && r.status < 500;
    },
    `API /health at ${origin}${logFile ? ` (see ${logFile})` : ''}`,
    90000
  );
}

// ---------------------------------------------------------------- refs
function resolveRef(ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]);
}

function run(cmd, args, cwd, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  try {
    fs.writeSync(fd, `\n$ ${cmd} ${args.join(' ')}\n`);
    execFileSync(cmd, args, { cwd, env, stdio: ['ignore', fd, fd] });
  } catch (e) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd} — see ${logFile}`);
  } finally {
    fs.closeSync(fd);
  }
}

function prepareRef(sha, logDir) {
  const root = path.join(os.tmpdir(), 'ebda-buy-flow-parity');
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `wt-${sha.slice(0, 12)}`);
  const marker = path.join(dir, '.bfp-ready');
  const logFile = path.join(logDir, `build-${sha.slice(0, 12)}.log`);
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === sha) {
    log(`reusing built worktree ${dir}`);
    return dir;
  }
  if (fs.existsSync(dir)) {
    try {
      git(['worktree', 'remove', '--force', dir]);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      git(['worktree', 'prune']);
    }
  }
  log(`checking out ${sha.slice(0, 12)} → ${dir}`);
  git(['worktree', 'add', '--detach', dir, sha]);
  // HUSKY=0: `prepare` must not run `husky`, which writes core.hooksPath into
  // the SHARED .git/config.
  const env = cleanEnv({ HUSKY: '0', CI: '1' });
  const t0 = Date.now();
  run('npx', ['-y', 'npm@10', 'ci', '--no-audit', '--no-fund'], dir, env, logFile);
  run('npm', ['run', 'db:generate'], dir, env, logFile);
  run('npm', ['run', 'build', '-w', 'packages/database'], dir, env, logFile);
  run('npm', ['run', 'build', '-w', 'packages/shared'], dir, env, logFile);
  run('npm', ['run', 'build', '-w', 'apps/api'], dir, env, logFile);
  fs.writeFileSync(marker, sha);
  log(`built ${sha.slice(0, 12)} in ${Math.round((Date.now() - t0) / 1000)}s`);
  return dir;
}

function removeWorktree(dir) {
  try {
    git(['worktree', 'remove', '--force', dir]);
  } catch (e) {
    log(`warning: could not remove worktree ${dir}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- API process
const SECRETS = {
  JWT_SECRET: 'bfp-parity-jwt-secret-local-only-0123456789',
  ENCRYPTION_KEY: 'bfp-parity-encryption-key-local-only-0123456789',
};

async function startApi({ dir, dbUrlApp, dbUrlOwner, redisUrl, port, stubUrl, logFile }) {
  // Hand-built environment: NOTHING inherited except PATH/HOME, so a developer
  // shell holding a production DATABASE_URL can never reach the process.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    TZ: 'UTC',
    NODE_ENV: 'development',
    PORT: String(port),
    API_URL: `http://127.0.0.1:${port}`,
    WEB_URL: 'http://localhost:3000',
    ADMIN_URL: 'http://localhost:3001',
    DATABASE_URL: dbUrlApp,
    DIRECT_URL: dbUrlOwner,
    REDIS_URL: redisUrl,
    ...SECRETS,
    BFP_STUB_URL: stubUrl,
    ...HARNESS_ENV,
  };
  const out = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    ['--import', path.join(HERE, 'lib', 'preload.mjs'), 'apps/api/dist/index.js'],
    { cwd: dir, env, stdio: ['ignore', out, out] }
  );
  let exited = null;
  child.on('exit', code => (exited = code));
  await waitFor(
    async () => {
      if (exited !== null) throw new Error(`API exited with code ${exited} — see ${logFile}`);
      const r = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      return r && r.status < 500;
    },
    `API /health on :${port}`,
    90000
  );
  return {
    async stop() {
      if (exited !== null) return;
      child.kill('SIGTERM');
      await waitFor(() => exited !== null, 'API shutdown', 15000).catch(() =>
        child.kill('SIGKILL')
      );
      fs.closeSync(out);
    },
  };
}

// ---------------------------------------------------------------- one ref
class SkipError extends Error {}

/** Order-shaped = has orderNumber + total (API order payloads). */
function defaultWalletAmount(v) {
  if (Array.isArray(v)) return v.forEach(defaultWalletAmount);
  if (!v || typeof v !== 'object') return;
  if ('orderNumber' in v && 'total' in v && !('walletAmount' in v)) v.walletAmount = 0;
  for (const x of Object.values(v)) defaultWalletAmount(x);
}

/**
 * Background runs keyed by "<event> → <function> #k" (not by position) so a
 * function that one ref runs and the other does not shows up as exactly one
 * added/removed entry, and each run's steps are one comparable line.
 */
function keyRuns(runs) {
  const seen = new Map();
  const out = {};
  for (const r of runs) {
    const base = `${r.event} → ${r.function}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    out[`${base} #${k}`] = {
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      steps: r.steps
        .map(st =>
          st.op === 'ran' ? st.step : `${st.step}[${st.op}${st.error ? `: ${st.error}` : ''}]`
        )
        .join(' → '),
    };
  }
  return out;
}

let currentExecutor = null;
function withDrain(client) {
  client.afterCall = () => currentExecutor.drain();
  return client;
}

async function runRef({ label, sha, dir, infra, args, stub, scenarios, logDir, external }) {
  const t0 = Date.now();
  const db = external ? null : `bfp_${label}_${sha.slice(0, 10)}_${process.pid}`;
  let owner;
  let admin;
  let redisUrl;
  let api;
  let origin;
  if (external) {
    // Already-running API: only its database is ours to prepare.
    owner = external.pgUrl;
    redisUrl = external.redisUrl;
    origin = external.apiUrl.replace(/\/+$/, '');
    log(`[${label}] resetting data in ${new URL(owner).pathname.slice(1)} (api ${origin})`);
    resetData(owner);
    if (redisUrl) await redisCmd(redisUrl, 'FLUSHALL');
    else log(`[${label}] no redis url for this side — redis state is NOT reset`);
    await waitForApi(origin);
    api = { async stop() {} };
  } else {
    owner = withDb(infra.pgUrl, db);
    admin = infra.pgUrl;
    redisUrl = infra.redisUrl;
    psqlExec(admin, `DROP DATABASE IF EXISTS ${db};\nCREATE DATABASE ${db};`);
    log(`[${label}] migrating ${db}`);
    run(
      path.join(dir, 'node_modules', '.bin', 'prisma'),
      ['migrate', 'deploy', '--schema', 'packages/database/prisma/schema.prisma'],
      dir,
      { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: owner, DIRECT_URL: owner },
      path.join(logDir, `${label}-migrate.log`)
    );
    // The API runs as the non-bypass RLS role, exactly like production and CI.
    psqlExec(owner, `ALTER ROLE ${APP_ROLE} WITH PASSWORD 'bfp-parity-app' LOGIN;`);
    await redisCmd(redisUrl, 'FLUSHALL');
  }
  const appUrl = (() => {
    const u = new URL(owner);
    u.username = APP_ROLE;
    u.password = 'bfp-parity-app';
    return u.toString();
  })();

  const fixture = buildFixture({ encryptionKey: args.encryptionKey, scenarios });
  psqlExec(owner, fixture.sql);

  if (!external) {
    api = await startApi({
      dir,
      dbUrlApp: appUrl,
      dbUrlOwner: owner,
      redisUrl,
      port: args.apiPort,
      stubUrl: `http://127.0.0.1:${args.stubPort}`,
      logFile: path.join(logDir, `${label}-api.log`),
    });
    origin = `http://127.0.0.1:${args.apiPort}`;
  }
  const apiBase = `${origin}/api/v1`;
  const executor = createExecutor({ stub, apiOrigin: origin });
  currentExecutor = executor;
  const results = {};
  try {
    const fnCount = await executor.register();
    log(`[${label}] ${fnCount} Inngest functions registered`);
    for (const sc of scenarios) {
      const index = SCENARIOS.indexOf(sc);
      stub.setScenario(index);
      const cat = fixture.catalog[sc.id];
      const steps = [];
      const notes = [];
      const expectations = [];
      const ctx = {
        stub,
        steps,
        orderIds: [],
        note: n => notes.push(n),
        // A payment-endpoint expectation: step `name` must have run, and every run of it must
        // have answered one of `codes`. Checked after the scenario (see below).
        expectations,
        expect: (name, codes) => expectations.push({ name, codes }),
        skip: reason => {
          throw new SkipError(reason);
        },
        // Let fire-and-forget promises land, then run any queued Inngest work.
        settle: async () => {
          await new Promise(r => setTimeout(r, 300));
          await executor.drain();
        },
        shopper: (lbl, storeKey = sc.store ?? 'main') =>
          withDrain(new Shopper(apiBase, steps, fixture.stores[storeKey], `${sc.id}:${lbl}`)),
        admin: () => withDrain(new Admin(apiBase, steps)),
        gateway: withDrain(new Admin(apiBase, steps)),
        p: k => cat.products[k],
        v: k => cat.variants[k],
        c: k => cat.coupons[k].code,
        b: k => cat.bundles[k],
      };
      let status = 'ran';
      let error = null;
      try {
        await sc.run(ctx);
        await ctx.settle();
      } catch (e) {
        if (e instanceof SkipError) {
          status = 'skipped';
          error = e.message;
        } else {
          status = 'error';
          error = e.stack || String(e);
        }
      }
      const dbSnap = snapshotDb(owner, {
        orderIds: ctx.orderIds,
        productIds: Object.values(cat.products),
        variantIds: Object.values(cat.variants),
        couponIds: Object.values(cat.coupons).map(c => c.id),
      });
      const gateway = stub.takeRequests().map(({ seq, ...r }) => r);
      const inngestRuns = executor.takeRuns();
      // A 429 means the HARNESS tripped a limiter — the scenario did not test
      // what it claims to, so it must not be able to report PASS.
      const throttled = [
        ...steps.filter(s => s.status === 429).map(s => s.step),
        ...inngestRuns.filter(r => r.http === 429).map(r => `inngest:${r.function}`),
      ];
      // PAYMENT ENDPOINTS MUST BE REAL. A scenario whose payment call answers 404 has not
      // exercised the payment path (a route that is gone, or a read RLS hides from the app role):
      // both sides being equally broken must read as an ERROR, never as "identical, PASS".
      if (status === 'ran') {
        const problems = paymentEndpointProblems(steps, expectations);
        if (problems.length) {
          status = 'error';
          error = problems.join('; ');
        }
      }
      if (throttled.length && status === 'ran') {
        status = 'error';
        error = `harness was rate-limited (429) at: ${throttled.join(', ')}`;
      }
      // A dev-mode 5xx message carries a Prisma code frame (build paths) and
      // elapsed milliseconds. Compare its LAST line with digits masked — that
      // line still says WHY it failed ("Cannot transition from cancelled to
      // refunded" vs "Transaction already closed"), which must stay visible.
      for (const s of steps) {
        if (s.status >= 500 && typeof s.body?.error?.message === 'string') {
          const last =
            s.body.error.message
              .split('\n')
              .filter(l => l.trim())
              .slice(-1)[0] ?? '';
          notes.push(`${s.step} ${s.status}: ${last}`);
          s.body.error.message = last.replace(/\d+/g, '<n>');
        }
      }
      // Owner-specified: `walletAmount` (added by b1b5bbd1, default 0) counts
      // as 0 where a ref does not have it — the order row gets the same rule
      // in snapshot.mjs. Applied to every order-shaped object in responses.
      for (const s of steps) defaultWalletAmount(s.body);
      const normalize = makeNormalizer(fixture.ids);
      results[sc.id] = {
        status,
        error,
        notes,
        snapshot: normalize({
          // Keyed "<nn>_<step>" so a diff path (and an --allow prefix) names
          // the request, e.g. http.06_checkout.create-payment.body.data.codFee.
          http: Object.fromEntries(
            steps.map((s, i) => [
              `${String(i).padStart(2, '0')}_${s.step}`,
              // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection -- a CLI harness building its own report object from its own step list, not an Express handler reading user input
              { method: s.method, path: s.path, status: s.status, body: s.body },
            ])
          ),
          db: dbSnap,
          gateway: {
            paymob: gateway.filter(r => r.service === 'paymob'),
            inngestEvents: gateway.filter(r => r.service === 'inngest').map(r => r.event),
          },
          inngestRuns: keyRuns(inngestRuns),
        }),
        // Informational only (fire-and-forget timing): refused non-gateway calls.
        blockedOutbound: gateway
          .filter(r => r.service === 'outbound')
          .map(r => `${r.method} ${r.path}`),
      };
      log(`[${label}] ${sc.id}: ${status}${error ? ` (${error.split('\n')[0]})` : ''}`);
    }
  } finally {
    await api.stop();
    if (!external && !args.keepDb) psqlExec(admin, `DROP DATABASE IF EXISTS ${db};`);
  }
  return {
    sha,
    db: db ?? new URL(owner).pathname.slice(1),
    seconds: Math.round((Date.now() - t0) / 1000),
    results,
  };
}

// ---------------------------------------------------------------- report
const fmt = v => (v === undefined ? '∅ (absent)' : JSON.stringify(v)?.slice(0, 300));

function compareRuns(base, head, scenarios, allows) {
  const rows = [];
  for (const sc of scenarios) {
    const b = base.results[sc.id];
    const h = head.results[sc.id];
    if (b.status === 'skipped' || h.status === 'skipped') {
      rows.push({ id: sc.id, verdict: 'SKIPPED', reason: b.error || h.error, diffs: [] });
      continue;
    }
    if (b.status === 'error' || h.status === 'error') {
      rows.push({
        id: sc.id,
        verdict: 'ERROR',
        reason: `base: ${b.error ?? 'ok'} | head: ${h.error ?? 'ok'}`,
        diffs: [],
      });
      continue;
    }
    const diffs = diff(b.snapshot, h.snapshot).map(d => {
      const a = allowFor(allows, sc.id, d.path);
      return { ...d, allowed: a ? a.reason : null };
    });
    const blocking = diffs.filter(d => !d.allowed);
    rows.push({
      id: sc.id,
      verdict: blocking.length ? 'DIFF' : diffs.length ? 'PASS (allowed diffs)' : 'PASS',
      diffs,
    });
  }
  return rows;
}

function renderMarkdown({ args, base, head, rows }) {
  const L = [];
  L.push(`# Buy-flow parity report`, '');
  L.push(
    `- base: \`${base.sha}\` (${base.seconds}s)`,
    `- head: \`${head.sha}\` (${head.seconds}s)`
  );
  L.push(`- generated: ${new Date().toISOString()}`, '');
  L.push('| scenario | verdict | diffs |', '|---|---|---|');
  for (const r of rows) L.push(`| ${r.id} | **${r.verdict}** | ${r.diffs.length} |`);
  L.push('');
  for (const r of rows) {
    if (r.verdict === 'PASS') continue;
    L.push(`## ${r.id} — ${r.verdict}`, '');
    if (r.reason) L.push('```', r.reason.slice(0, 4000), '```', '');
    for (const d of r.diffs) {
      L.push(`- \`${d.path}\` (${d.kind})${d.allowed ? ` — ALLOWED: ${d.allowed}` : ''}`);
      L.push(`  - base: \`${fmt(d.base)}\``, `  - head: \`${fmt(d.head)}\``);
    }
    L.push('');
  }
  void args;
  return L.join('\n');
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'));
    return 0;
  }
  if (args.list) {
    for (const s of SCENARIOS) console.log(`${s.id}\t${s.title}`);
    return 0;
  }
  const allows = parseAllows(args.allow);
  const scenarios = args.only ? SCENARIOS.filter(s => args.only.includes(s.id)) : SCENARIOS;
  if (args.only && scenarios.length !== args.only.length) {
    throw new Error(
      `unknown scenario in --only: ${args.only.filter(o => !SCENARIOS.some(s => s.id === o)).join(', ')}`
    );
  }
  args.encryptionKey = args.encryptionKey ?? SECRETS.ENCRYPTION_KEY;

  // A side is either a git ref (built + spawned here) or an already-running API.
  const sideSpec = label => {
    const L = label === 'base' ? 'Base' : 'Head';
    const apiUrl = args[`apiUrl${L}`];
    if (!apiUrl) return { label, mode: 'ref', ref: args[label] };
    const pgUrl = args[`pgUrl${L}`] ?? args.pgUrl;
    const redisUrl = args[`redisUrl${L}`] ?? args.redisUrl;
    if (!pgUrl) {
      throw new Error(
        `--api-url-${label} needs --pg-url-${label} (or --pg-url): the fixture is seeded per side`
      );
    }
    assertLocal(pgUrl, `--pg-url-${label}`);
    if (redisUrl) assertLocal(redisUrl, `--redis-url-${label}`);
    new URL(apiUrl);
    return { label, mode: 'url', apiUrl, pgUrl, redisUrl };
  };
  const sides = [sideSpec('base'), sideSpec('head')];
  const refSides = sides.filter(x => x.mode === 'ref');
  for (const x of refSides) {
    if (!x.ref) {
      throw new Error(
        `ref mode needs --${x.label} <ref> (there is no default baseline; use e.g. --base origin/main)`
      );
    }
  }
  if (args.pgUrl) assertLocal(args.pgUrl, '--pg-url');
  if (args.redisUrl) assertLocal(args.redisUrl, '--redis-url');
  if (sides[0].mode === 'url' && sides[1].mode === 'url' && sides[0].apiUrl === sides[1].apiUrl) {
    const [b, h] = sides;
    if (b.pgUrl === h.pgUrl) {
      log('note: both sides share one API and one database — it is re-seeded between sides');
    }
  }

  const bareBefore = refSides.length ? coreBare() : '';
  for (const x of sides) {
    x.id = x.mode === 'ref' ? resolveRef(x.ref) : x.apiUrl;
    x.tag = x.mode === 'ref' ? x.id.slice(0, 8) : `url-${x.label}`;
  }
  const [baseSide, headSide] = sides;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(args.out, `${stamp}_${baseSide.tag}_vs_${headSide.tag}`);
  fs.mkdirSync(outDir, { recursive: true });
  log(`base ${baseSide.id}  head ${headSide.id}  → ${outDir}`);

  const infra = refSides.length ? await ensureInfra(args) : null;
  const stub = createStub({ secretKey: PM_SECRET_KEY, apiKey: PM_API_KEY });
  await stub.listen(args.stubPort);
  const built = new Map();
  const results = {};
  const tStart = Date.now();
  try {
    for (const x of refSides) if (!built.has(x.id)) built.set(x.id, prepareRef(x.id, outDir));
    for (const x of sides) {
      results[x.label] = await runRef({
        label: x.label,
        sha: x.id,
        dir: x.mode === 'ref' ? built.get(x.id) : null,
        infra,
        args,
        stub,
        scenarios,
        logDir: outDir,
        external: x.mode === 'url' ? x : null,
      });
    }
  } finally {
    await stub.close();
    if (!args.keepWorktrees) for (const dir of built.values()) removeWorktree(dir);
    if (refSides.length) {
      const bareAfter = coreBare();
      if (bareAfter !== bareBefore) {
        console.error(
          `[bfp] !!! core.bare changed from ${bareBefore} to ${bareAfter} — restore with: git config core.bare ${bareBefore}`
        );
        process.exitCode = 3;
      }
    }
  }
  const { base, head } = results;

  const rows = compareRuns(base, head, scenarios, allows);
  fs.writeFileSync(path.join(outDir, 'base.json'), JSON.stringify(base, null, 2));
  fs.writeFileSync(path.join(outDir, 'head.json'), JSON.stringify(head, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify({ base: base.sha, head: head.sha, rows }, null, 2)
  );
  const md = renderMarkdown({ args, base, head, rows });
  fs.writeFileSync(path.join(outDir, 'report.md'), md);

  console.log(
    `\nbuy-flow parity  base ${baseSide.tag} vs head ${headSide.tag}  (${Math.round((Date.now() - tStart) / 1000)}s)`
  );
  for (const r of rows) {
    console.log(
      `  ${r.verdict.padEnd(20)} ${r.id}${r.diffs.length ? `  (${r.diffs.length} field diffs)` : ''}`
    );
    for (const d of r.diffs.slice(0, 40)) {
      console.log(
        `      ${d.allowed ? 'allowed ' : ''}${d.kind.padEnd(8)} ${d.path}\n          base: ${fmt(d.base)}\n          head: ${fmt(d.head)}`
      );
    }
    if (r.diffs.length > 40) console.log(`      … ${r.diffs.length - 40} more in report.md`);
    if (r.reason) console.log(`      ${r.reason.split('\n')[0]}`);
  }
  console.log(`\nreport: ${path.join(outDir, 'report.md')}`);
  const bad = rows.filter(
    r => r.verdict === 'DIFF' || r.verdict === 'ERROR' || r.verdict === 'SKIPPED'
  );
  if (bad.length && !process.exitCode) process.exitCode = 1;
  return process.exitCode ?? 0;
}

main().then(
  code => process.exit(code ?? 0),
  err => {
    console.error('[bfp] FAILED:', err.stack || err);
    process.exit(2);
  }
);
