import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, chmodSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRisky, riskyPaths } from '../../.github/ai-review/risky-paths.mjs';

describe('ai-review classifier (fail closed: only docs, markdown and NEWLY ADDED tests are exempt)', () => {
  it('exempts markdown and docs/ whatever the status', () => {
    for (const p of ['README.md', 'docs/plans/x.md', 'docs/img/a.png']) for (const st of ['A', 'M', 'D']) expect(isRisky(p, st), `${st} ${p}`).toBe(false);
  });
  it('exempts a newly ADDED test file', () => {
    for (const p of ['apps/api/src/refunds/refund.test.ts', 'apps/api/test/helpers.ts', 'e2e/checkout.spec.ts']) expect(isRisky(p, 'A'), p).toBe(false);
  });
  it('a MODIFIED, DELETED or unknown-status test is risky: this repo\'s safety guards are test files', () => {
    const guards = readdirSync('tests/unit').filter((f) => /^(across-stores-isolation|no-rls-bypass-in-runtime|no-raw-pii-in-logs)/.test(f));
    expect(guards.length).toBeGreaterThan(0);
    for (const f of guards) for (const st of ['M', 'D', '?']) expect(isRisky(`tests/unit/${f}`, st), `${st} ${f}`).toBe(true);
  });
  it('requires review for data and money paths of this repo', () => {
    for (const p of ['packages/database/src/index.ts', 'packages/database/prisma/schema.prisma', 'apps/api/src/routes/order.routes.ts', 'apps/api/src/services/order.service.ts', 'apps/api/src/services/cross-store.service.ts']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('requires review for the gate itself and CI, so the gate cannot be edited to pass', () => {
    for (const p of ['.github/ai-review/review.mjs', '.github/ai-review/prompt.md', '.github/workflows/ai-review.yml', 'scripts/ci/merge-gate.sh', 'package.json']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('does not let a docs/ or test-looking name smuggle code through', () => {
    for (const p of ['docs/build.mjs', 'apps/api/src/contest.ts', 'apps/api/src/test-utils.ts']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('parses git --name-status lines', () => {
    expect(riskyPaths(['A\tREADME.md', 'A\ta.test.ts', ''])).toEqual([]);
    expect(riskyPaths(['M\ttests/guard.test.ts', 'A\ttests/new.test.ts', 'A\tapps/api/src/x.ts'])).toEqual(['tests/guard.test.ts', 'apps/api/src/x.ts']);
  });
  it('ONE concurrency group per PR for every event, queued and never cancelled', () => {
    const wf = readFileSync('.github/workflows/ai-review.yml', 'utf8');
    expect(/^  group: (.*)$/m.exec(wf)?.[1] ?? '').toBe('ai-review-${{ github.event.pull_request.number || github.run_id }}');
    expect(wf).toMatch(/^  cancel-in-progress: false$/m);
  });
  it('the workflow: base checkout, 400 KB fails, name-status, fork-gate red until labelled', () => {
    const wf = readFileSync('.github/workflows/ai-review.yml', 'utf8');
    expect((wf.match(/ref: \$\{\{ github\.base_ref \}\}/g) ?? []).length).toBe(2);
    expect((wf.match(/ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/g) ?? []).length).toBe(2);
    expect(wf).not.toMatch(/head -c/);
    expect(wf).toMatch(/-ge 400000/);
    expect(wf).toMatch(/git diff --name-status --no-renames/);
    const fork = wf.slice(wf.indexOf('  fork-gate:'));
    expect(fork).toMatch(/head\.repo\.full_name != github\.repository/);
    expect(fork).toMatch(/exit 1/);
    expect(fork).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
  it('Ruling AI-REVIEW-LABEL-1: only a real critical verdict may remove ai-review-passed; refusal/infra paths leave labels alone', () => {
    const wf = readFileSync('.github/workflows/ai-review.yml', 'utf8');
    const removals = [...wf.matchAll(/--remove-label ai-review-passed/g)].map((m) => m.index);
    const classify = wf.slice(wf.indexOf('  classify:'), wf.indexOf('  review:'));
    const sizeStep = wf.slice(wf.indexOf('- name: Build the diff'), wf.indexOf('- name: Review the diff'));
    expect(classify).not.toMatch(/remove-label ai-review-passed/);
    expect(sizeStep).not.toMatch(/--remove-label|--add-label|gh pr edit/);
    const review = wf.slice(wf.indexOf('  review:'), wf.indexOf('  manual-pass:'));
    // the review job's single removal is gated on the verdict output
    const step = review.slice(review.indexOf('- name: Drop ai-review-passed'), review.indexOf('- name: Label ai-review-passed'));
    expect(step).toMatch(/if: always\(\) && steps\.gate\.outputs\.verdict == 'critical'/);
    expect(step).toMatch(/--remove-label ai-review-passed/);
    // the only other removal is the fork-gate (fork PRs never get a bot review)
    expect(removals.length).toBe(2);
    expect(readFileSync('.github/ai-review/review.mjs', 'utf8')).toMatch(/verdict=critical/);
  });
});

describe('classify never strips ai-review-passed (main Ruling AI-REVIEW-LABEL-1 / RF-710)', () => {
  const wf2 = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const classify2 = wf2.slice(wf2.indexOf('  classify:'), wf2.indexOf('  review:'));
  const fork2 = wf2.slice(wf2.indexOf('  fork-gate:'));
  const BASE_CHANGED = /github\.event\.action != 'edited' \|\| github\.event\.changes\.base\.ref\.from != null/;
  it('classify has no label removal and no marker or diff comparison', () => {
    expect(classify2).not.toMatch(/remove-label ai-review-passed/);
    expect(wf2).not.toMatch(/pass-marker|patch-id|REVIEWED_DIFF/);
  });
  it('a base-branch change (edited event with changes.base) re-runs classify; the fork gate decides itself whether to strip', () => {
    expect(classify2).toMatch(BASE_CHANGED);
    expect(fork2).not.toMatch(BASE_CHANGED);
    expect(fork2).toMatch(/BASE_FROM: \$\{\{ github\.event\.changes\.base\.ref\.from \}\}/);
  });
});

// ---- every subscribed event ends in a REAL "AI review" conclusion (a skipped required check can read as green) ----
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 1);
  return body.split(/\n(?=  [a-z-]+:\n)/).slice(1).map((blk) => ({
    id: /^  ([a-z-]+):/.exec(blk)[1],
    name: /^    name: (.+)$/m.exec(blk)?.[1] ?? '',
    cond: /^    if: (.+)$/m.exec(blk)?.[1] ?? 'true',
    needs: /^    needs: (\w[\w-]*)$/m.exec(blk)?.[1],
  }));
}
function evalIf(cond, g) {
  const lookup = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), g);
  const js = cond.replace(/\b(?:github|needs)\.[A-Za-z0-9_.-]+/g, (m) => `__g(${JSON.stringify(m)})`);
    return Boolean(new Function('__g', `return (${js});`)((p) => lookup(p)));
}
function ghContext(c, risky) {
  return {
    github: { repository: 'o/r', event: { action: c.action, label: c.label ? { name: c.label } : undefined, changes: c.baseFrom ? { base: { ref: { from: c.baseFrom } } } : undefined, pull_request: { draft: c.draft, head: { repo: { full_name: c.fork ? 'f/r' : 'o/r' } } } } },
    needs: { classify: { outputs: { risky } } },
  };
}
// the events the same-repo workflow subscribes to (the copy lists them in `types:`; the reusable file inherits them from its caller)
const EVENTS = [
  ...['opened', 'synchronize', 'reopened', 'ready_for_review'].flatMap((action) => [false, true].flatMap((draft) => [false, true].map((fork) => ({ action, draft, fork })))),
  ...[false, true].flatMap((draft) => [false, true].flatMap((fork) => [
    { action: 'labeled', label: 'ai-review-passed', draft, fork }, { action: 'labeled', label: 'bug', draft, fork },
    { action: 'edited', baseFrom: 'main', draft, fork }, { action: 'edited', draft, fork },
  ])),
];

describe('every subscribed event yields a non-skipped "AI review" check', () => {
  const wf3 = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const all = jobs(wf3);
  const reviewJobs = all.filter((j) => j.name === 'AI review');
  it('finds the five jobs named "AI review" and the classify job', () => {
    expect(reviewJobs.map((j) => j.id).sort()).toEqual(['fork-gate', 'manual-pass', 'not-risky', 'review', 'state-check']);
    expect(all.find((j) => j.id === 'classify')).toBeTruthy();
  });
  it.each(EVENTS.map((e) => [JSON.stringify(e), e]))('%s', (_n, e) => {
    for (const risky of ['true', 'false']) {
      const classify = all.find((j) => j.id === 'classify');
      const classifyRuns = evalIf(classify.cond, ghContext(e, ''));
      const outputs = classifyRuns ? risky : '';
      const ctx = ghContext(e, outputs);
      const running = reviewJobs.filter((j) => evalIf(j.cond, ctx)).map((j) => j.id);
      expect(running.length, `no "AI review" job runs for ${JSON.stringify(e)} (classify ${classifyRuns ? 'ran, risky=' + risky : 'skipped'})`).toBeGreaterThan(0);
    }
  });
  it('a title/body edit and an unrelated label never strip the label (fork gate) and state-check never strips', () => {
    const classify = all.find((j) => j.id === 'classify');
    for (const e of EVENTS.filter((x) => (x.action === 'edited' && !x.baseFrom) || (x.action === 'labeled' && x.label !== 'ai-review-passed'))) {
      expect(evalIf(classify.cond, ghContext(e, '')), JSON.stringify(e)).toBe(false);
    }
    const fork = wf3.slice(wf3.indexOf('  fork-gate:'));
    expect(fork).toMatch(/\[ "\$ACTION" = edited \] && \[ -z "\$BASE_FROM" \] && strip=0/);
    expect(wf3.slice(wf3.indexOf('  state-check:'), wf3.indexOf('  # A same-repo PR a maintainer labelled')).includes('remove-label')).toBe(false);
  });
});

describe('push-like events re-run classify, draft or not (the label is never stripped there)', () => {
  const wf4 = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const all4 = jobs(wf4);
  const classify = all4.find((j) => j.id === 'classify');
  it('classify runs for opened / synchronize / reopened / ready_for_review on a DRAFT PR, and for a base-change edit', () => {
    for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
      expect(evalIf(classify.cond, ghContext({ action, draft: true, fork: false }, '')), `draft ${action}`).toBe(true);
    }
    expect(evalIf(classify.cond, ghContext({ action: 'edited', baseFrom: 'main', draft: true, fork: false }, ''))).toBe(true);
    expect(evalIf(classify.cond, ghContext({ action: 'edited', draft: true, fork: false }, ''))).toBe(false);
  });
  it('a draft is classified but never reviewed (the review job is skipped for drafts)', () => {
    const review = all4.find((j) => j.id === 'review');
    expect(evalIf(review.cond, ghContext({ action: 'synchronize', draft: true, fork: false }, 'true'))).toBe(false);
    expect(evalIf(review.cond, ghContext({ action: 'synchronize', draft: false, fork: false }, 'true'))).toBe(true);
  });
  it('the review labels only a head that is still the PR head, and checks that before adding the label', () => {
    const review = wf4.slice(wf4.indexOf('  review:'), wf4.indexOf('  not-risky:'));
    expect(review.indexOf('headRefOid')).toBeGreaterThan(-1);
    expect(review.indexOf('headRefOid')).toBeLessThan(review.indexOf('--add-label ai-review-passed'));
  });
  it('state-check and fork-gate trust the label only through label-fresh.mjs', () => {
    for (const id of ['state-check', 'fork-gate']) {
      const blk = wf4.slice(wf4.indexOf(`  ${id}:`));
      expect(blk.slice(0, id === 'state-check' ? blk.indexOf('  # A same-repo PR') : undefined)).toMatch(/label-fresh\.mjs/);
    }
    expect(wf4.slice(wf4.indexOf('  fork-gate:'))).not.toMatch(/grep -qx ai-review-passed/);
  });
});

// ---- label-fresh.mjs: the label is valid only if its latest `labeled` event is newer than the head commit ----
const LF = '.github/ai-review/label-fresh.mjs';
const HEAD = 'a'.repeat(40);
function lf(o) {
  const d = mkdtempSync(join(tmpdir(), 'lf-'));
  const stub = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (${o.fail ? 'true' : 'false'}) process.exit(1);
if (a[0] === 'pr') process.stdout.write(${JSON.stringify((o.labels ?? ['ai-review-passed']).join('\n') + '\n')});
else if (a[1].endsWith('/timeline')) process.stdout.write(${JSON.stringify((o.labeled ?? []).join('\n') + '\n')});
else process.stdout.write(${JSON.stringify((o.headDate ?? '2026-01-01T00:00:00Z') + '\n')});
`;
  mkdirSync(join(d, 'bin')); writeFileSync(join(d, 'bin', 'gh'), stub); chmodSync(join(d, 'bin', 'gh'), 0o755);
  const r = spawnSync('node', [LF], { env: { PATH: `${join(d, 'bin')}:${process.env.PATH}`, GH_REPO: 'o/r', PR: '7', HEAD_SHA: HEAD, GITHUB_OUTPUT: join(d, 'out') }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, state: existsSync(join(d, 'out')) ? /state=(\w+)/.exec(readFileSync(join(d, 'out'), 'utf8'))?.[1] : undefined };
}
describe('label-fresh: a stale label fails (the drain\'s rule)', () => {
  it('labelled after the head commit: valid', () => {
    expect(lf({ labeled: ['2026-01-02T00:00:00Z'], headDate: '2026-01-01T00:00:00Z' })).toMatchObject({ code: 0, state: 'valid' });
  });
  it('labelled BEFORE the head commit (a push after the approval): stale, exit 1, even though the label is still on the PR', () => {
    expect(lf({ labeled: ['2026-01-01T00:00:00Z'], headDate: '2026-01-02T00:00:00Z' })).toMatchObject({ code: 1, state: 'stale' });
  });
  it('the LATEST labeled event decides: an old label re-applied after the head is valid', () => {
    expect(lf({ labeled: ['2025-12-01T00:00:00Z', '2026-01-03T00:00:00Z'], headDate: '2026-01-02T00:00:00Z' })).toMatchObject({ code: 0, state: 'valid' });
  });
  it('equal timestamps are stale (not strictly newer)', () => {
    expect(lf({ labeled: ['2026-01-01T00:00:00Z'], headDate: '2026-01-01T00:00:00Z' }).state).toBe('stale');
  });
  it('no label on the PR is absent; a label with no labeled event is stale', () => {
    expect(lf({ labels: ['risky-path'] })).toMatchObject({ code: 1, state: 'absent' });
    expect(lf({ labeled: [] })).toMatchObject({ code: 1, state: 'stale' });
  });
  it('GitHub unreadable: not valid', () => {
    expect(lf({ fail: true })).toMatchObject({ code: 1, state: 'stale' });
  });
  it('usage error exits 2', () => {
    expect(spawnSync('node', [LF], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' }).status).toBe(2);
  });
});

describe('the workflow files are valid YAML (a parse error silently disables a whole workflow on GitHub)', () => {
  it('every .github/workflows/*.yml parses and has jobs', async () => {
    const { parse } = await import('yaml');
    const files = readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f));
    expect(files).toContain('ai-review.yml');
    for (const f of files) {
      const doc = parse(readFileSync(join('.github/workflows', f), 'utf8'));
      expect(Object.keys(doc.jobs ?? {}).length, f).toBeGreaterThan(0);
    }
  });
});

