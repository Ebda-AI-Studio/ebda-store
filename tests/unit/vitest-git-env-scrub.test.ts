/**
 * Pins tests/setup-git-env.ts (PREPUSH-5C): hooks export GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE, and a test that spawned git
 * in a temp dir with them inherited committed into the real checkout. The fix is at runtime, not a regex over test source:
 * the setup file clears every GIT_* var, and every vitest config that runs node tests must load it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const SETUP = 'tests/setup-git-env.ts';

// Configs that run on workerd (@cloudflare/vitest-pool-workers, no child_process) or are throwaway spikes: no git there.
const NO_GIT_CONFIGS = new Set([
  'apps/accounts/vitest.config.ts',
  'apps/status/vitest.config.ts',
  'apps/api/vitest.workers-do.config.mts',
  'apps/api/vitest.workers.config.mts',
  'packages/repo/vitest.workers.config.mts',
  'spikes/store-do/vitest.config.ts',
  'spikes/workers-api/vitest.config.ts',
]);

function configs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.next', '.open-next', '.wrangler'].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) configs(p, out);
    else if (/^vitest[^/]*\.config\.(ts|mts|mjs|js)$/.test(e)) out.push(relative(ROOT, p));
  }
  return out;
}

describe('vitest scrubs hook-exported GIT_* env at test-process start', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
    for (const [k, v] of Object.entries(saved))
      if (k.startsWith('GIT_') && v !== undefined) process.env[k] = v;
    vi.resetModules();
  });

  it('the setup file really clears GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and any other GIT_* key', async () => {
    process.env.GIT_DIR = '/real/checkout/.git';
    process.env.GIT_WORK_TREE = '/real/checkout';
    process.env.GIT_INDEX_FILE = '/real/checkout/.git/index';
    process.env.GIT_SOMETHING_NEW = '1';
    process.env.KEEP_ME = 'yes';
    vi.resetModules();
    await import('../setup-git-env');
    expect(process.env.GIT_DIR).toBeUndefined();
    expect(process.env.GIT_WORK_TREE).toBeUndefined();
    expect(process.env.GIT_INDEX_FILE).toBeUndefined();
    expect(process.env.GIT_SOMETHING_NEW).toBeUndefined();
    expect(process.env.KEEP_ME).toBe('yes');
    delete process.env.KEEP_ME;
  });

  it('this very process already runs with no GIT_* (the setup file is wired into the config running it)', () => {
    expect(Object.keys(saved).filter(k => k.startsWith('GIT_'))).toEqual([]);
  });

  it('finds the vitest configs (the check is not vacuous)', () => {
    expect(configs(ROOT)).toEqual(expect.arrayContaining(['vitest.config.ts']));
  });

  it('every vitest config lists the setup file, unless it is a workerd/spike config with no git', () => {
    const missing = configs(ROOT).filter(
      c => !NO_GIT_CONFIGS.has(c) && !readFileSync(join(ROOT, c), 'utf8').includes('setup-git-env')
    );
    expect(
      missing,
      `add './${SETUP}' to setupFiles (or allowlist a workerd config with a reason)`
    ).toEqual([]);
  });

  it('every allowlisted no-git config still exists and really spawns no git', () => {
    for (const c of NO_GIT_CONFIGS) {
      const dir = join(ROOT, c, '..');
      const files: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d)) {
          if (['node_modules', 'dist', '.wrangler', '.next'].includes(e)) continue;
          const p = join(d, e);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.test\.(ts|mts|js)$/.test(e)) files.push(p);
        }
      };
      expect(statSync(join(ROOT, c)).isFile()).toBe(true);
      walk(dir);
      const spawners = files.filter(
        f =>
          /child_process/.test(readFileSync(f, 'utf8')) && /\bgit\b/.test(readFileSync(f, 'utf8'))
      );
      expect(
        spawners.map(f => relative(ROOT, f)),
        `${c} spawns git; give it the setup file`
      ).toEqual([]);
    }
  });
});
