/**
 * Ruling WEB-COLD-1 + EDGE-BUILD-1: the storefront deploy ends by warming every demo store in BOTH languages.
 * The HTML edge cache is keyed by the Worker version, so each deploy starts it empty; warming only /ar left the
 * first /en visitor with the cold render. Pinned here: both languages, best effort, and a cap that covers the
 * worst case so the step is never killed half way through the list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { DEMO_HOSTS } from '../../apps/web/src/lib/demo-hosts';

const ROOT = path.resolve(__dirname, '../..');
type Step = {
  name?: string;
  run?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
const wf = yaml.load(
  readFileSync(path.join(ROOT, '.github/workflows/cf-web-deploy.yml'), 'utf8')
) as { jobs: { deploy: { steps: Step[] } } };
const steps = wf.jobs.deploy.steps;
const warm = steps.find(s => /^Warm the storefront/.test(s.name ?? ''));

describe('cf-web-deploy warm step', () => {
  it('is the last deploy step and can never fail the deploy', () => {
    expect(warm).toBeDefined();
    expect(steps[steps.length - 1]).toBe(warm);
    expect(warm!['continue-on-error']).toBe(true);
  });

  it('requests /ar and /en of every demo host listed in demo-hosts.ts', () => {
    const run = warm!.run!;
    expect(run).toContain('apps/web/src/lib/demo-hosts.ts');
    const langs = run
      .match(/for lang in ([a-z ]+);/)?.[1]
      .trim()
      .split(/\s+/);
    expect(langs).toEqual(['ar', 'en']);
    expect(run).toContain('https://$label.ebda.app/$lang');
    // the grep the step uses finds every host label the app knows
    const labels = readFileSync(path.join(ROOT, 'apps/web/src/lib/demo-hosts.ts'), 'utf8').match(
      /'storedemo[a-z-]*'/g
    );
    expect(labels?.map(l => l.slice(1, -1)).sort()).toEqual(Object.values(DEMO_HOSTS).sort());
  });

  it('caps the step above the worst case (hosts x languages x curl --max-time)', () => {
    const maxTime = Number(warm!.run!.match(/--max-time (\d+)/)?.[1]);
    expect(maxTime).toBeGreaterThan(0);
    const worstSeconds = Object.values(DEMO_HOSTS).length * 2 * maxTime;
    expect(warm!['timeout-minutes']! * 60).toBeGreaterThanOrEqual(worstSeconds);
  });
});
