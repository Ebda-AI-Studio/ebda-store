/**
 * #1883: trufflehog's action scans as root and can leave a root-owned
 * `trufflehog-<pid>-<rand>/` scratch dir behind when interrupted — an OOM kill, a
 * cancelled run, or a guest restart. The NEXT job to land on that self-hosted
 * runner dies in `actions/checkout` (which clears the workspace first) with
 * EACCES, and it is STICKY until someone with root deletes it; one leftover
 * took out six runs at once on 2026-09-23.
 *
 * `if: always()` on the end-of-job cleanup does NOT cover an OOM-kill or a
 * guest restart — nothing after the kill runs, checkout included — so every
 * job that (a) can run on the self-hosted runner pool and (b) checks out code
 * must ALSO run the inline "Remove root-owned trufflehog scratch (pre-checkout
 * guard, #1883)" step BEFORE checkout. This is the class-wide gate: it fails on
 * any new self-hosted checkout job added without the guard, not just the ones
 * fixed here.
 *
 * The guard is an inline `run:` step, NOT a local composite action: a
 * `uses: ./.github/actions/...` step resolves from the checked-out workspace,
 * so before `actions/checkout` it fails with "Can't find 'action.yml'" and
 * takes the whole job down (CI run 36277120137).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const WF_DIR = join(__dirname, '../../.github/workflows');
const GUARD_NAME = 'Remove root-owned trufflehog scratch (pre-checkout guard, issue 1883)';

type Step = { uses?: string; if?: string; name?: string; run?: string; [k: string]: unknown };
type Job = { 'runs-on'?: unknown; steps?: Step[]; [k: string]: unknown };
type Workflow = { jobs?: Record<string, Job>; [k: string]: unknown };

function runsOnSelfHosted(job: Job): boolean {
  return JSON.stringify(job['runs-on'] ?? '').includes('self-hosted');
}

function checkoutIndex(steps: Step[]): number {
  return steps.findIndex(s => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
}

const files = readdirSync(WF_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('#1883: every self-hosted job that checks out code runs the guard FIRST', () => {
  it('found workflow files (guards against an empty-set pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  const cases: Array<{ file: string; jobName: string; job: Job }> = [];
  for (const file of files) {
    const doc = yaml.load(readFileSync(join(WF_DIR, file), 'utf8')) as Workflow;
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      if (!job.steps || !runsOnSelfHosted(job)) continue;
      if (checkoutIndex(job.steps) === -1) continue; // no checkout — nothing to strand it before
      cases.push({ file, jobName, job });
    }
  }

  it('found at least one self-hosted checkout job to check (guards against an empty-set pass)', () => {
    expect(cases.length).toBeGreaterThan(5);
  });

  it.each(cases.map(c => [`${c.file} / ${c.jobName}`, c] as const))('%s', (_label, { job }) => {
    const steps = job.steps!;
    const coAt = checkoutIndex(steps);
    const guardAt = steps.findIndex(s => s.name === GUARD_NAME);
    expect(guardAt, 'no pre-checkout trufflehog scratch guard step in this job').toBeGreaterThan(
      -1
    );
    expect(guardAt, 'the guard must run BEFORE checkout, not after').toBeLessThan(coAt);

    const guard = steps[guardAt];
    expect(guard.uses, 'the guard must be an inline run step, not an action').toBeUndefined();
    expect(guard.run).toContain('rm -rf trufflehog-*');
    // No bare `exit 1` — a docker hiccup here must not block an unrelated job.
    expect(guard.run).not.toMatch(/^\s*exit 1\s*$/m);
  });
});

describe('no job uses a local ./ action before actions/checkout', () => {
  const all: Array<{ label: string; steps: Step[] }> = [];
  for (const file of files) {
    const doc = yaml.load(readFileSync(join(WF_DIR, file), 'utf8')) as Workflow;
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      if (job.steps) all.push({ label: `${file} / ${jobName}`, steps: job.steps });
    }
  }

  it.each(all.map(c => [c.label, c.steps] as const))('%s', (_label, steps) => {
    const coAt = checkoutIndex(steps);
    const limit = coAt === -1 ? steps.length : coAt;
    const early = steps
      .slice(0, limit)
      .filter(s => typeof s.uses === 'string' && s.uses.startsWith('./'))
      .map(s => s.uses);
    expect(early, 'a local action cannot be loaded before the repo is checked out').toEqual([]);
  });
});
