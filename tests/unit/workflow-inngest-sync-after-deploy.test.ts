/**
 * Every workflow that deploys the API Worker must re-sync Inngest afterwards.
 *
 * WHAT THIS IS FOR
 *
 * Inngest runs only the functions it saw at its LAST sync. `cf-api-deploy.yml` deployed new code
 * but never re-synced, so the gold-rate feed cron (#151) and every other function added since the
 * previous manual sync never ran in production; a manual `PUT /api/v1/inngest` on 2026-10-23
 * answered `"modified": true`. Ruling INNGEST-SYNC-1.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../../.github/workflows');

describe('API deploys re-sync Inngest', () => {
  const apiDeploys = readdirSync(dir)
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => ({ f, text: readFileSync(join(dir, f), 'utf8') }))
    .filter(
      ({ text }) =>
        /wrangler deploy[^\n]*\.wrangler\.deploy\.jsonc/.test(text) && /ebda-api/.test(text)
    );

  it('finds at least the API deploy workflow', () => {
    expect(apiDeploys.map(w => w.f)).toContain('cf-api-deploy.yml');
  });

  it.each(apiDeploys.map(w => [w.f, w.text]))(
    '%s PUTs /api/v1/inngest after wrangler deploy and fails on refusal',
    (_f, text) => {
      const deployAt = text.search(/wrangler deploy/);
      const syncAt = text.search(/-X PUT[^\n]*\/api\/v1\/inngest/);
      expect(syncAt).toBeGreaterThan(deployAt);
      expect(text).toMatch(/Successfully registered/);
      expect(text.slice(syncAt)).toMatch(/exit 1/);
    }
  );
});
