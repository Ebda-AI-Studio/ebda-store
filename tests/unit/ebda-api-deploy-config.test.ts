import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const D1_ID = '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const DEDUPE_ID = '9a8b7c6d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';

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
        EBDA_KV_CACHE_ID: '0'.repeat(32),
        EBDA_PLATFORM_D1_ID: D1_ID,
        EBDA_INSTAPAY_DEDUPE_D1_ID: DEDUPE_ID,
      };
      expect(spawnSync(process.execPath, [script], { env }).status).not.toBe(0);
      execFileSync(process.execPath, [script], {
        env: { ...env, EBDA_KV_CACHE_ID: 'b'.repeat(32) },
      });
      const output = readFileSync(join(dir, 'apps/api/.wrangler.deploy.jsonc'), 'utf8');
      expect(output).not.toContain('0'.repeat(32));
      // the D1 id is required too: unset or the zero placeholder never reaches wrangler
      for (const bad of ['', '00000000-0000-0000-0000-000000000000', 'not-a-uuid'])
        expect(
          spawnSync(process.execPath, [script], {
            env: { ...env, EBDA_KV_CACHE_ID: 'b'.repeat(32), EBDA_PLATFORM_D1_ID: bad },
          }).status
        ).not.toBe(0);
      expect(output).toContain('b'.repeat(32));
      expect(output).toContain(D1_ID);
      expect(output).not.toContain('00000000-0000-0000-0000-000000000000');
      expect(output).toContain('api.ebda.app/*');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const run = (extra: Record<string, string | undefined>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ebda-api-config-'));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'apps/api'), { recursive: true });
    cpSync('scripts/ebda-cf-api-config.mjs', join(dir, 'scripts/ebda-cf-api-config.mjs'));
    cpSync('apps/api/wrangler.jsonc', join(dir, 'apps/api/wrangler.jsonc'));
    const env: Record<string, string | undefined> = {
      ...process.env,
      EBDA_KV_CACHE_ID: 'b'.repeat(32),
      EBDA_PLATFORM_D1_ID: D1_ID,
      EBDA_INSTAPAY_DEDUPE_D1_ID: DEDUPE_ID,
      ...extra,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const r = spawnSync(process.execPath, [join(dir, 'scripts/ebda-cf-api-config.mjs')], {
      env: env as NodeJS.ProcessEnv,
    });
    let out = '';
    try {
      out = readFileSync(join(dir, 'apps/api/.wrangler.deploy.jsonc'), 'utf8');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, out, err: String(r.stderr) };
  };
  const dbBlock = (out: string, binding: string) =>
    out.slice(out.indexOf(`"binding": "${binding}"`)).split('}')[0];

  it('binds each D1 id to its own binding and never crosses them', () => {
    const { status, out } = run({});
    expect(status).toBe(0);
    expect(dbBlock(out, 'PLATFORM_DB')).toContain(`"database_id": "${D1_ID}"`);
    expect(dbBlock(out, 'PLATFORM_DB')).not.toContain(DEDUPE_ID);
    expect(dbBlock(out, 'INSTAPAY_DEDUPE_DB')).toContain(`"database_id": "${DEDUPE_ID}"`);
    expect(dbBlock(out, 'INSTAPAY_DEDUPE_DB')).toContain('"database_name": "ebda-instapay-dedupe"');
    expect(dbBlock(out, 'INSTAPAY_DEDUPE_DB')).not.toContain(D1_ID);
    expect(out).not.toContain('00000000-0000-0000-0000-00000000000');
  });

  it('throws when the dedupe variable is missing, a placeholder, malformed or equal to the platform id', () => {
    for (const bad of [
      undefined,
      '',
      '00000000-0000-0000-0000-000000000000',
      '00000000-0000-0000-0000-000000000001',
      'nope',
      D1_ID,
    ]) {
      const r = run({ EBDA_INSTAPAY_DEDUPE_D1_ID: bad });
      expect(r.status, String(bad)).not.toBe(0);
      expect(r.out, String(bad)).toBe('');
    }
  });
});
