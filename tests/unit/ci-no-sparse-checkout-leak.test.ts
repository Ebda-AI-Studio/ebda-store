/**
 * Sparse-checkout leak on the persistent self-hosted workspace (2026-09-30).
 *
 * A (since removed) deploy workflow's hourly probe used `actions/checkout` with
 * `sparse-checkout`. On a self-hosted runner the workspace `.git` survives the
 * job, so core.sparseCheckout stayed on, and the next job's PLAIN checkout
 * reused it: the orders PWA deploy got a tree of only `.git` + `scripts/` and
 * failed `npm ci` (no package-lock.json) twice on fwb-ci6-force-website-builder-2.
 *
 * Two layers, both pinned here:
 *   1. No workflow uses sparse-checkout at all (the leak's source).
 *   2. Every self-hosted checkout job's pre-checkout guard DISABLES any
 *      inherited sparse config before checkout — so a leak from anywhere
 *      (a future sparse job, a manual run on the box) cannot poison a job.
 *      Proven by running the guard's own script against a real sparse repo.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const WF_DIR = join(__dirname, '../../.github/workflows');
const GUARD_NAME = 'Remove root-owned trufflehog scratch (pre-checkout guard, issue 1883)';

type Step = { uses?: string; name?: string; run?: string; with?: Record<string, unknown> };
type Job = { 'runs-on'?: unknown; steps?: Step[] };
const files = readdirSync(WF_DIR).filter(f => /\.ya?ml$/.test(f));
const docs = files.map(f => ({
  file: f,
  raw: readFileSync(join(WF_DIR, f), 'utf8'),
  jobs: ((yaml.load(readFileSync(join(WF_DIR, f), 'utf8')) as { jobs?: Record<string, Job> })
    .jobs ?? {}) as Record<string, Job>,
}));

const isCheckout = (s: Step) =>
  typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@');

describe('no workflow uses sparse-checkout (the leak source)', () => {
  it.each(docs.map(d => [d.file, d] as const))('%s', (_f, d) => {
    for (const [name, job] of Object.entries(d.jobs)) {
      for (const s of job.steps ?? []) {
        if (!isCheckout(s)) continue;
        expect(
          s.with?.['sparse-checkout'],
          `${name}: sparse-checkout persists in a self-hosted workspace`
        ).toBeUndefined();
      }
    }
    expect(d.raw).not.toMatch(/git sparse-checkout set|git sparse-checkout init/);
  });
});

const guarded: Array<[string, Step]> = [];
for (const d of docs) {
  for (const [name, job] of Object.entries(d.jobs)) {
    if (!JSON.stringify(job['runs-on'] ?? '').includes('self-hosted')) continue;
    const steps = job.steps ?? [];
    const co = steps.findIndex(isCheckout);
    if (co === -1) continue;
    const g = steps.findIndex(s => s.name === GUARD_NAME);
    guarded.push([`${d.file} / ${name}`, g > -1 && g < co ? steps[g] : ({} as Step)]);
  }
}

describe('every self-hosted checkout job disables an inherited sparse config before checkout', () => {
  it('found jobs to check (guards against an empty-set pass)', () => {
    expect(guarded.length).toBeGreaterThan(0);
  });
  it.each(guarded)('%s', (_label, guard) => {
    expect(guard.run, 'no pre-checkout guard before checkout').toBeTruthy();
    expect(guard.run).toMatch(/git sparse-checkout disable/);
    // The sparse reset must come before the guard's early `exit 0`.
    expect(guard.run!.indexOf('sparse-checkout disable')).toBeLessThan(
      guard.run!.indexOf('exit 0')
    );
  });
});

describe('the guard script really un-sparses a leaked workspace', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

  /** Strip every GIT_* var so a hook's GIT_DIR/GIT_INDEX_FILE cannot leak in. */
  function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    return {
      ...env,
      HOME: tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    };
  }

  it('reproduces the leak, then the guard restores the full tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparse-leak-'));
    dirs.push(dir);
    const env = cleanEnv();
    const git = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/probe.sh'), 'echo hi\n');
    writeFileSync(join(dir, 'package-lock.json'), '{}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'x');
    // What the sparse probe job left behind.
    git('sparse-checkout', 'set', '--no-cone', 'scripts/probe.sh');
    expect(existsSync(join(dir, 'package-lock.json')), 'leak not reproduced').toBe(false);

    const guard = guarded[0][1];
    const r = spawnSync('bash', ['-c', guard.run!], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(dir, 'package-lock.json'))).toBe(true);
    const cfg = spawnSync('git', ['config', '--get', 'core.sparseCheckout'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    expect(cfg.stdout.trim()).not.toBe('true');
  });
});
