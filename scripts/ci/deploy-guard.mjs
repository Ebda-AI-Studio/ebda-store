#!/usr/bin/env node
/**
 * Deploy guard (Ruling DEPLOY-SAFETY-2): record what is live BEFORE `wrangler deploy`, probe the
 * live system AFTER it, and roll back to the recorded version if the probes do not pass.
 *
 *   node scripts/ci/deploy-guard.mjs previous --name ebda-api [--cwd apps/api] [--config c.jsonc]
 *       prints the version id serving 100% of traffic (or `none`); also writes `previous=<id>`
 *       to $GITHUB_OUTPUT. A lookup failure is fatal (a guard that cannot find its way back must
 *       not let the deploy proceed unguarded); a Worker that does not exist yet is `none`.
 *
 *   node scripts/ci/deploy-guard.mjs verify --name ebda-api --previous <id|none> \
 *       --probe 'https://api.ebda.app/health|200|commit=<sha>' \
 *       --probe 'https://api.ebda.app/api/v1/public/stores/x|404' \
 *       --rollback-probe 'https://api.ebda.app/health|200' [--window 90] [--interval 5]
 *       [--resolve-ip 1.2.3.4] [--cwd apps/api] [--config c.jsonc]
 *       exit 0 = every probe passed inside the window.
 *       exit 1 = probes failed, rolled back, and the rollback probes pass (the deploy FAILED).
 *       exit 2 = probes failed and service is NOT confirmed restored (page a human).
 *
 * A probe is `url|expected-status[|commit=<sha>]`. A 5xx or an unreachable host never matches any
 * expected status; with `commit=` the body must be JSON `{status:"ok", commit:<sha>}`.
 *
 * Rolling code back does NOT undo database migrations: they must stay expand-then-contract
 * (Ruling CF-MIGRATE-1); the rollback path prints that warning.
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATION_WARNING =
  'Rolling the Worker back does NOT undo database migrations. The schema stays at the new ' +
  'version, so the old code must keep working against it (expand-then-contract, Ruling CF-MIGRATE-1). ' +
  'If this deploy shipped a contract migration, restore compatibility by hand.';

/** The version id serving 100% of traffic in the newest deployment, or null if none/split. */
export function currentVersionId(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) return null;
  const newest = [...deployments].sort((a, b) =>
    String(a.created_on).localeCompare(String(b.created_on))
  )[deployments.length - 1];
  const versions = newest?.versions ?? [];
  const full = versions.filter(v => Number(v.percentage) === 100);
  return full.length === 1 && typeof full[0].version_id === 'string' ? full[0].version_id : null;
}

export function parseProbe(text) {
  const [url, expect, extra] = String(text).split('|');
  const status = Number(expect);
  if (!/^https?:\/\//.test(url ?? '') || !Number.isInteger(status) || status < 100 || status > 599)
    throw new Error(`bad probe "${text}" (want url|status[|commit=sha])`);
  const probe = { url, status };
  if (extra !== undefined) {
    if (!extra.startsWith('commit=') || extra.length === 7)
      throw new Error(`bad probe "${text}": third field must be commit=<sha>`);
    probe.commit = extra.slice(7);
  }
  return probe;
}

/** One probe, one verdict. Never throws: an unreachable host is a failed probe. */
export async function runProbe(probe, deps) {
  let res;
  try {
    res = await deps.fetchProbe(probe.url);
  } catch (err) {
    return { ok: false, detail: `${probe.url} unreachable (${err.message})` };
  }
  if (res.status >= 500 || res.status !== probe.status)
    return { ok: false, detail: `${probe.url} status=${res.status} want=${probe.status}` };
  if (probe.commit !== undefined) {
    let body;
    try {
      body = JSON.parse(res.body);
    } catch {
      return { ok: false, detail: `${probe.url} body is not JSON` };
    }
    if (body?.status !== 'ok')
      return { ok: false, detail: `${probe.url} status field is ${JSON.stringify(body?.status)}` };
    if (body.commit !== probe.commit)
      return { ok: false, detail: `${probe.url} live commit=${body.commit} want=${probe.commit}` };
  }
  return { ok: true, detail: `${probe.url} status=${res.status}` };
}

/** Poll until every probe passes in the same round, or the window ends. */
export async function pollProbes(probes, { windowMs, intervalMs }, deps) {
  const deadline = deps.now() + windowMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    const results = await Promise.all(probes.map(p => runProbe(p, deps)));
    deps.log(`attempt ${attempt}: ${results.map(r => r.detail).join(' | ')}`);
    if (results.every(r => r.ok)) return { ok: true, attempts: attempt };
    if (deps.now() + intervalMs > deadline)
      return {
        ok: false,
        attempts: attempt,
        failures: results.filter(r => !r.ok).map(r => r.detail),
      };
    await deps.sleep(intervalMs);
  }
}

/**
 * The decision, with every side effect injected. Returns the process exit code.
 * deps: fetchProbe, run(args)->{code,stdout,stderr} (wrangler), sleep, now, log, error.
 */
export async function verifyOrRollback(opts, deps) {
  const probes = opts.probes.map(parseProbe);
  const rollbackProbes = opts.rollbackProbes.map(parseProbe);
  if (probes.length === 0) throw new Error('verify needs at least one --probe');
  const first = await pollProbes(
    probes,
    { windowMs: opts.windowMs, intervalMs: opts.intervalMs },
    deps
  );
  if (first.ok) {
    deps.log(`${opts.name}: healthy after ${first.attempts} attempt(s)`);
    return 0;
  }
  deps.error(`${opts.name}: post-deploy verification FAILED: ${first.failures.join('; ')}`);
  deps.error(MIGRATION_WARNING);
  if (!opts.previous || opts.previous === 'none') {
    deps.error(
      `${opts.name}: no previous version was recorded, so there is NOTHING to roll back to. Production is serving a failing build.`
    );
    return 2;
  }
  deps.log(`${opts.name}: rolling back to version ${opts.previous}`);
  const rb = await deps.run([
    'rollback',
    opts.previous,
    '--name',
    opts.name,
    '--message',
    `auto-rollback: post-deploy probes failed (${opts.sha ?? 'unknown sha'})`,
    '--yes',
  ]);
  if (rb.code !== 0) {
    deps.error(
      `${opts.name}: wrangler rollback FAILED (exit ${rb.code}): ${rb.stderr || rb.stdout}`
    );
    return 2;
  }
  const second = await pollProbes(
    rollbackProbes.length ? rollbackProbes : probes.map(({ commit, ...p }) => p),
    { windowMs: opts.rollbackWindowMs, intervalMs: opts.intervalMs },
    deps
  );
  if (!second.ok) {
    deps.error(
      `${opts.name}: rolled back to ${opts.previous} but the rollback probes still fail: ${second.failures.join('; ')}`
    );
    return 2;
  }
  deps.error(
    `${opts.name}: deploy of ${opts.sha ?? 'this build'} FAILED its probes; rolled back to ${opts.previous} and that version is serving. Fix forward, then redeploy.`
  );
  return 1;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { probe: [], 'rollback-probe': [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      (out._ ||= []).push(a);
      continue;
    }
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`--${key} needs a value`);
    if (Array.isArray(out[key])) out[key].push(val);
    else out[key] = val;
  }
  return out;
}

function sh(cmd, args, cwd) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    );
  });
}

function realDeps(a) {
  const wranglerBase = a.config ? ['--config', a.config] : [];
  return {
    now: () => Date.now(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    log: m => console.log(m),
    error: m => console.log(`::error::${m}`),
    run: args => sh('npx', ['wrangler', ...args, ...wranglerBase], a.cwd),
    async fetchProbe(url) {
      const args = ['--silent', '--max-time', '10', '--write-out', '\n__STATUS__%{http_code}'];
      if (a['resolve-ip'])
        args.push('--resolve', `${new URL(url).hostname}:443:${a['resolve-ip']}`);
      const r = await sh('curl', [...args, url]);
      const i = r.stdout.lastIndexOf('\n__STATUS__');
      const status = i < 0 ? 0 : Number(r.stdout.slice(i + 11));
      if (!status) throw new Error(`curl exit ${r.code}`);
      return { status, body: r.stdout.slice(0, i) };
    },
  };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (!a.name) throw new Error('--name is required');
  const deps = realDeps(a);
  if (cmd === 'previous') {
    const r = await deps.run(['deployments', 'list', '--name', a.name, '--json']);
    let id = null;
    if (r.code !== 0) {
      if (/10007|does not exist|not found/i.test(r.stderr + r.stdout)) {
        console.log(
          `::warning::${a.name} has no deployments yet; a failed first deploy cannot be rolled back`
        );
      } else {
        console.log(
          `::error::could not read ${a.name}'s current deployment: ${r.stderr || r.stdout}`
        );
        process.exit(1);
      }
    } else {
      try {
        id = currentVersionId(JSON.parse(r.stdout));
      } catch (err) {
        console.log(`::error::unparseable deployments list for ${a.name}: ${err.message}`);
        process.exit(1);
      }
      if (!id)
        console.log(
          `::warning::${a.name} has no single 100% version (split traffic or empty); rollback disabled`
        );
    }
    const value = id ?? 'none';
    console.log(`${a.name} currently serves version: ${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `previous=${value}\n`);
    return 0;
  }
  if (cmd === 'verify') {
    return verifyOrRollback(
      {
        name: a.name,
        previous: a.previous,
        sha: a.sha ?? process.env.GITHUB_SHA,
        probes: a.probe,
        rollbackProbes: a['rollback-probe'],
        windowMs: Number(a.window ?? 90) * 1000,
        rollbackWindowMs: Number(a['rollback-window'] ?? 90) * 1000,
        intervalMs: Number(a.interval ?? 5) * 1000,
      },
      deps
    );
  }
  throw new Error('usage: deploy-guard.mjs previous|verify --name <worker> ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    code => process.exit(code),
    err => {
      console.log(`::error::deploy-guard: ${err.message}`);
      process.exit(2);
    }
  );
}
