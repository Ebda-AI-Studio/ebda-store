/**
 * Issue 2099: `concurrency: cancel-in-progress: true` on the nightly DAST
 * cancels a starved, still-queued run — and `notify-failure` was gated on
 * `always() && failure()`, which is FALSE for a cancelled run. The DAST's
 * main failure mode (a starved self-hosted runner) became a silent night with
 * no scan, no report and no alert.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

type Job = {
  if?: string;
  needs?: string | string[];
  steps?: Array<{ run?: string; env?: Record<string, string> }>;
};
const wf = yaml.load(
  readFileSync(path.resolve(__dirname, '../../.github/workflows/zap-baseline.yml'), 'utf8')
) as {
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};

describe('zap-baseline.yml: a cancelled scan is loud, not silent (issue 2099)', () => {
  it('notify-failure fires on a CANCELLED zap job, not only a failed one', () => {
    const notify = wf.jobs['notify-failure'];
    expect(notify, 'notify-failure job renamed/removed').toBeTruthy();
    expect(notify.if).toMatch(/cancelled\(\)/);
    expect(notify.if).toMatch(/failure\(\)/);
  });

  it('the alert tells "found something" apart from "never ran"', () => {
    const run = wf.jobs['notify-failure'].steps?.map(s => s.run ?? '').join('\n') ?? '';
    expect(run).toMatch(/DID NOT RUN/);
    expect(run).toMatch(/FAILED/);
    const env = Object.assign({}, ...(wf.jobs['notify-failure'].steps ?? []).map(s => s.env ?? {}));
    expect(env.ZAP_RESULT).toBe('${{ needs.zap.result }}');
  });

  it('a manual dispatch and the nightly cron cannot cancel each other', () => {
    expect(wf.concurrency?.group).toMatch(/github\.event_name/);
  });
});
