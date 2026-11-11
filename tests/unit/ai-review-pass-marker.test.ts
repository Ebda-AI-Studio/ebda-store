// Store copy of ebda-foundation test/ai-review-pass-marker.test.ts: the gate runs from the base branch, so its code is exercised here in CI first.
// @ts-nocheck
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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

// A node stub for `gh` over three files: DIFF (the PR diff), LABELS (one per line), COMMENTS (JSONL {id, login, body}).
const GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), d = process.env.STUB_DIR;
const read = (f) => (fs.existsSync(d + '/' + f) ? fs.readFileSync(d + '/' + f, 'utf8') : '');
const write = (f, s) => fs.writeFileSync(d + '/' + f, s);
const log = (s) => fs.appendFileSync(d + '/calls.log', s + '\\n');
const comments = () => read('COMMENTS').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
if (a[0] === 'pr' && a[1] === 'diff') { if (fs.existsSync(d + '/DIFF_FAIL')) process.exit(1); process.stdout.write(read('DIFF')); }
else if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(read('LABELS'));
else if (a[0] === 'pr' && a[1] === 'edit') { log('edit ' + a.slice(3).join(' ')); if (a[3] === '--remove-label') write('LABELS', read('LABELS').split('\\n').filter((l) => l && l !== a[4]).join('\\n') + '\\n'); }
else if (a[0] === 'api' && a.includes('--paginate')) process.stdout.write(comments().map((c) => JSON.stringify(c)).join('\\n') + '\\n');
else if (a[0] === 'api' && a.includes('POST')) { const body = a[a.indexOf('-f') + 1].replace(/^body=/, ''); const c = comments(); c.push({ id: c.length + 1, login: 'github-actions[bot]', body }); write('COMMENTS', c.map((x) => JSON.stringify(x)).join('\\n') + '\\n'); log('post'); }
else if (a[0] === 'api' && a.includes('PATCH')) { const id = Number(a[a.length - 3].split('/').pop()); const body = a[a.indexOf('-f') + 1].replace(/^body=/, ''); write('COMMENTS', comments().map((x) => JSON.stringify(x.id === id ? { ...x, body } : x)).join('\\n') + '\\n'); log('patch ' + id); }
else { console.error('stub gh: unhandled ' + a.join(' ')); process.exit(9); }
`;

const hunk = (at: number, ctx: string, extra = '') =>
  `diff --git a/apps/api/src/a.ts b/apps/api/src/a.ts\n--- a/apps/api/src/a.ts\n+++ b/apps/api/src/a.ts\n@@ -${at},3 +${at},4 @@ ${ctx}\n keep\n-old line\n+new line\n${extra} keep2\n`;

let dir = '';
function setup(init: { diff?: string; labels?: string[]; comments?: object[] } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'pm-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), GH);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(dir, 'DIFF'), init.diff ?? hunk(10, 'function a() {'));
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
const run = (cmd: string, extra: Record<string, string> = {}) =>
  spawnSync('node', [SCRIPT, cmd], {
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: dir,
      GH_REPO: 'o/r',
      PR: '7',
      GITHUB_OUTPUT: join(dir, 'out'),
      ...extra,
    },
    encoding: 'utf8',
    cwd: tmpdir(),
  });
const labels = () => readFileSync(join(dir, 'LABELS'), 'utf8').split('\n').filter(Boolean);
const calls = () =>
  existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
const out = () => (existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '');

describe('pass-marker: the label follows the reviewed diff, not the head commit', () => {
  beforeEach(() => setup());

  it('a clean merge of main (same change, shifted line numbers and different context) keeps the label', () => {
    expect(run('record').status).toBe(0);
    writeFileSync(join(dir, 'DIFF'), hunk(240, 'function somethingElseNow() {')); // main moved the code under the PR
    const r = run('revalidate');
    expect(r.status).toBe(0);
    expect(labels()).toContain('ai-review-passed');
    expect(calls()).not.toMatch(/remove-label/);
    expect(out()).toMatch(/kept=true/);
  });

  it('a push that changes the PR diff strips the label', () => {
    run('record');
    writeFileSync(join(dir, 'DIFF'), hunk(10, 'function a() {', '+sneaky added line\n'));
    run('revalidate');
    expect(labels()).not.toContain('ai-review-passed');
    expect(labels()).toContain('risky-path');
    expect(out()).toMatch(/kept=false/);
  });

  it('no marker (e.g. a label applied before this existed) strips it: unknown is not pass', () => {
    run('revalidate');
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('a marker comment from anyone but github-actions[bot] is ignored', () => {
    run('record');
    const id = /patch-id:([0-9a-f]{40})/.exec(readFileSync(join(dir, 'COMMENTS'), 'utf8'))![1];
    setup({
      comments: [{ id: 1, login: 'some-author', body: `<!-- ai-review-patch-id:${id} -->` }],
    });
    run('revalidate');
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('an unreadable diff strips the label', () => {
    run('record');
    writeFileSync(join(dir, 'DIFF_FAIL'), '');
    run('revalidate');
    expect(labels()).not.toContain('ai-review-passed');
  });

  it('with no label there is nothing to keep or strip', () => {
    setup({ labels: ['risky-path'] });
    run('revalidate');
    expect(calls()).toBe('');
    expect(out()).toMatch(/kept=false/);
  });

  it('record upserts one marker comment: the second record patches it', () => {
    run('record');
    run('record');
    expect(calls().match(/^post$/gm)?.length).toBe(1);
    expect(calls()).toMatch(/^patch 1$/m);
  });

  it('record writes nothing when the diff cannot be read', () => {
    writeFileSync(join(dir, 'DIFF_FAIL'), '');
    run('record');
    expect(readFileSync(join(dir, 'COMMENTS'), 'utf8')).toBe('');
  });

  it('usage errors exit 2', () => {
    expect(
      spawnSync('node', [SCRIPT, 'bogus'], {
        env: { PATH: process.env.PATH ?? '', GH_REPO: 'o/r', PR: '1' },
        encoding: 'utf8',
      }).status
    ).toBe(2);
    expect(
      spawnSync('node', [SCRIPT, 'record'], {
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
      }).status
    ).toBe(2);
  });
});

describe('ai-review.yml uses the marker instead of stripping on every push', () => {
  it('classify revalidates, never strips unconditionally', () => {
    const classify = WF.slice(WF.indexOf('  classify:'), WF.indexOf('  review:'));
    expect(classify).toMatch(/pass-marker\.mjs revalidate/);
    expect(classify).not.toMatch(/--remove-label ai-review-passed/);
  });
  it('the review is skipped when the pass was kept, and every pass path records the diff', () => {
    expect(WF).toMatch(/needs\.classify\.outputs\.kept != 'true'/);
    expect((WF.match(/pass-marker\.mjs record/g) ?? []).length).toBe(3);
  });
  it('the fork gate revalidates instead of stripping', () => {
    const fork = WF.slice(WF.indexOf('  fork-gate:'));
    expect(fork).toMatch(/pass-marker\.mjs revalidate/);
    expect(fork).not.toMatch(/--remove-label ai-review-passed/);
  });
});
