/**
 * SLOP-PREPUSH-1: scripts/ci/pre-push-slop.sh runs the CI "Slop baselines" guard before the push. Real script, real guard (.github/pr-quality/slop-guard.mjs),
 * a throwaway git repo whose `origin/main` is the base: a planted unused export blocks the push, a used or pq-allow'd one does not, a push with no .ts/.tsx
 * change skips, and the gate calls it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO, 'scripts/ci/pre-push-slop.sh');
let dir: string;

const git = (...a: string[]) =>
  execFileSync('git', a, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
const write = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
};
const commit = (msg: string) => {
  git('add', '-A');
  git('commit', '-q', '-m', msg);
};
const run = () =>
  spawnSync('bash', [SCRIPT, 'origin/main', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'slop-prepush-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.github/pr-quality'), { recursive: true });
  copyFileSync(
    path.join(REPO, '.github/pr-quality/slop-guard.mjs'),
    path.join(dir, '.github/pr-quality/slop-guard.mjs')
  );
  // CI also builds the merge-base reference tree with the base branch's script; the hook must do the same
  copyFileSync(
    path.join(REPO, '.github/pr-quality/merge-base-tree.sh'),
    path.join(dir, '.github/pr-quality/merge-base-tree.sh')
  );
  write(
    '.pr-quality.json',
    JSON.stringify({ roots: ['apps'], baseline: '.pr-quality-baseline.json' })
  );
  write('.pr-quality-baseline.json', JSON.stringify({ ids: [] }));
  write('apps/x/src/a.ts', 'export const used = 1;\n');
  write('apps/x/src/index.ts', "import { used } from './a';\nconsole.warn(used);\n");
  commit('base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pre-push slop guard (same check as CI "Slop baselines")', () => {
  it('skips when no .ts/.tsx changed', () => {
    write('README.md', '# hi\n');
    commit('docs only');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no .ts/.tsx change');
  });

  it("BLOCKS a planted unused export, with the guard's own message", () => {
    write('apps/x/src/planted.ts', 'export const unusedThing = 2;\n');
    commit('plant an unused export');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/slop-guard: NEW/);
    expect(r.stderr).toContain('unused-export');
    expect(r.stderr).toContain('apps/x/src/planted.ts');
    expect(r.stderr).toContain('pq-allow(<rule>): <reason>');
    expect(r.stderr).toContain('BLOCKED');
  });

  it('passes once the export is used', () => {
    write(
      'apps/x/src/index.ts',
      "import { used } from './a';\nimport { unusedThing } from './planted';\nconsole.warn(used, unusedThing);\n"
    );
    commit('use it');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('slop-guard: ok');
  });

  it('passes with an inline pq-allow(unused-export) justification', () => {
    write(
      'apps/x/src/allowed.ts',
      '// pq-allow(unused-export): public API for a consumer outside the roots\nexport const publicApi = 3;\n'
    );
    commit('allowed export');
    expect(run().status).toBe(0);
  });

  it('blocks a console.log added in the pushed head too (every CI slop rule runs, not only unused-export)', () => {
    write('apps/x/src/noisy.ts', 'export function noisy() { console.log("x"); }\n');
    write(
      'apps/x/src/index.ts',
      "import { used } from './a';\nimport { unusedThing } from './planted';\nimport { noisy } from './noisy';\nconsole.warn(used, unusedThing, noisy);\n"
    );
    commit('noisy');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no-console');
  });

  it('runs in CI form: the guard gets --merge-base-root with a merge-base tree built by merge-base-tree.sh', () => {
    const r = run();
    expect(r.stdout).toMatch(
      /slop-guard\.mjs --root <tmp>\/pr --base-root <tmp>\/base --merge-base-root <tmp>\/mb/
    );
    expect(r.stdout).not.toContain('merge-base tree not built');
  });

  it('an export imported ONLY by a test file is not a use: it fails here exactly as it does in CI (negative control)', () => {
    write('apps/x/src/testOnly.ts', 'export const onlyForTests = 4;\n');
    write(
      'apps/x/src/testOnly.test.ts',
      "import { onlyForTests } from './testOnly';\nconsole.warn(onlyForTests);\n"
    );
    commit('export used only by a test');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unused-export');
    expect(r.stderr).toContain('apps/x/src/testOnly.ts');
  });

  it('skips with a note, never fails, when the base ref is missing (CI is the gate)', () => {
    const r = spawnSync('bash', [SCRIPT, 'origin/nope', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skipped');
  });

  it('the pre-push gate calls it, before the related-test step', () => {
    const gate = readFileSync(path.join(REPO, 'scripts/ci/pre-push-extra.sh'), 'utf8');
    expect(gate).toContain('bash scripts/ci/pre-push-slop.sh origin/main HEAD');
    expect(gate.indexOf('pre-push-slop.sh')).toBeLessThan(gate.indexOf('Cheap related tests'));
  });
});
