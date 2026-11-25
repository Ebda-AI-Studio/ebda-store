/**
 * SLOP-PREPUSH-1: scripts/ci/pre-push-slop.sh runs the CI "Slop baselines" guard before the push. Real script, real guard (.github/pr-quality/slop-guard.mjs),
 * a throwaway git repo whose `origin/main` is the base: a planted unused export blocks the push, a used or pq-allow'd one does not, a push with no .ts/.tsx
 * change skips, and the gate calls it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  it('the BASE export carries the vendored-folder proof (foundation.lock.json + its parity test), or the foundation exemption is OFF on every push', () => {
    // Without them in the base tree the guard reports "the base branch has no foundation.lock.json to trust" and every vendored export reads as a NEW violation.
    const src = readFileSync(SCRIPT, 'utf8');
    const baseExport = src.split('\n').find(l => l.startsWith('export_ref "$BASE_REF"')) ?? '';
    expect(baseExport).toContain('foundation.lock.json');
    expect(baseExport).toContain('tests/unit/foundation-parity.test.ts');
    const headExport = src.split('\n').find(l => l.startsWith('export_ref "$HEAD_REF"')) ?? '';
    expect(headExport).toContain('foundation.lock.json');
  });

  it('does not move HEAD or write refs/pr/head in the repo named by an inherited GIT_DIR (a pre-push hook exports it)', () => {
    const before = git('for-each-ref').trim() + git('symbolic-ref', 'HEAD').trim();
    spawnSync('bash', [SCRIPT, 'origin/main', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      // exactly what husky gives a hook: only GIT_DIR, exported
      env: { ...process.env, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: undefined },
    });
    expect(git('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature');
    expect(git('for-each-ref', 'refs/pr/').trim()).toBe('');
    expect(git('for-each-ref').trim() + git('symbolic-ref', 'HEAD').trim()).toBe(before);
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

describe('pre-push slop guard and the vendored-foundation exemption (SLOP-VENDORED-1)', () => {
  const DIRV = 'packages/shared/src/foundation';
  const PARITY = 'tests/unit/foundation-parity.test.ts';
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  let v: string;
  const vgit = (...a: string[]) =>
    execFileSync('git', a, {
      cwd: v,
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
  const vwrite = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(v, rel)), { recursive: true });
    writeFileSync(path.join(v, rel), body);
  };
  const vcommit = (m: string) => {
    vgit('add', '-A');
    vgit('commit', '-q', '-m', m);
  };
  const vrun = () =>
    spawnSync('bash', [SCRIPT, 'origin/main', 'HEAD'], {
      cwd: v,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    });
  const lockFor = (files: Record<string, string>, extra = {}) =>
    JSON.stringify({
      tag: 'v1.0.0',
      commit: 'a'.repeat(40),
      dir: DIRV,
      parity: PARITY,
      files: Object.fromEntries(Object.entries(files).map(([k, t]) => [k, sha(t)])),
      ...extra,
    });

  beforeAll(() => {
    v = mkdtempSync(path.join(tmpdir(), 'slop-prepush-vend-'));
    vgit('init', '-q', '-b', 'main');
    mkdirSync(path.join(v, '.github/pr-quality'), { recursive: true });
    for (const f of ['slop-guard.mjs', 'merge-base-tree.sh'])
      copyFileSync(path.join(REPO, '.github/pr-quality', f), path.join(v, '.github/pr-quality', f));
    vwrite(
      '.pr-quality.json',
      JSON.stringify({
        roots: ['apps', 'packages'],
        baseline: '.pr-quality-baseline.json',
        ruleExemptions: [
          {
            rule: 'unused-export',
            path: DIRV,
            reason: 'vendored foundation, byte-pinned by foundation.lock.json and the parity test',
            requires: PARITY,
          },
        ],
      })
    );
    vwrite('.pr-quality-baseline.json', JSON.stringify({ ids: [] }));
    const vendored = {
      [`${DIRV}/api.ts`]: 'export const VENDORED_UNUSED = 1;\n',
      [PARITY]: '// parity\n',
    };
    for (const [k, t] of Object.entries(vendored)) vwrite(k, t);
    vwrite('foundation.lock.json', lockFor(vendored));
    vwrite('apps/x/src/a.ts', 'export const used = 1;\n');
    vwrite('apps/x/src/index.ts', "import { used } from './a';\nconsole.warn(used);\n");
    vcommit('base');
    vgit('update-ref', 'refs/remotes/origin/main', 'HEAD');
    vgit('checkout', '-q', '-b', 'feature');
  });
  afterAll(() => rmSync(v, { recursive: true, force: true }));

  it('a push that leaves the lock alone keeps the vendored exemption (the base lock is part of the exported base)', () => {
    vwrite('apps/x/src/b.ts', "import { used } from './a';\nconsole.warn(used);\n");
    vcommit('a normal ts change');
    const r = vrun();
    expect(r.stderr).not.toContain('VENDORED_UNUSED');
    expect(r.stderr).not.toMatch(/ruleExemptions entry is OFF/);
    expect(r.status).toBe(0);
  });

  it('a push that edits the lock and a vendored file together gets no exemption and is blocked (cannot waive its own code)', () => {
    const evil = 'export const SNEAKED_IN = 1;\n';
    vwrite(`${DIRV}/api.ts`, evil);
    vwrite('foundation.lock.json', lockFor({ [`${DIRV}/api.ts`]: evil, [PARITY]: '// parity\n' }));
    vcommit('edit the vendored file and its lock');
    const r = vrun();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ruleExemptions entry is OFF/);
    expect(r.stderr).toContain('SNEAKED_IN');
  });
});
