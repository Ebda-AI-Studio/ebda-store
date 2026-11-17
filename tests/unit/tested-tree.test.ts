/** MERGE-QUEUE-1 part B: the push run skips the full lane only for a tree a merge group already proved, and fails closed on any doubt. */
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { decide, collect } from '../../scripts/ci/tested-tree.mjs';
// @ts-expect-error plain .mjs without types
import { requiredChecks } from '../../scripts/ci/merge-gate-required.mjs';

const T1 = 'a'.repeat(40);
const T2 = 'b'.repeat(40);
const run = (o: Record<string, unknown> = {}) => ({
  id: 1,
  conclusion: 'success',
  tree: T1,
  gate: 'success',
  ...o,
});

describe('decide', () => {
  it('skips only a PUSH whose tree a green merge group proved (gate job green)', () => {
    const v = decide({ event: 'push', headTree: T1, runs: [run()] });
    expect(v.skip).toBe(true);
    expect(v.reason).toContain('merge group run 1');
  });
  it.each(['pull_request', 'merge_group', 'schedule', 'workflow_dispatch', ''])(
    'never skips on %s',
    event => {
      expect(decide({ event, headTree: T1, runs: [run()] }).skip).toBe(false);
    }
  );
  it('compares TREES, not commit shas: a run of another tree does not count', () => {
    expect(decide({ event: 'push', headTree: T1, runs: [run({ tree: T2 })] }).skip).toBe(false);
  });
  it('no run, no head tree, or an empty/undefined run list: full lane', () => {
    expect(decide({ event: 'push', headTree: T1, runs: [] }).skip).toBe(false);
    expect(decide({ event: 'push', headTree: T1, runs: undefined }).skip).toBe(false);
    expect(decide({ event: 'push', headTree: null, runs: [run()] }).skip).toBe(false);
  });
  it('a non-success conclusion or a non-success gate job does not count', () => {
    expect(
      decide({ event: 'push', headTree: T1, runs: [run({ conclusion: 'failure' })] }).skip
    ).toBe(false);
    expect(decide({ event: 'push', headTree: T1, runs: [run({ gate: 'failure' })] }).skip).toBe(
      false
    );
    expect(decide({ event: 'push', headTree: T1, runs: [run({ gate: null })] }).skip).toBe(false);
  });
  it('AMBIGUITY fails closed: a green and a failed run of the same tree = full lane', () => {
    const v = decide({
      event: 'push',
      headTree: T1,
      runs: [run({ id: 2 }), run({ id: 3, conclusion: 'failure' })],
    });
    expect(v.skip).toBe(false);
    expect(v.reason).toContain('ambiguous');
  });
});

describe('collect (API reads)', () => {
  const fake =
    (over: Record<string, unknown> = {}) =>
    async (p: string) => {
      if (over.fail && p.includes(String(over.fail))) throw new Error('boom');
      if (p.includes('/git/commits/headsha')) return { tree: { sha: T1 } };
      if (p.includes('/git/commits/gsha1')) return { tree: { sha: T1 } };
      if (p.includes('/git/commits/gsha2')) return { tree: { sha: T2 } };
      if (p.includes('/workflows/ci.yml/runs'))
        return {
          workflow_runs: [
            { id: 10, head_sha: 'gsha1', conclusion: 'success' },
            { id: 11, head_sha: 'gsha2', conclusion: 'success' },
          ],
        };
      if (p.includes('/actions/runs/10/jobs'))
        return {
          jobs: [
            { name: 'Build', conclusion: 'success' },
            { name: 'Merge queue gate', conclusion: 'success' },
          ],
        };
      return {};
    };
  it('reads the head tree, every merge group run, and the gate job only for runs of the same tree', async () => {
    const seen: string[] = [];
    const get = async (p: string, t: string) => (seen.push(p), fake()(p, t));
    const r = await collect({ repo: 'o/r', sha: 'headsha', token: 'x', get });
    expect(r.headTree).toBe(T1);
    expect(r.runs).toEqual([
      { id: 10, conclusion: 'success', tree: T1, gate: 'success' },
      { id: 11, conclusion: 'success', tree: T2, gate: null },
    ]);
    expect(seen.some(p => p.includes('/actions/runs/11/jobs'))).toBe(false);
    expect(decide({ event: 'push', ...r }).skip).toBe(true);
  });
  it('an API error propagates (the CLI turns it into skip=false)', async () => {
    await expect(
      collect({ repo: 'o/r', sha: 'headsha', token: 'x', get: fake({ fail: '/workflows/' }) })
    ).rejects.toThrow('boom');
  });
});

describe('ci.yml wiring', () => {
  const ci = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const job = (id: string) =>
    ci.match(new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|$)`))?.[1] ?? '';
  const SKIP = "needs.tested-tree.outputs.skip != 'true'";

  it('tested-tree runs on EVERY event (no job-level if) and exposes skip', () => {
    const j = job('tested-tree');
    expect(j).toContain('name: Tested tree check');
    expect(j).not.toMatch(/\n {4}if:/);
    expect(j).toContain('skip: ${{ steps.decide.outputs.skip }}');
    expect(j).toContain('actions: read');
  });
  it.each([
    'build',
    'security',
    'test-unit-shard',
    'test-unit',
    'workerd-integration',
    'worker-dry-run',
    'api-workerd-smoke',
  ])('%s respects the skip decision and needs tested-tree', id => {
    const j = job(id);
    expect(j, id).toMatch(/needs: \[[^\]]*tested-tree[^\]]*\]/);
    expect(j, id).toContain(SKIP);
  });
  it('downstream full-lane jobs hang off those roots (skipped when build is skipped), none is independently unconditional on push', () => {
    for (const id of ['orphan-tests', 'test-e2e', 'builder-e2e'])
      expect(job(id), id).toMatch(/needs: \[build\]/);
    expect(job('test-integration')).toContain("needs.build.result == 'success'");
  });
  it('API Worker boots on workerd stays a REQUIRED pull request check (derivation extended), and so does the tested-tree check', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'ci.yml'), ci);
    const required: string[] = requiredChecks(dir);
    expect(required).toContain('API Worker boots on workerd');
    expect(required).toContain('Tested tree check');
    // the other full-lane roots are NOT required on a pull request
    for (const n of [
      'Build',
      'Unit Tests',
      'Security Audit',
      'Integration on local workerd (DO + D1 + R2)',
    ])
      expect(required).not.toContain(n);
  });
  it('the derivation only trusts the skip condition when tested-tree itself is always-on', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-'));
    const gated = ci.replace(
      /(\n {2}tested-tree:\n {4}name: Tested tree check\n)/,
      "$1    if: github.event_name == 'push'\n"
    );
    writeFileSync(path.join(dir, 'ci.yml'), gated);
    expect(requiredChecks(dir)).not.toContain('API Worker boots on workerd');
  });
});
