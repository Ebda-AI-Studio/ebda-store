import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Two self-hosted runners on one VM share /tmp; concurrent vitest runs collided on Vite's temp cache and
// failed hundreds of test files at startup with zero assertion failures (#150, #202, 2026-10-24).
// Every job that sets up Node (i.e. runs npm/vitest) must first point TMPDIR at its runner's private RUNNER_TEMP.
const ci = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
const jobs = ci.split(/\n(?=  [a-z0-9-]+:\n)/).filter(j => j.includes('uses: actions/setup-node'));

describe('ci.yml private TMPDIR', () => {
  it('finds the node jobs', () => {
    expect(jobs.length).toBeGreaterThan(10);
  });
  it.each(jobs.map(j => [j.split('\n')[0].trim(), j]))(
    '%s sets a private TMPDIR before Node setup',
    (_n, job) => {
      const tmp = job.indexOf('echo "TMPDIR=$RUNNER_TEMP/tmp" >> "$GITHUB_ENV"');
      const node = job.indexOf('uses: actions/setup-node');
      expect(tmp).toBeGreaterThan(-1);
      expect(tmp).toBeLessThan(node);
    }
  );
  it('vitest keeps its cache in the runner-private temp on CI', () => {
    const cfg = readFileSync(join(__dirname, '../../vitest.config.ts'), 'utf8');
    expect(cfg).toContain('process.env.RUNNER_TEMP');
    expect(cfg).toContain('/vitest-cache');
  });
});
