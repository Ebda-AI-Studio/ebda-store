// Store copy of ebda-foundation test/ai-review-pass-marker.test.ts: the gate runs from the base branch, so its code is exercised here in CI first.
// @ts-nocheck
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), '.github/ai-review/pass-marker.mjs');
const WF = readFileSync(join(process.cwd(), '.github/workflows/ai-review.yml'), 'utf8');

// A node stub for `gh` over two files: LABELS (one per line) and COMMENTS (JSONL {id, login, body}). The diff comes from REAL git repos.
const GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), d = process.env.STUB_DIR;
const read = (f) => (fs.existsSync(d + '/' + f) ? fs.readFileSync(d + '/' + f, 'utf8') : '');
const write = (f, s) => fs.writeFileSync(d + '/' + f, s);
const log = (s) => fs.appendFileSync(d + '/calls.log', s + '\\n');
const comments = () => read('COMMENTS').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(read('LABELS'));
else if (a[0] === 'pr' && a[1] === 'edit') { log('edit ' + a.slice(3).join(' ')); if (a[3] === '--remove-label') write('LABELS', read('LABELS').split('\\n').filter((l) => l && l !== a[4]).join('\\n') + '\\n'); }
else if (a[0] === 'api' && a.includes('--paginate')) process.stdout.write(comments().map((c) => JSON.stringify(c)).join('\\n') + '\\n');
else if (a[0] === 'api' && a.includes('POST')) { const body = a[a.indexOf('-f') + 1].replace(/^body=/, ''); const c = comments(); c.push({ id: c.length + 1, login: 'github-actions[bot]', body }); write('COMMENTS', c.map((x) => JSON.stringify(x)).join('\\n') + '\\n'); log('post'); }
else if (a[0] === 'api' && a.includes('PATCH')) { const id = Number(a[a.length - 3].split('/').pop()); const body = a[a.indexOf('-f') + 1].replace(/^body=/, ''); write('COMMENTS', comments().map((x) => JSON.stringify(x.id === id ? { ...x, body } : x)).join('\\n') + '\\n'); log('patch ' + id); }
else { console.error('stub gh: unhandled ' + a.join(' ')); process.exit(9); }
`;

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
let dir = '',
  O = '',
  W = '';
const sh = (cwd: string, ...a: string[]) =>
  execFileSync('git', [...ID, ...a], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
const file = (rel: string, body: string, cwd = W) => writeFileSync(join(cwd, rel), body);
const commit = (msg: string) => {
  sh(W, 'add', '-A');
  sh(W, 'commit', '-q', '-m', msg);
  return sh(W, 'rev-parse', 'HEAD');
};
const lines = (n: number, tweak?: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => tweak?.(i) ?? `line ${i}`).join('\n') + '\n';
/** publish a sha as the PR head, as GitHub does */
const publish = (sha: string) => sh(W, 'push', '-q', '-f', 'origin', `${sha}:refs/pull/7/head`);
/** what a fresh base checkout of the workflow sees: origin/main at its current tip */
const refreshBase = () =>
  sh(W, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');

function setup(init: { labels?: string[]; comments?: object[] } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'pm-'));
  O = join(dir, 'origin.git');
  W = join(dir, 'work');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), GH);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', O]);
  execFileSync('git', ['clone', '-q', O, W], { stdio: 'pipe' });
  file('a.txt', lines(20));
  file('b.txt', lines(5));
  commit('base');
  sh(W, 'branch', '-M', 'main');
  sh(W, 'push', '-q', 'origin', 'main');
  refreshBase();
  sh(W, 'checkout', '-q', '-b', 'pr');
  file(
    'a.txt',
    lines(20, i => (i === 10 ? 'changed by the PR' : `line ${i}`))
  );
  writeFileSync(
    join(dir, 'LABELS'),
    (init.labels ?? ['ai-review-passed', 'risky-path']).join('\n') + '\n'
  );
  writeFileSync(
    join(dir, 'COMMENTS'),
    (init.comments ?? []).map(c => JSON.stringify(c)).join('\n') +
      (init.comments?.length ? '\n' : '')
  );
}
const head0 = () => {
  const h = commit('pr change');
  publish(h);
  return h;
};
const run = (cmd: string, headSha: string, extra: Record<string, string> = {}) =>
  spawnSync('node', [SCRIPT, cmd], {
    cwd: W,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: dir,
      GH_REPO: 'o/r',
      PR: '7',
      BASE_REF: 'main',
      HEAD_SHA: headSha,
      GITHUB_OUTPUT: join(dir, 'out'),
      ...extra,
    },
    encoding: 'utf8',
  });
const labels = () => readFileSync(join(dir, 'LABELS'), 'utf8').split('\n').filter(Boolean);
const comments = () => readFileSync(join(dir, 'COMMENTS'), 'utf8');
const marker = () => /head=([0-9a-f]{40}) diff=([0-9a-f]{64})/.exec(comments());
const out = () => (existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '');
const sha256 = (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex');
const diffOf = (headSha: string) =>
  execFileSync(
    'git',
    [
      'diff',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      `origin/main...${headSha}`,
    ],
    { cwd: W, encoding: 'utf8' }
  );

describe('pass-marker: a pass is bound to the head and the exact diff that were reviewed', () => {
  beforeEach(() => setup());

  it('an unchanged head keeps the label', () => {
    const h = head0();
    expect(run('record', h).status).toBe(0);
    expect(marker()![1]).toBe(h);
    run('revalidate', h);
    expect(labels()).toContain('ai-review-passed');
    expect(out()).toMatch(/kept=true/);
  });

  it('a clean merge of main (new head descending from the reviewed one, PR diff byte-identical) keeps the label and moves the marker', () => {
    const h0 = head0();
    run('record', h0);
    sh(W, 'checkout', '-q', 'main');
    file(
      'b.txt',
      lines(5, () => 'main moved')
    );
    const m = commit('main moves');
    sh(W, 'push', '-q', 'origin', 'main');
    refreshBase();
    sh(W, 'checkout', '-q', 'pr');
    sh(W, 'merge', '-q', '--no-edit', 'origin/main');
    const h1 = sh(W, 'rev-parse', 'HEAD');
    publish(h1);
    expect(h1).not.toBe(h0);
    expect(m).toBeTruthy();
    const r = run('revalidate', h1);
    expect(r.status).toBe(0);
    expect(labels()).toContain('ai-review-passed');
    expect(marker()![1]).toBe(h1); // the chain continues from the new head
  });

  it('a whitespace-only change invalidates the pass (git patch-id would have collided)', () => {
    const h0 = head0();
    run('record', h0);
    file(
      'a.txt',
      lines(20, i => (i === 10 ? 'changed  by the PR' : `line ${i}`))
    ); // one extra space
    const h1 = commit('whitespace');
    publish(h1);
    const before = diffOf(h0),
      after = diffOf(h1);
    const pid = (d: string) =>
      execFileSync('git', ['patch-id', '--stable'], { input: d, encoding: 'utf8' }).split(' ')[0];
    expect(pid(before)).toBe(pid(after)); // the old fingerprint could not tell these apart
    expect(sha256(before)).not.toBe(sha256(after)); // the byte hash can
    run('revalidate', h1);
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('a commit that changes content strips the label', () => {
    const h0 = head0();
    run('record', h0);
    file(
      'a.txt',
      lines(20, i => (i === 10 ? 'changed by the PR' : i === 3 ? 'sneaky' : `line ${i}`))
    );
    const h1 = commit('more');
    publish(h1);
    run('revalidate', h1);
    expect(labels()).not.toContain('ai-review-passed');
    expect(out()).toMatch(/kept=false/);
  });

  it("a merge of main that touches the PR's own file changes the diff bytes and strips (strict by design)", () => {
    const h0 = head0();
    run('record', h0);
    sh(W, 'checkout', '-q', 'main');
    file(
      'a.txt',
      lines(20, i => (i === 0 ? 'main edited line zero' : `line ${i}`))
    );
    commit('main edits a.txt');
    sh(W, 'push', '-q', 'origin', 'main');
    refreshBase();
    sh(W, 'checkout', '-q', 'pr');
    sh(W, 'merge', '-q', '--no-edit', 'origin/main');
    const h1 = sh(W, 'rev-parse', 'HEAD');
    publish(h1);
    run('revalidate', h1);
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('TOCTOU: a head that moved between the review and record is refused and nothing is written', () => {
    const h0 = head0();
    file(
      'a.txt',
      lines(20, () => 'x')
    );
    const h1 = commit('pushed during the review');
    publish(h1);
    const r = run('record', h0); // the review saw h0; the PR is now h1
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PR head moved/);
    expect(comments()).toBe('');
  });

  it('the diff subcommand prints exactly the bytes the pass hashes, and refuses once the PR head moved', () => {
    const h0 = head0();
    expect(run('diff', h0).stdout).toBe(diffOf(h0));
    file(
      'a.txt',
      lines(20, () => 'z')
    );
    const h1 = commit('moved');
    publish(h1);
    expect(run('diff', h0).status).toBe(1);
  });

  it('record refuses when the diff is not the one the reviewer read', () => {
    const h0 = head0();
    const r = run('record', h0, { DIFF_SHA256: 'a'.repeat(64) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not the diff the reviewer read/);
    expect(comments()).toBe('');
    expect(run('record', h0, { DIFF_SHA256: sha256(diffOf(h0)) }).status).toBe(0);
  });

  it('a head that does not descend from the reviewed head strips, even with a byte-identical diff', () => {
    const h0 = head0();
    run('record', h0);
    sh(W, 'checkout', '-q', 'main');
    sh(W, 'checkout', '-q', '-b', 'pr2');
    file(
      'a.txt',
      lines(20, i => (i === 10 ? 'changed by the PR' : `line ${i}`))
    );
    const h1 = commit('same change, different history');
    publish(h1);
    expect(sha256(diffOf(h1))).toBe(sha256(diffOf(h0)));
    expect(h1).not.toBe(h0);
    run('revalidate', h1);
    expect(labels()).not.toContain('ai-review-passed');
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toMatch(/remove-label/);
  });

  it('revalidate for a head that is not the PR head of the event strips (the PR moved)', () => {
    const h0 = head0();
    run('record', h0);
    file(
      'a.txt',
      lines(20, () => 'y')
    );
    const h1 = commit('moved');
    publish(h1);
    run('revalidate', h0);
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('no marker, or a marker comment from anyone but github-actions[bot], strips the label', () => {
    const h = head0();
    run('revalidate', h);
    expect(labels()).not.toContain('ai-review-passed');
    const d = sha256(diffOf(h));
    setup({
      comments: [
        { id: 1, login: 'some-author', body: `<!-- ai-review-pass head=${h} diff=${d} -->` },
      ],
    });
    const h2 = head0();
    run('revalidate', h2);
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('an unrelated label event records nothing; the ai-review-passed label event records', () => {
    const h = head0();
    const r = run('record', h, { LABEL_NAME: 'bug' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unrelated label/);
    expect(comments()).toBe('');
    expect(run('record', h, { LABEL_NAME: 'ai-review-passed' }).status).toBe(0);
    expect(marker()).not.toBeNull();
  });

  it('with no label there is nothing to keep or strip', () => {
    setup({ labels: ['risky-path'] });
    const h = head0();
    run('revalidate', h);
    expect(existsSync(join(dir, 'calls.log'))).toBe(false);
    expect(out()).toMatch(/kept=false/);
  });

  it('record upserts one marker comment: the second record patches it', () => {
    const h = head0();
    run('record', h);
    run('record', h);
    expect(readFileSync(join(dir, 'calls.log'), 'utf8').match(/^post$/gm)?.length).toBe(1);
    expect(readFileSync(join(dir, 'calls.log'), 'utf8')).toMatch(/^patch 1$/m);
  });

  it('usage errors exit 2', () => {
    expect(
      spawnSync('node', [SCRIPT, 'bogus'], {
        env: { PATH: process.env.PATH ?? '', PR: '1' },
        encoding: 'utf8',
      }).status
    ).toBe(2);
    expect(
      spawnSync('node', [SCRIPT, 'record'], {
        env: { PATH: process.env.PATH ?? '', PR: '1' },
        encoding: 'utf8',
      }).status
    ).toBe(2);
  });
});

describe('ai-review.yml wiring', () => {
  const classify = WF.slice(WF.indexOf('  classify:'), WF.indexOf('  review:'));
  const review = WF.slice(WF.indexOf('  review:'), WF.indexOf('  manual-pass:'));
  const manual = WF.slice(WF.indexOf('  manual-pass:'), WF.indexOf('  fork-gate:'));
  const fork = WF.slice(WF.indexOf('  fork-gate:'));
  it('classify revalidates with the event head, never strips unconditionally', () => {
    expect(classify).toMatch(/pass-marker\.mjs revalidate/);
    expect(classify).toMatch(/HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    expect(classify).not.toMatch(/--remove-label ai-review-passed/);
  });
  it('the review is skipped when the pass was kept', () => {
    expect(WF).toMatch(/needs\.classify\.outputs\.kept != 'true'/);
  });
  it('the reviewer reads exactly the bytes the pass is bound to, and the pass is recorded BEFORE the label is added', () => {
    expect(review).toMatch(/pass-marker\.mjs diff > pr\.diff/);
    expect(review).toMatch(/REVIEWED_DIFF_SHA256=/);
    expect(review).toMatch(/DIFF_SHA256: \$\{\{ env\.REVIEWED_DIFF_SHA256 \}\}/);
    expect(review.indexOf('pass-marker.mjs record')).toBeGreaterThan(-1);
    expect(review.indexOf('pass-marker.mjs record')).toBeLessThan(
      review.indexOf('--add-label ai-review-passed')
    );
    expect(review).not.toMatch(/git diff --no-renames --unified/);
  });
  it('a review that fails or is refused removes the label', () => {
    const step = review.slice(review.indexOf('A review that did not pass'));
    expect(step).toMatch(/if: failure\(\)/);
    expect(step).toMatch(/--remove-label ai-review-passed/);
  });
  it('record only ever runs for the ai-review-passed label event, and with full history + the event head', () => {
    expect(manual).toMatch(/github\.event\.label\.name == 'ai-review-passed'/);
    expect(manual).toMatch(/LABEL_NAME: \$\{\{ github\.event\.label\.name \}\}/);
    expect(fork).toMatch(/LABEL_NAME: \$\{\{ github\.event\.label\.name \}\}/);
    for (const j of [manual, fork]) {
      expect(j).toMatch(/fetch-depth: 0/);
      expect(j).toMatch(/HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    }
  });
  it('the fork gate revalidates instead of stripping', () => {
    expect(fork).toMatch(/pass-marker\.mjs revalidate/);
    expect(fork).not.toMatch(/--remove-label ai-review-passed/);
  });
});
