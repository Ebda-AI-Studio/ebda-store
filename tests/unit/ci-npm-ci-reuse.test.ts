/**
 * Ruling CI-NODE-MODULES-1: self-hosted jobs reuse a pristine node_modules store; hosted jobs run plain `npm ci`;
 * no remote Actions cache ever runs on self-hosted.
 */
import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WF = path.join(ROOT, '.github/workflows');
const SCRIPT = path.join(ROOT, 'scripts/ci/npm-ci-reuse.sh');
const ci = readFileSync(path.join(WF, 'ci.yml'), 'utf8');
const files = readdirSync(WF).filter(f => /\.ya?ml$/.test(f));

describe('workflow wiring', () => {
  it('ci.yml installs only through the composite action (no bare npm ci)', () => {
    const bare = ci.split('\n').filter(l => /^\s*(-\s+)?run:\s*npm ci\b/.test(l));
    expect(bare).toEqual([]);
    expect((ci.match(/uses: \.\/\.github\/actions\/npm-ci/g) ?? []).length).toBeGreaterThanOrEqual(
      18
    );
  });
  it('the action passes EBDA_RUNS_ON and calls the script', () => {
    const a = readFileSync(path.join(ROOT, '.github/actions/npm-ci/action.yml'), 'utf8');
    // Composite actions cannot read the `vars` context (runner rejects the file); derive from runner type.
    expect(a).not.toMatch(/\$\{\{[^}]*\bvars\./);
    expect(a).toMatch(/EBDA_RUNS_ON: \$\{\{ runner\.environment == 'self-hosted'/);
    expect(a).toMatch(/bash scripts\/ci\/npm-ci-reuse\.sh/);
  });
  it('no actions/cache anywhere; setup-node cache is hosted-only', () => {
    for (const f of files.concat(['../actions/npm-ci/action.yml'])) {
      const t = readFileSync(path.join(WF, f), 'utf8');
      expect(t, f).not.toMatch(/uses:\s*actions\/cache/);
      for (const m of t.matchAll(/^\s*cache:\s*(.*)$/gm)) {
        // Heavy jobs test EBDA_RUNS_ON; light jobs (Ruling CI-SPLIT-1) test the selector they actually run on.
        expect(
          [
            "${{ vars.EBDA_RUNS_ON == '' && 'npm' || '' }}",
            "${{ ((vars.EBDA_RUNS_ON_LIGHT || vars.EBDA_RUNS_ON) == '' || (vars.EBDA_RUNS_ON_LIGHT || vars.EBDA_RUNS_ON) == '\"ubuntu-24.04\"') && 'npm' || '' }}",
          ],
          `${f}: setup-node cache`
        ).toContain(m[1].trim());
      }
    }
  });
  it('the script is plain npm ci when EBDA_RUNS_ON is empty (first executable branch)', () => {
    const s = readFileSync(SCRIPT, 'utf8');
    expect(s).toMatch(/if \[ -z "\$\{EBDA_RUNS_ON:-\}" \]; then exec npm ci; fi/);
    expect(s).not.toMatch(/actions\/cache/);
  });
});

function project() {
  const d = mkdtempSync(path.join(tmpdir(), 'nmreuse-'));
  mkdirSync(path.join(d, 'bin'));
  mkdirSync(path.join(d, 'proj/apps/web'), { recursive: true });
  writeFileSync(path.join(d, 'proj/package-lock.json'), '{"v":1}');
  // fake npm: `ci` creates node_modules (root + workspace + a prisma dir); `ls` succeeds unless FAIL_LS is set.
  const npm = `#!/bin/bash
echo "$1" >> "${d}/npm.log"
if [ "$1" = ci ]; then mkdir -p node_modules/.prisma/client node_modules/dep apps/web/node_modules/x
  echo pristine > node_modules/dep/index.js; echo pristine > node_modules/.prisma/client/i.js; echo w > apps/web/node_modules/x/i.js; fi
if [ "$1" = ls ] && [ -n "$FAIL_LS" ]; then exit 1; fi
exit 0
`;
  writeFileSync(path.join(d, 'bin/npm'), npm);
  chmodSync(path.join(d, 'bin/npm'), 0o755);
  return d;
}
function run(d: string, env: Record<string, string>) {
  return spawnSync('bash', [SCRIPT], {
    cwd: path.join(d, 'proj'),
    env: {
      ...process.env,
      PATH: `${d}/bin:${process.env.PATH}`,
      EBDA_NM_STORE: path.join(d, 'store'),
      ...env,
    },
    encoding: 'utf8',
  });
}
const npmCalls = (d: string) =>
  existsSync(`${d}/npm.log`) ? readFileSync(`${d}/npm.log`, 'utf8').trim().split('\n') : [];

describe('npm-ci-reuse.sh behaviour (fake npm)', () => {
  it('hosted: plain npm ci, no store written', () => {
    const d = project();
    const r = run(d, { EBDA_RUNS_ON: '' });
    expect(r.status).toBe(0);
    expect(npmCalls(d)).toEqual(['ci']);
    expect(existsSync(path.join(d, 'store'))).toBe(false);
  });
  it('self-hosted: miss installs + saves; hit skips npm ci and never aliases mutable dirs', () => {
    const d = project();
    const env = { EBDA_RUNS_ON: '["umbra-ebda"]' };
    expect(run(d, env).status).toBe(0);
    expect(npmCalls(d)).toEqual(['ci']);
    // second job (fresh checkout): remove trees, restore from store
    spawnSync('rm', [
      '-rf',
      path.join(d, 'proj/node_modules'),
      path.join(d, 'proj/apps/web/node_modules'),
    ]);
    const r = run(d, env);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/restored from store/);
    expect(npmCalls(d)).toEqual(['ci', 'ls']);
    // a job rewriting prisma output / a plain dep file must not touch the store
    const gen = path.join(d, 'proj/node_modules/.prisma/client/i.js');
    writeFileSync(gen, 'generated');
    expect(statSync(gen).nlink).toBe(1);
    const storeFile = spawnSync(
      'bash',
      ['-c', `cat ${d}/store/*/tree/node_modules/.prisma/client/i.js`],
      { encoding: 'utf8' }
    );
    expect(storeFile.stdout.trim()).toBe('pristine');
    expect(statSync(path.join(d, 'proj/node_modules/dep/index.js')).nlink).toBeGreaterThan(1);
  });
  it('self-hosted: failed npm ls after restore falls back to npm ci', () => {
    const d = project();
    const env = { EBDA_RUNS_ON: 'x' };
    run(d, env);
    const r = run(d, { ...env, FAIL_LS: '1' });
    expect(r.status).toBe(0);
    expect(npmCalls(d)).toEqual(['ci', 'ls', 'ci']);
  });
  it('NZ-D21: main never reuses a tree a PR job saved or touched (separate lane keys)', () => {
    const d = project();
    const pr = {
      EBDA_RUNS_ON: 'x',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/pull/1/merge',
    };
    const main = { EBDA_RUNS_ON: 'x', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
    run(d, pr);
    const rm = () =>
      spawnSync('rm', [
        '-rf',
        path.join(d, 'proj/node_modules'),
        path.join(d, 'proj/apps/web/node_modules'),
      ]);
    rm();
    expect(run(d, main).stdout).not.toMatch(/restored from store/); // PR tree is invisible to main
    expect(npmCalls(d)).toEqual(['ci', 'ci']);
    rm();
    expect(run(d, main).stdout).toMatch(/restored from store/); // main reuses its own lane
    rm();
    expect(run(d, pr).stdout).toMatch(/restored from store/);
  });
  it('NZ-D21: the save claims the key with an atomic mkdir (no test-then-mv race, no nested tree)', () => {
    const s = readFileSync(SCRIPT, 'utf8');
    expect(s).toMatch(/mkdir "\$DIR" 2>\/dev\/null \|\| \{ rm -rf "\$TMP"; return 0; \}/);
    expect(s).not.toMatch(/if \[ -d "\$DIR" \]; then rm -rf "\$TMP"; else mv/);
  });
  it('NZ-D21: a key another job already claimed is left alone and the loser tree is dropped', () => {
    const d = project();
    const env = { EBDA_RUNS_ON: 'x' };
    run(d, env);
    const key = readdirSync(path.join(d, 'store')).filter(k => !k.startsWith('.'))[0];
    spawnSync('rm', ['-f', path.join(d, 'store', key, '.complete')]); // key exists but is not usable yet
    writeFileSync(path.join(d, 'store', key, 'marker'), 'winner');
    // a concurrent saver finds the key taken: no nesting inside it
    const r = run(d, env);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(d, 'store', key, `.tmp-${key}`))).toBe(false);
    expect(readdirSync(path.join(d, 'store')).filter(k => k.startsWith('.tmp-'))).toEqual([]);
  });
  it('keeps at most EBDA_NM_KEEP keys', () => {
    const d = project();
    const env = { EBDA_RUNS_ON: 'x', EBDA_NM_KEEP: '2' };
    for (const v of ['1', '2', '3']) {
      writeFileSync(path.join(d, 'proj/package-lock.json'), `{"v":${v}}`);
      run(d, env);
      spawnSync('sleep', ['1']);
    }
    const keys = readdirSync(path.join(d, 'store')).filter(k => !k.startsWith('.'));
    expect(keys.length).toBe(2);
  });
});
