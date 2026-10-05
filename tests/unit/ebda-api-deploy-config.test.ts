import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('Ebda API deployment config guard', () => {
  it('refuses placeholder IDs and inserts reviewed IDs without changing routes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebda-api-config-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'apps/api'), { recursive: true });
      cpSync('scripts/ebda-cf-api-config.mjs', join(dir, 'scripts/ebda-cf-api-config.mjs'));
      cpSync('apps/api/wrangler.jsonc', join(dir, 'apps/api/wrangler.jsonc'));
      const script = join(dir, 'scripts/ebda-cf-api-config.mjs');
      const env = {
        ...process.env,
        EBDA_HYPERDRIVE_ID: '0'.repeat(32),
        EBDA_KV_CACHE_ID: 'b'.repeat(32),
      };
      expect(spawnSync(process.execPath, [script], { env }).status).not.toBe(0);
      execFileSync(process.execPath, [script], {
        env: { ...env, EBDA_HYPERDRIVE_ID: 'a'.repeat(32) },
      });
      const output = readFileSync(join(dir, 'apps/api/.wrangler.deploy.jsonc'), 'utf8');
      expect(output).not.toContain('0'.repeat(32));
      expect(output).toContain('a'.repeat(32));
      expect(output).toContain('b'.repeat(32));
      expect(output).toContain('api.ebda.app/*');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
