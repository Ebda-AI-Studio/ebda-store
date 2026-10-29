import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow, requiredChecks } from '../../../scripts/ci/merge-gate-required.mjs';

const ROOT = join(__dirname, '../../..');
const GATE = join(ROOT, 'scripts/ci/merge-gate.sh');
const WF = join(ROOT, '.github/workflows');
const REQ = [
  'API Worker boots on workerd',
  'App builds (affected)',
  'Deploy workflow changes need the deploy-change label',
  'Detect affected workspaces',
  'Repo guards',
  'Scan for leaked secrets',
  'blast-radius',
];
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

type Check = { name: string; status?: string; conclusion?: string | null };
const run = (
  checks: Check[],
  over: { head?: string; mergeable?: string; want?: string; polls?: string } = {}
) => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-'));
  const view = join(dir, 'view.json');
  writeFileSync(
    view,
    JSON.stringify({
      headRefOid: over.head ?? SHA,
      mergeable: over.mergeable ?? 'MERGEABLE',
      statusCheckRollup: checks.map(c => ({
        __typename: 'CheckRun',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        ...c,
      })),
    })
  );
  const merged = join(dir, 'merged');
  const r = spawnSync(
    'bash',
    [
      GATE,
      '1',
      over.want ?? SHA.slice(0, 9),
      '--polls',
      over.polls ?? '3',
      '--interval',
      '0',
      '--dry-run',
    ],
    {
      env: {
        ...process.env,
        MERGE_GATE_VIEW_CMD: `cat ${view}`,
        MERGE_GATE_REQUIRED_JSON: JSON.stringify(REQ),
        MERGE_GATE_MAX_WAIT_S: '1',
      },
      encoding: 'utf8',
    }
  );
  // second run WITHOUT --dry-run through the merge seam, to prove the real merge call happens (and only when green)
  const r2 = spawnSync(
    'bash',
    [GATE, '1', over.want ?? SHA.slice(0, 9), '--polls', over.polls ?? '3', '--interval', '0'],
    {
      env: {
        ...process.env,
        MERGE_GATE_VIEW_CMD: `cat ${view}`,
        MERGE_GATE_REQUIRED_JSON: JSON.stringify(REQ),
        MERGE_GATE_MAX_WAIT_S: '1',
        MERGE_GATE_MERGE_CMD: `echo "$sha" > ${merged}`,
      },
      encoding: 'utf8',
    }
  );
  return {
    dry: r,
    status: r2.status,
    out: r2.stdout + r2.stderr,
    merged: existsSync(merged) ? readFileSync(merged, 'utf8').trim() : null,
  };
};
const green = REQ.map(name => ({ name }));

describe('merge-gate.sh', () => {
  it('no checks at all -> refuses (never merges "nothing reported yet")', () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.merged).toBeNull();
    expect(r.out).toContain('no checks have reported yet');
  });
  it('a queued / in-progress check -> refuses', () => {
    const r = run([
      ...green,
      { name: 'Unit Tests (affected)', status: 'QUEUED', conclusion: null },
    ]);
    expect(r.status).toBe(2);
    expect(r.merged).toBeNull();
    expect(r.out).toContain('Unit Tests (affected)');
  });
  it('a failed required check -> refuses at once (exit 1)', () => {
    const r = run(green.map(c => (c.name === 'Repo guards' ? { ...c, conclusion: 'FAILURE' } : c)));
    expect(r.status).toBe(1);
    expect(r.merged).toBeNull();
    expect(r.out).toContain('failing check(s): Repo guards');
  });
  it('a failed non-required check -> refuses too (any failure blocks)', () => {
    const r = run([...green, { name: 'Lint', conclusion: 'FAILURE' }]);
    expect(r.status).toBe(1);
    expect(r.merged).toBeNull();
  });
  it('a required check that is SKIPPED (no explicit SUCCESS) -> refuses', () => {
    const r = run(
      green.map(c => (c.name === 'blast-radius' ? { ...c, conclusion: 'SKIPPED' } : c))
    );
    expect(r.status).toBe(2);
    expect(r.merged).toBeNull();
    expect(r.out).toContain('without an explicit SUCCESS: blast-radius');
  });
  it('head moved since review -> refuses at once', () => {
    const r = run(green, { head: 'ffffff1234567890ffffff1234567890ffffff12' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('head moved');
    expect(r.merged).toBeNull();
  });
  it('mergeable UNKNOWN or CONFLICTING -> does not merge', () => {
    expect(run(green, { mergeable: 'UNKNOWN' }).merged).toBeNull();
    expect(run(green, { mergeable: 'CONFLICTING' }).merged).toBeNull();
  });
  it('optional skipped checks are fine: all required SUCCESS + skipped others -> merges at the pinned sha', () => {
    const r = run([
      ...green,
      { name: 'Lint', conclusion: 'SKIPPED' },
      { name: 'Mutation tests', conclusion: 'NEUTRAL' },
    ]);
    expect(r.status).toBe(0);
    expect(r.merged).toBe(SHA);
    expect(r.out).toContain('green poll 3/3');
    expect(r.dry.stdout).toContain('DRY RUN');
  });
  it('needs the full streak: --polls 3 does not merge on the first green poll', () => {
    const r = run(green);
    expect(r.out.match(/green poll/g)?.length).toBe(3);
  });
});

describe('merge-gate.sh safety rails in the script itself', () => {
  it('the real merge is pinned to the reviewed commit and squash-deletes the branch', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).toContain('--match-head-commit "$sha"');
    expect(src).toContain('--squash --delete-branch');
  });
});

describe('merge-gate-required.mjs: the required list is derived, so it cannot drift', () => {
  it('derives exactly the always-on PR checks of the real workflows', () => {
    expect(requiredChecks(WF)).toEqual([...REQ].sort());
  });
  it('every derived name is a real job name in a workflow that runs on pull_request', () => {
    const names = new Set<string>();
    for (const f of readdirSync(WF).filter(f => f.endsWith('.yml'))) {
      const { onPr, jobs } = parseWorkflow(readFileSync(join(WF, f), 'utf8'));
      if (onPr)
        for (const j of Object.values<{ name: string | null; id: string }>(jobs))
          names.add(j.name ?? j.id);
    }
    for (const n of requiredChecks(WF)) expect(names.has(n)).toBe(true);
  });
  it('a conditional job (gated on the affected-workspace outputs) is NOT required; an always-on one is', () => {
    const wf = `on:\n  pull_request:\njobs:\n  a:\n    name: Always\n    if: github.event_name == 'pull_request'\n  b:\n    name: Cond\n    needs: [a]\n    if: needs.a.outputs.x != ''\n  c:\n    name: Dependent\n    needs: [b]\n`;
    const { jobs } = parseWorkflow(wf);
    expect(jobs.a.name).toBe('Always');
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'x.yml'), wf);
    expect(requiredChecks(dir)).toEqual(['Always']);
  });
  it('a workflow that does not run on pull_request contributes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'x.yml'), `on:\n  push:\njobs:\n  a:\n    name: PushOnly\n`);
    expect(requiredChecks(dir)).toEqual([]);
  });
});
