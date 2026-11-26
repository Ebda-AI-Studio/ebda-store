import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ruling API-AUTODEPLOY-1: main must not drift from production. Pin the trigger AND the safety rails it relies on.
const wf = readFileSync(join(__dirname, '../../.github/workflows/cf-api-deploy.yml'), 'utf8');

describe('cf-api-deploy.yml auto-deploy', () => {
  it('runs on push to main for the API paths and still on workflow_dispatch', () => {
    expect(wf).toMatch(/workflow_dispatch:/);
    expect(wf).toMatch(/push:\n\s+branches: \[main\]/);
    for (const p of [
      'apps/api/**',
      'packages/**',
      'package-lock.json',
      'scripts/ebda-cf-api-config.mjs',
    ])
      expect(wf).toContain(`- '${p}'`);
  });
  it('queues deploys: one concurrency group, never cancel-in-progress (a cancelled deploy never happened)', () => {
    expect(wf).toMatch(/concurrency:\n\s+group: ebda-api-production\n\s+cancel-in-progress: false/);
    expect(wf).not.toMatch(/cancel-in-progress: true/);
  });
  it('keeps the gates: workerd smoke, /health commit verify with rollback, main only', () => {
    expect(wf).toContain('scripts/ci/workerd-smoke.sh');
    expect(wf).toContain('--probe "https://api.ebda.app/health|200|commit=$GITHUB_SHA"');
    expect(wf).toContain('deploy-guard.mjs verify');
    expect(wf).not.toMatch(/inngest/i);
    expect(wf).toContain("github.ref == 'refs/heads/main'");
  });
  it('applies the D1 platform migrations before the Worker deploys, from the schema package (task 2.4)', () => {
    const apply = wf.indexOf(
      'wrangler d1 migrations apply ebda-platform --remote --config .wrangler.deploy.jsonc'
    );
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(wf.indexOf('npx wrangler deploy --config'));
    expect(wf).toContain('EBDA_PLATFORM_D1_ID: ${{ vars.EBDA_PLATFORM_D1_ID }}');
    expect(wf).toContain('EBDA_INSTAPAY_DEDUPE_D1_ID: ${{ vars.EBDA_INSTAPAY_DEDUPE_D1_ID }}');
  });
});
