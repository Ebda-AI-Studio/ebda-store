// The store's copies of the foundation guard scripts, exercised in CI: the PR gate runs from the BASE branch, so without these the code would
// first execute on the PR that follows its merge. Mirrors ebda-foundation test/pr-quality.test.ts.
// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPrBody,
  closedIssues,
  section,
  enforceFrom,
} from '../../.github/pr-quality/pr-body-check.mjs';
import { scan, compare, eslintGrowth } from '../../.github/pr-quality/slop-guard.mjs';

const GOOD =
  '## Verified\nnpm test green, 14 new tests\n\n## Not verified\nThe live deploy\n\n## Cost-if-wrong\nA red check until the secret exists\n';

describe('pr-body-check', () => {
  it('passes a complete body', () =>
    expect(checkPrBody({ body: GOOD, title: 'feat: x' })).toEqual([]));
  it('names every missing or placeholder section', () => {
    const p = checkPrBody({ body: '## Verified\nok\n## Not verified\nTBD\n', title: 'feat: x' });
    expect(p.join('\n')).toMatch(/missing section "## Cost-if-wrong"/);
    expect(p.join('\n')).toMatch(/"## Not verified" is empty or a placeholder/);
  });
  it('rejects hedges outside code blocks only', () => {
    expect(checkPrBody({ body: GOOD + 'This should work.', title: 'feat: x' }).join()).toMatch(
      /hedged claim/
    );
    expect(checkPrBody({ body: GOOD + '```\nshould work\n```\n', title: 'feat: x' })).toEqual([]);
  });
  it('a fix needs a mutation check and a test file in the diff', () => {
    expect(checkPrBody({ body: GOOD, title: 'fix(api): y', files: ['a.ts'] }).length).toBe(2);
    const body =
      GOOD + '## Mutation check\nreverted the guard: test X failed with "expected 1 got 2"\n';
    expect(checkPrBody({ body, title: 'fix(api): y', files: ['a.ts', 'a.test.ts'] })).toEqual([]);
    expect(
      checkPrBody({ body, title: 'chore: y', branch: 'fix/z', files: ['a.ts'] }).join()
    ).toMatch(/no test file/);
  });
  it('closing a review-finding needs a checked Test naming a diff test and a Foundation reference', () => {
    const files = ['apps/api/x.ts', 'apps/api/x.test.ts'];
    expect(checkPrBody({ body: GOOD, title: 'feat: x', files, linkedFindings: [7] }).length).toBe(
      2
    );
    const ok =
      GOOD + '- [x] Test: apps/api/x.test.ts\n- [x] Foundation: os/standard/pr-quality.md\n';
    expect(checkPrBody({ body: ok, title: 'feat: x', files, linkedFindings: [7] })).toEqual([]);
    const wrong = GOOD + '- [x] Test: other.test.ts\n- [ ] Foundation: os/standard/pr-quality.md\n';
    expect(checkPrBody({ body: wrong, title: 'feat: x', files, linkedFindings: [7] }).length).toBe(
      2
    );
  });
  it('closedIssues reads Fixes/Closes/Resolves', () => {
    expect(closedIssues('Fixes #3, closes #4 and resolved #3. See #9')).toEqual([3, 4]);
  });
  it('section ignores html comments', () =>
    expect(section('## Verified\n<!-- what -->\n', 'Verified')).toBe(''));
});

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'pq-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}
const big = (n: string) =>
  `export function ${n}(a: number, b: number) {\n  const total = a * 100 + b;\n  const rounded = Math.round(total) / 100;\n  if (rounded < 0) return 0;\n  if (rounded > 1000000) throw new Error('amount out of range for a single order');\n  if (Number.isNaN(rounded)) throw new Error('amount is not a number');\n  return rounded;\n}\n`;
const ids = (root: string, cfg = {}) =>
  [...scan({ root, config: { roots: ['apps'], ...cfg } }).keys()] as string[];

describe('slop-guard', () => {
  it('flags any, console.log, bare TODO; honours pq-allow and issue-linked TODO', () => {
    const root = repo({
      'apps/a/src/x.ts':
        'const a: any = 1;\nconsole.log(a);\n// TODO fix\n// TODO(#12) later\n// pq-allow(no-any): upstream type\nconst b: any = 2;\nexport const used = 1;\n',
      'apps/a/src/y.ts': 'import { used } from "./x";\nused;\n',
    });
    const r = ids(root)
      .map(i => i.split('|')[0])
      .sort();
    expect(r).toEqual(['no-any', 'no-console', 'todo-no-issue']);
  });
  it('ignores test files', () => {
    expect(ids(repo({ 'apps/a/src/x.test.ts': 'const a: any = 1; console.log(a);\n' }))).toEqual(
      []
    );
  });
  it('flags an export nothing else imports, but not one a sibling imports or a framework name', () => {
    const root = repo({
      'apps/a/src/x.ts': 'export const dead = 1;\nexport const alive = 2;\nexport const GET = 3;\n',
      'apps/a/src/y.ts': 'import { alive } from "./x";\nalive;\n',
      'apps/a/src/x.test.ts': 'import { dead } from "./x";\ndead;\n',
    });
    expect(ids(root)).toEqual(['unused-export|apps/a/src/x.ts|dead']);
  });
  it('flags the same function body in two files, not a one-off', () => {
    const root = repo({
      'apps/a/src/a.ts': big('roundMoney') + 'export const k = roundMoney;\n',
      'apps/b/src/b.ts': big('roundMoney') + 'export const m = roundMoney;\n',
      'apps/c/src/c.ts': big('other').replace('* 100', '* 7'),
    });
    expect(ids(root).filter(i => i.startsWith('duplicate-helper')).length).toBe(2);
  });
  it('flags emoji in locale copy but not (c)', () => {
    const root = repo({ 'apps/a/messages/ar.json': '{\n"a": "مرحبا 🎉",\n"b": "© 2026"\n}\n' });
    expect(ids(root, { locales: ['apps/a/messages'] }).map(i => i.split('|')[0])).toEqual([
      'emoji-copy',
    ]);
  });
  it('compare: new ids fail, fixed ids go stale', () => {
    const cur = new Map([
      ['a', ''],
      ['b', ''],
    ]);
    expect(compare(cur, ['b', 'c'])).toEqual({ added: ['a'], stale: ['c'] });
  });
  it('CLI: --update refuses to add, shrinks when fixed, check fails on stale', () => {
    const root = repo({
      'apps/a/src/x.ts': 'const a: any = 1;\nexport const u = a;\n',
      'apps/a/src/y.ts': 'u;\n',
    });
    const cli = join(__dirname, '../../.github/pr-quality/slop-guard.mjs');
    const run = (...a: string[]) =>
      spawnSync('node', [cli, '--root', root, ...a], { encoding: 'utf8' });
    writeFileSync(join(root, '.pr-quality.json'), '{"roots":["apps"]}');
    expect(run('--update').status).toBe(1); // no baseline: needs --init
    expect(run('--update', '--init').status).toBe(0);
    expect(run().status).toBe(0);
    writeFileSync(join(root, 'apps/a/src/z.ts'), 'const q: any = 1;\nexport const r = q;\n');
    writeFileSync(join(root, 'apps/a/src/w.ts'), 'r;\n');
    expect(run().status).toBe(1); // new any
    expect(run('--update').status).toBe(1); // cannot launder it into the baseline
    writeFileSync(join(root, 'apps/a/src/x.ts'), 'const a = 1;\nexport const u = a;\n');
    writeFileSync(join(root, 'apps/a/src/z.ts'), 'const q = 1;\nexport const r = q;\n');
    const stale = run();
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/FIXED but still in the baseline/);
    expect(run('--update').status).toBe(0);
    expect(run().status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, '.pr-quality-baseline.json'), 'utf8')).ids).toEqual(
      []
    );
  });
});

describe('base-branch enforcement', () => {
  const cli = join(__dirname, '../../.github/pr-quality/slop-guard.mjs');
  const guard = (pr: string, base: string) =>
    spawnSync('node', [cli, '--root', pr, '--base-root', base], { encoding: 'utf8' });
  const src = (n: number) => `const a${n}: any = 1;\nexport const u${n} = a${n};\n`;
  const use = (n: number) => `u${n};\n`;
  const cfg = '{"roots":["apps"]}';
  function seed(n: number) {
    // a repo with n baselined `any` violations
    const files: Record<string, string> = { '.pr-quality.json': cfg };
    for (let i = 0; i < n; i++) {
      files[`apps/a/src/f${i}.ts`] = src(i);
      files[`apps/a/src/g${i}.ts`] = use(i);
    }
    const root = repo(files);
    spawnSync('node', [cli, '--root', root, '--update', '--init']);
    files['.pr-quality-baseline.json'] = readFileSync(
      join(root, '.pr-quality-baseline.json'),
      'utf8'
    );
    return { root, files };
  }
  it('a PR that adds a violation AND edits its own baseline to hide it still fails against the base', () => {
    const b = seed(1);
    const pr = repo({ ...b.files, 'apps/a/src/f9.ts': src(9), 'apps/a/src/g9.ts': use(9) });
    rmSync(join(pr, '.pr-quality-baseline.json'));
    spawnSync('node', [cli, '--root', pr, '--update', '--init']); // the PR "re-takes" its baseline: now self-consistent
    expect(spawnSync('node', [cli, '--root', pr], { encoding: 'utf8' }).status).toBe(0); // the old check alone is fooled
    const r = guard(pr, b.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/baseline holds an id the base branch's does not|NEW vs the base/);
  });
  it('a PR that fixes a violation and shrinks its baseline passes', () => {
    const b = seed(2);
    const files = { ...b.files };
    delete files['apps/a/src/f1.ts'];
    delete files['apps/a/src/g1.ts'];
    const pr = repo(files);
    spawnSync('node', [cli, '--root', pr, '--update']);
    expect(guard(pr, b.root).status).toBe(0);
  });
  it('base config wins: a PR cannot narrow roots to skip files', () => {
    const b = seed(1);
    const pr = repo({ ...b.files, '.pr-quality.json': '{"roots":["nowhere"]}' });
    spawnSync('node', [
      cli,
      '--root',
      pr,
      '--update',
      '--init',
      '--config',
      join(pr, '.pr-quality.json'),
    ]);
    expect(guard(pr, b.root).status).toBe(1); // base roots scan apps/: the violation still counts and the baseline no longer matches
  });
  it('eslint suppressions may not grow vs the base; a moved file with the same total is fine', () => {
    const sup = (n: number, file = 'src/a.ts') =>
      JSON.stringify({ [file]: { 'no-console': { count: n } } });
    const base = repo({ 'apps/a/eslint-suppressions.json': sup(3) });
    expect(
      eslintGrowth(repo({ 'apps/a/eslint-suppressions.json': sup(4) }), base, ['apps'])
    ).toHaveLength(1);
    expect(
      eslintGrowth(repo({ 'apps/a/eslint-suppressions.json': sup(2) }), base, ['apps'])
    ).toEqual([]);
    expect(
      eslintGrowth(repo({ 'apps/a/eslint-suppressions.json': sup(3, 'src/moved.ts') }), base, [
        'apps',
      ])
    ).toEqual([]);
    expect(
      eslintGrowth(repo({ 'apps/b/eslint-suppressions.json': sup(1) }), base, ['apps'])
    ).toHaveLength(1); // a new workspace file cannot launder
    expect(
      eslintGrowth(
        repo({ 'apps/a/eslint-suppressions.json': sup(9) }),
        repo({ 'apps/a/x.ts': '' }),
        ['apps']
      )
    ).toEqual([]); // base has none: adoption
  });
});

describe('pr-body grace period', () => {
  it('enforceFrom reads the config date; unset or unreadable means enforce now', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'pqc-')), 'c.json');
    writeFileSync(f, '{"bodyCheckEnforceFrom":"2099-01-01"}');
    expect(enforceFrom(f)).toBe(Date.parse('2099-01-01'));
    writeFileSync(f, '{}');
    expect(enforceFrom(f)).toBeNull();
    expect(enforceFrom(join(tmpdir(), 'does-not-exist.json'))).toBeNull();
  });
  it('CLI: a bad body only warns (exit 0) before the date and fails (exit 1) after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pqc-'));
    const run = (date: string) => {
      writeFileSync(join(dir, 'c.json'), JSON.stringify({ bodyCheckEnforceFrom: date }));
      return spawnSync('node', [join(__dirname, '../../.github/pr-quality/pr-body-check.mjs')], {
        env: {
          PATH: process.env.PATH ?? '',
          PR_BODY: 'no sections',
          PR_TITLE: 'feat: x',
          PR_QUALITY_CONFIG: join(dir, 'c.json'),
        },
        encoding: 'utf8',
      });
    };
    const before = run('2099-01-01');
    expect(before.status).toBe(0);
    expect(before.stderr).toMatch(/::warning::pr-body \(warn-only until 2099-01-01\)/);
    expect(run('2000-01-01').status).toBe(1);
  });
});

describe('symlinks never leave the checkout', () => {
  const cli = join(__dirname, '../../.github/pr-quality/slop-guard.mjs');
  it('a symlinked directory or file inside the scan roots is not followed', () => {
    const outside = repo({
      'secret/x.ts': 'const leaked: any = 1;\nconsole.log(leaked);\n',
      'secret/y.ts': 'export const nothing = 1;\n',
    });
    const root = repo({
      'apps/a/src/ok.ts': 'export const fine = 1;\n',
      'apps/a/src/use.ts': 'fine;\n',
    });
    symlinkSync(join(outside, 'secret'), join(root, 'apps/a/src/linked'));
    symlinkSync(join(outside, 'secret/x.ts'), join(root, 'apps/a/src/file-link.ts'));
    expect(ids(root)).toEqual([]);
  });
  it('a symlinked scan root is skipped', () => {
    const outside = repo({ 'a/src/x.ts': 'console.log(1);\n' });
    const root = repo({ 'keep.txt': '' });
    symlinkSync(outside, join(root, 'apps'));
    expect(ids(root)).toEqual([]);
  });
  it('a symlinked baseline or config is refused, and the error never echoes the target file', () => {
    const outside = repo({ 'secret.json': '{"password": "hunter2-do-not-print"' });
    const root = repo({ 'apps/a/src/x.ts': 'export const k = 1;\n' });
    symlinkSync(join(outside, 'secret.json'), join(root, '.pr-quality-baseline.json'));
    const r = spawnSync('node', [cli, '--root', root], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2/);
    expect(r.stderr).toMatch(/symlink: refused/);
  });
  it('a symlinked eslint-suppressions.json is not read', () => {
    const outside = repo({ 's.json': '{"x.ts":{"no-console":{"count":99}}}' });
    const base = repo({ 'apps/a/eslint-suppressions.json': '{"x.ts":{"no-console":{"count":1}}}' });
    const pr = repo({ 'apps/a/x.ts': '' });
    symlinkSync(join(outside, 's.json'), join(pr, 'apps/a/eslint-suppressions.json'));
    expect(() => eslintGrowth(pr, base, ['apps'])).not.toThrow();
    expect(eslintGrowth(pr, base, ['apps'])).toEqual([]);
  });
});

describe('pr-quality.yml leaves nothing of a fork on a self-hosted runner', () => {
  it('the slop job ends with an always() step that removes the pr/ checkout', () => {
    const wf = readFileSync('.github/workflows/pr-quality.yml', 'utf8');
    const job = wf.slice(wf.indexOf('  slop-baselines:'));
    const tail = job.slice(job.lastIndexOf('- name: Remove the checkouts'));
    expect(tail).toMatch(/if: always\(\)/);
    expect(tail).toMatch(/rm -rf "\$GITHUB_WORKSPACE\/pr"/);
  });
});
