import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const D1_ID = '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

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
        EBDA_PLATFORM_D1_ID: D1_ID,
      };
      expect(spawnSync(process.execPath, [script], { env }).status).not.toBe(0);
      execFileSync(process.execPath, [script], {
        env: { ...env, EBDA_HYPERDRIVE_ID: 'a'.repeat(32) },
      });
      const output = readFileSync(join(dir, 'apps/api/.wrangler.deploy.jsonc'), 'utf8');
      expect(output).not.toContain('0'.repeat(32));
      // the D1 id is required too: unset or the zero placeholder never reaches wrangler
      for (const bad of ['', '00000000-0000-0000-0000-000000000000', 'not-a-uuid'])
        expect(
          spawnSync(process.execPath, [script], {
            env: { ...env, EBDA_HYPERDRIVE_ID: 'a'.repeat(32), EBDA_PLATFORM_D1_ID: bad },
          }).status
        ).not.toBe(0);
      expect(output).toContain('a'.repeat(32));
      expect(output).toContain('b'.repeat(32));
      expect(output).toContain(D1_ID);
      expect(output).not.toContain('00000000-0000-0000-0000-000000000000');
      expect(output).toContain('api.ebda.app/*');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
