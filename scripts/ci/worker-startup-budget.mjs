#!/usr/bin/env node
/**
 * API Worker startup budget. Cloudflare refuses a deploy whose global scope runs too long
 * (error 10021, "Script startup exceeded CPU time limit"): it hit the API Worker once after the
 * B2B merge and a plain re-dispatch got through, i.e. the Worker sits near the limit. This builds
 * the Worker the way `wrangler deploy` does (`--dry-run --outdir`), loads it in a local workerd
 * with the CPU profiler attached (100 us sampling) and fails when the measured startup CPU or the
 * bundle size crosses scripts/ci/worker-startup-budget.json.
 *
 * Why not `wrangler check startup`: it imports the bundle with NO vars bound, so config/index.ts
 * throws on JWT_SECRET (NODE_ENV=production) a few ms in and the profile never reaches the app
 * (measured 35 ms there vs 90 ms of real startup), and its 1.5 ms sampling is too coarse.
 *
 *   node scripts/ci/worker-startup-budget.mjs [--runs 5] [--config wrangler.jsonc] [--record out.json]
 *                                              [--baseline-ref origin/main]
 *
 * Two modes. ABSOLUTE (default, nightly/main on a quiet runner): startup CPU must stay under the
 * ceiling in the JSON. RELATIVE (`--baseline-ref`, pull requests): the base ref is built and
 * profiled in the SAME job on the SAME runner, samples alternate PR/base, and the PR fails only
 * when it is slower than the base by more than `relative.ratio` plus `relative.slackMs`. A loaded
 * shared runner slows both bundles alike, so the absolute ceiling (which flaked at 189 ms vs 140 ms
 * on a starved runner, 2026-10-25) is not applied to PRs. Bundle size is deterministic and stays an
 * absolute gate in both modes.
 *
 * No database and no Cloudflare login. The numbers are local-workerd CPU, not Cloudflare's: the
 * budget is a regression gate with headroom, not the platform limit.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'apps/api');

/** Active (non-idle) CPU in ms of a Chrome cpuprofile. */
export function activeMs(profile) {
  const idle = new Set(
    profile.nodes.filter(n => n.callFrame.functionName === '(idle)').map(n => n.id)
  );
  let us = 0;
  profile.samples.forEach((id, i) => {
    if (!idle.has(id)) us += profile.timeDeltas[i] ?? 0;
  });
  return us / 1000;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Verdict on a measurement against the budget; exported for the unit test. */
export function budgetProblems(measured, budget, { skipCpu = false } = {}) {
  const problems = [];
  const check = (key, label, unit) => {
    if (!(measured[key] <= budget[key]))
      problems.push(
        `${label} ${Math.round(measured[key])}${unit} is over the budget of ${budget[key]}${unit}`
      );
  };
  if (!skipCpu) check('startupCpuMs', 'startup CPU', ' ms');
  check('bundleBytes', 'bundle size', ' B');
  check('bundleGzipBytes', 'gzipped bundle size', ' B');
  return problems;
}

/** Relative verdict: the PR may be at most `ratio` + `slackMs` slower than the base measured beside it. */
export function relativeProblems(prMs, baseMs, { ratio, slackMs }) {
  if (!(prMs >= 0) || !(baseMs > 0))
    return [`startup CPU not measured (pr ${prMs}, base ${baseMs})`];
  const limit = baseMs * (1 + ratio) + slackMs;
  return prMs <= limit
    ? []
    : [
        `startup CPU ${Math.round(prMs)} ms is over ${Math.round(limit)} ms (base ${Math.round(baseMs)} ms x ${1 + ratio} + ${slackMs} ms, measured in this job)`,
      ];
}

// Fake values only: just enough for config/index.ts to pass its NODE_ENV=production checks.
const PROBE_BINDINGS = {
  NODE_ENV: 'production',
  WEB_URL: 'https://ebda.app',
  ADMIN_URL: 'https://store.ebda.app',
  API_URL: 'https://api.ebda.app',
  BUILD_COMMIT_SHA: 'budget',
  TRUST_PROXY_HOPS: '1',
  SEARCH_SEMANTIC_ENABLED: 'false',
  JWT_SECRET: 'budget-only-jwt-secret-0123456789abcdef',
  ENCRYPTION_KEY: '0'.repeat(64),
  TAP_API_KEY: 'k',
  TAP_SECRET_KEY: 's',
  TAP_WEBHOOK_SECRET: 'budget-only-tap-webhook-secret',
  INNGEST_EVENT_KEY: 'budget',
};

async function profileOnce(outdir, compat) {
  const { Miniflare } = await import('miniflare');
  const files = readdirSync(outdir);
  const mods = files
    .filter(f => f === 'worker.js' || f.endsWith('.wasm'))
    .map(f => ({
      type: f.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule',
      path: path.join(outdir, f),
    }));
  const mf = new Miniflare({
    name: 'profiler',
    compatibilityDate: compat.date,
    compatibilityFlags: compat.flags,
    modulesRoot: outdir,
    modules: [
      {
        type: 'ESModule',
        path: path.join(outdir, '__budget_entry.mjs'),
        contents: `export default { async fetch() {
          try { await import("./worker.js"); return new Response("ok"); }
          catch (e) { return new Response("ERR " + (e && e.stack || e), { status: 500 }); } } }`,
      },
      ...mods,
    ],
    bindings: PROBE_BINDINGS,
    inspectorPort: 0,
  });
  try {
    await mf.ready;
    const WS = globalThis.WebSocket ?? (await import('ws')).default;
    const ws = new WS(new URL('/core:user:profiler', (await mf.getInspectorURL()).href));
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    const stopped = new Promise(res =>
      ws.addEventListener('message', e => {
        const d = JSON.parse(e.data);
        if (d.id === 3) res(d.result.profile);
      })
    );
    ws.send(JSON.stringify({ id: 1, method: 'Profiler.enable' }));
    ws.send(
      JSON.stringify({ id: 4, method: 'Profiler.setSamplingInterval', params: { interval: 100 } })
    );
    ws.send(JSON.stringify({ id: 2, method: 'Profiler.start' }));
    const res = await mf.dispatchFetch('https://example.com');
    const body = await res.text();
    ws.send(JSON.stringify({ id: 3, method: 'Profiler.stop' }));
    const profile = await stopped;
    ws.close();
    // A Worker that throws while starting would measure only the part that ran: never a pass.
    if (!res.ok) throw new Error(`the Worker did not start: ${body.slice(0, 500)}`);
    return activeMs(profile);
  } finally {
    await mf.dispose();
  }
}

/** Build `ref` into a throwaway worktree that borrows this checkout's installed deps. Returns { dir, outdir }. */
function buildBaseline(ref, config) {
  const sh = (cmd, args, cwd = ROOT) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    if (r.status !== 0)
      throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const remoteRef = ref.replace(/^origin\//, '');
  if (ref.startsWith('origin/')) {
    // Shallow only inside Actions (CI's checkout is shallow already); never on a developer/agent repo.
    const shallow = process.env.GITHUB_ACTIONS === 'true' ? ['--depth=1'] : [];
    sh('git', ['fetch', '--no-tags', ...shallow, 'origin', remoteRef]);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'ebda-startup-base-'));
  sh('git', [
    'worktree',
    'add',
    '--detach',
    '--force',
    dir,
    ref.startsWith('origin/') ? 'FETCH_HEAD' : ref,
  ]);
  // Borrow installed deps and built workspace packages; only apps/api SOURCE differs from the PR.
  for (const rel of [
    'node_modules',
    'apps/api/node_modules',
    ...readdirSync(path.join(ROOT, 'packages')).flatMap(p => [
      `packages/${p}/node_modules`,
      `packages/${p}/dist`,
    ]),
  ]) {
    const from = path.join(ROOT, rel);
    const to = path.join(dir, rel);
    try {
      statSync(from);
      rmSync(to, { recursive: true, force: true });
      symlinkSync(from, to);
    } catch {
      /* absent in this checkout: nothing to borrow */
    }
  }
  const outdir = mkdtempSync(path.join(tmpdir(), 'ebda-startup-base-out-'));
  sh(
    'npx',
    ['wrangler', 'deploy', '--dry-run', '--config', config, '--outdir', outdir],
    path.join(dir, 'apps/api')
  );
  return { dir, outdir };
}

async function main() {
  const arg = n => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const runs = Number(arg('runs') ?? 5);
  const config = arg('config') ?? 'wrangler.jsonc';
  const budget = JSON.parse(
    readFileSync(path.join(ROOT, 'scripts/ci/worker-startup-budget.json'), 'utf8')
  );
  const outdir = mkdtempSync(path.join(tmpdir(), 'ebda-startup-budget-'));
  try {
    const built = spawnSync(
      'npx',
      ['wrangler', 'deploy', '--dry-run', '--config', config, '--outdir', outdir],
      {
        cwd: API,
        encoding: 'utf8',
      }
    );
    if (built.status !== 0)
      throw new Error(`wrangler dry-run failed:\n${built.stdout}\n${built.stderr}`);
    const bundle = path.join(outdir, 'worker.js');
    const bytes = statSync(bundle).size;
    const gzip = gzipSync(readFileSync(bundle)).length;
    const cfg = readFileSync(path.join(API, config), 'utf8');
    const compat = {
      date: /"compatibility_date":\s*"([^"]+)"/.exec(cfg)?.[1],
      flags: [
        ...(/"compatibility_flags":\s*\[([^\]]*)\]/.exec(cfg)?.[1] ?? '').matchAll(/"([^"]+)"/g),
      ].map(m => m[1]),
    };
    const baselineRef = arg('baseline-ref');
    let base;
    const samples = [];
    const baseSamples = [];
    try {
      if (baselineRef) base = buildBaseline(baselineRef, config);
      // Alternate PR/base so a load spike hits both, never just one side.
      for (let i = 0; i < runs; i++) {
        samples.push(await profileOnce(outdir, compat));
        if (base) baseSamples.push(await profileOnce(base.outdir, compat));
      }
    } finally {
      if (base) {
        spawnSync('git', ['worktree', 'remove', '--force', base.dir], { cwd: ROOT });
        rmSync(base.dir, { recursive: true, force: true });
        rmSync(base.outdir, { recursive: true, force: true });
      }
    }
    const measured = {
      // MIN of the runs: scheduler noise only ever adds CPU time, so the minimum is the stable estimate.
      startupCpuMs: Math.min(...samples),
      bundleBytes: bytes,
      bundleGzipBytes: gzip,
    };
    const record = {
      measured,
      samplesMs: samples.map(s => Math.round(s * 10) / 10),
      ...(base
        ? {
            baseline: {
              ref: baselineRef,
              startupCpuMs: Math.min(...baseSamples),
              samplesMs: baseSamples.map(s => Math.round(s * 10) / 10),
            },
          }
        : {}),
      budget: {
        startupCpuMs: budget.startupCpuMs,
        bundleBytes: budget.bundleBytes,
        bundleGzipBytes: budget.bundleGzipBytes,
      },
    };
    console.log(JSON.stringify(record, null, 2));
    const out = arg('record');
    if (out) writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      writeFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### API Worker startup budget\n\n| metric | measured | budget |\n|---|---|---|\n| startup CPU (min of ${runs}) | ${measured.startupCpuMs.toFixed(1)} ms | ${budget.startupCpuMs} ms |\n| bundle | ${bytes} B | ${budget.bundleBytes} B |\n| bundle gzip | ${gzip} B | ${budget.bundleGzipBytes} B |\n`,
        { flag: 'a' }
      );
    }
    const problems = [
      ...budgetProblems(measured, budget, { skipCpu: !!base }),
      ...(base
        ? relativeProblems(measured.startupCpuMs, record.baseline.startupCpuMs, budget.relative)
        : []),
    ];
    if (problems.length) {
      console.error(`Worker startup budget exceeded:\n- ${problems.join('\n- ')}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
}
