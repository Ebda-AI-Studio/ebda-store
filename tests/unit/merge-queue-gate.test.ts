/** MERGE-QUEUE-1: the `Merge queue gate` aggregator. Verdict logic, and a structural guard that every full-lane job is wired into it. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { verdict } from '../../scripts/ci/merge-queue-gate.mjs';

const ok = (ids: string[]) => Object.fromEntries(ids.map(i => [i, { result: 'success' }]));

describe('verdict', () => {
  it('a pull request always passes (the full lane runs on the merge group)', () => {
    expect(verdict('pull_request', {}).ok).toBe(true);
    expect(verdict('pull_request', { build: { result: 'skipped' } }).ok).toBe(true);
  });
  it('a merge group passes only when every needed job succeeded', () => {
    expect(verdict('merge_group', ok(['build', 'test-unit'])).ok).toBe(true);
  });
  it.each(['failure', 'cancelled', 'skipped'])(
    'a needed job that is %s fails the merge group',
    result => {
      const needs = { ...ok(['build', 'test-unit']), 'test-e2e': { result } };
      const v = verdict('merge_group', needs);
      expect(v.ok).toBe(false);
      expect(v.message).toContain(`test-e2e=${result}`);
    }
  );
  it('an empty or missing needs object is never green', () => {
    expect(verdict('merge_group', {}).ok).toBe(false);
    expect(verdict('merge_group', null).ok).toBe(false);
    expect(verdict('merge_group', undefined).ok).toBe(false);
  });
  it('any other event fails (the job must not run there)', () => {
    expect(verdict('push', ok(['build'])).ok).toBe(false);
    expect(verdict('', ok(['build'])).ok).toBe(false);
  });
});

describe('ci.yml wiring', () => {
  const ci = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const job = (id: string) => {
    const m = ci.match(new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|$)`));
    return m ? m[1] : null;
  };
  const gate = job('merge-queue-gate')!;

  it('the job exists, is named exactly `Merge queue gate`, and runs only on pull_request and merge_group', () => {
    expect(gate).toBeTruthy();
    expect(gate).toContain('name: Merge queue gate');
    expect(gate).toContain(
      "if: always() && (github.event_name == 'pull_request' || github.event_name == 'merge_group')"
    );
  });

  it('every job that runs on a merge group is a dependency of the gate (a new full-lane job cannot be forgotten)', () => {
    const ids = [...ci.matchAll(/\n {2}([a-z0-9-]+):\n {4}name:/g)].map(m => m[1]);
    // jobs that do NOT gate a merge: the pull-request-only lane, schedule-only mutation, the notifier, the gate itself
    const exempt = new Set([
      'changes',
      'lint',
      'typecheck',
      'unit',
      'unit-gate',
      'app-build',
      'app-builds',
      'mutation',
      'notify-failure',
      'merge-queue-gate',
    ]);
    const needsLine = gate.match(/needs:\s*\[([\s\S]*?)\]/)![1];
    const needs = new Set(
      needsLine
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
    // a job another needed job depends on is covered through it (the unit shards are covered by test-unit)
    const covered = new Set(needs);
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of [...covered]) {
        const body = job(id) ?? '';
        const nl = body.match(/\n {4}needs:\s*(\[[^\]]*\]|[a-z0-9-]+)/);
        for (const dep of (nl ? nl[1].replace(/[[\]]/g, '').split(',') : [])
          .map(x => x.trim())
          .filter(Boolean))
          if (!covered.has(dep)) (covered.add(dep), (grew = true));
      }
    }
    const missing = ids.filter(id => !exempt.has(id) && !covered.has(id));
    expect(
      missing,
      `full-lane job(s) not in the Merge queue gate needs: ${missing.join(', ')}`
    ).toEqual([]);
    for (const n of needs) expect(ids, `needs lists an unknown job ${n}`).toContain(n);
  });

  it('every exempt job really is not a merge-group job: pull-request-only, schedule-only, or needs `changes`', () => {
    for (const id of ['unit', 'unit-gate', 'app-build', 'app-builds', 'lint', 'typecheck']) {
      const j = job(id)!;
      expect(j, id).toMatch(/needs\.changes\.outputs|github\.event_name == 'pull_request'/);
    }
    expect(job('changes')!).toContain("if: github.event_name == 'pull_request'");
    expect(job('mutation')!).toContain("github.event_name == 'schedule'");
  });

  it('the ruleset-required list is unchanged: the gate is not a pull-request required check the drain waits on', () => {
    // merge-gate-required.mjs derives required checks from `if: ... == 'pull_request'` shapes; the gate's own `if` is a different shape
    expect(gate).not.toMatch(/if: always\(\) && github\.event_name == 'pull_request'\n/);
  });
});
