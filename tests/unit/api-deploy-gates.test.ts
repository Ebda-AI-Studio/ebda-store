/**
 * P03 / M-007 / M-052: the API deploy gates. The required-secret list is a file the workflow reads, and every name in it must
 * be one the API code actually reads; the verify/rollback step must still run when `wrangler deploy` fails after uploading.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const wf = readFileSync(path.join(ROOT, '.github/workflows/cf-api-deploy.yml'), 'utf8');
const { required } = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/ci/api-required-secrets.json'), 'utf8')
);

describe('cf-api-deploy.yml gates', () => {
  it('requires the secrets the app needs and not the retired Resend key', () => {
    expect(required).toEqual(
      expect.arrayContaining([
        'JWT_SECRET',
        'ENCRYPTION_KEY',
        'ALERTS_WEBHOOK_TOKEN',
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_ALERT_CHAT_ID',
      ])
    );
    expect(required).not.toContain('RESEND_API_KEY');
    expect(wf).toContain('scripts/ci/api-required-secrets.json');
    expect(wf).not.toMatch(/"RESEND_API_KEY"/);
  });
  it.each(required as string[])(
    '%s is read by the API code (the list is derived from code, not wishful)',
    name => {
      const hit = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '-w',
          name,
          '--',
          'apps/api/src',
          'apps/api/workers',
          'scripts/ebda-cf-api-config.mjs',
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      expect(hit.length).toBeGreaterThan(0);
    }
  );
  it('asserts the Hyperdrive and KV ids before deploying', () => {
    expect(wf).toMatch(/test -n "\$EBDA_HYPERDRIVE_ID"/);
    expect(wf).toMatch(/test -n "\$EBDA_KV_CACHE_ID"/);
  });
  it('verify/rollback still runs when the deploy step fails after uploading (M-007)', () => {
    const verify = wf.slice(wf.indexOf('Verify the live API'));
    expect(verify.slice(0, 900)).toMatch(
      /if: always\(\) && steps\.deploy\.conclusion != 'skipped'/
    );
    expect(wf).toMatch(/- name: Deploy reviewed API\n\s+id: deploy/);
  });
});
