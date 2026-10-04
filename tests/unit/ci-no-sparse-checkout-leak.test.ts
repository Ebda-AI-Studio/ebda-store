/**
 * No workflow may use a sparse checkout (inherited from FWB, 2026-09-30).
 *
 * FWB's persistent workspace once kept `core.sparseCheckout` on after a sparse
 * probe job, and the next plain checkout reused it (a tree of only `scripts/`,
 * so `npm ci` found no package-lock.json). Ebda's hosted runners are
 * ephemeral, so the leak cannot recur there, and the guard that undid it is
 * gone; what stays pinned is that no workflow introduces a sparse checkout, so
 * a job never silently builds from a partial tree.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const WF_DIR = join(__dirname, '../../.github/workflows');

type Step = { uses?: string; name?: string; run?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[] };
const files = readdirSync(WF_DIR).filter(f => /\.ya?ml$/.test(f));
const docs = files.map(f => ({
  file: f,
  raw: readFileSync(join(WF_DIR, f), 'utf8'),
  jobs: ((yaml.load(readFileSync(join(WF_DIR, f), 'utf8')) as { jobs?: Record<string, Job> })
    .jobs ?? {}) as Record<string, Job>,
}));

const isCheckout = (s: Step) =>
  typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@');

describe('no workflow uses sparse-checkout (the leak source)', () => {
  it.each(docs.map(d => [d.file, d] as const))('%s', (_f, d) => {
    for (const [name, job] of Object.entries(d.jobs)) {
      for (const s of job.steps ?? []) {
        if (!isCheckout(s)) continue;
        expect(
          s.with?.['sparse-checkout'],
          `${name}: a sparse checkout builds from a partial tree`
        ).toBeUndefined();
      }
    }
    expect(d.raw).not.toMatch(/git sparse-checkout set|git sparse-checkout init/);
  });
});

it('found workflows to check (guards against an empty-set pass)', () => {
  expect(docs.length).toBeGreaterThanOrEqual(3);
});
