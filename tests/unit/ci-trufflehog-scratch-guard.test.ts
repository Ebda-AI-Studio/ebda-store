/**
 * No job uses a local `./` action before `actions/checkout`.
 *
 * A `uses: ./.github/actions/...` step cannot resolve until checkout has put
 * the repo on disk. (This file used to also pin the FWB-era pre-checkout
 * trufflehog-scratch guard for self-hosted jobs; Ebda runs on ephemeral
 * GitHub-hosted runners only, so that guard, and its assertions, are gone.
 * tests/unit/workflow-hosted-runners-only.test.ts keeps it that way.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const WF_DIR = join(__dirname, '../../.github/workflows');

type Step = { uses?: string; name?: string; [k: string]: unknown };
type Job = { steps?: Step[]; [k: string]: unknown };
type Workflow = { jobs?: Record<string, Job>; [k: string]: unknown };

function checkoutIndex(steps: Step[]): number {
  return steps.findIndex(s => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
}

const files = readdirSync(WF_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('no job uses a local ./ action before actions/checkout', () => {
  it('found workflow files (guards against an empty-set pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

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
