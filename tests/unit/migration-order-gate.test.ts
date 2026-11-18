/**
 * Migration ordering gate (scripts/check-migration-order.mjs, Ruling MIG-ORD-1).
 *
 * A new migration folder must sort strictly after main's newest, and no two
 * folders may share a 14-digit timestamp. The case that motivated it: an open
 * PR added `20261001120000_payment_config_key_fingerprint` while main already
 * had `20261001120000_backorder_line_stock_taken` — the two would have been
 * ordered by their name suffix, and production had already applied main's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
// @ts-expect-error — plain .mjs script, no type declarations
import {
  checkMigrationOrder,
  GRANDFATHERED_DUPLICATES,
  fetchArgs,
} from '../../scripts/check-migration-order.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-migration-order.mjs');
const MIG = 'packages/database/prisma/migrations';

const MAIN = ['20260930100000_a', '20261001120000_backorder_line_stock_taken'];

describe('checkMigrationOrder (pure)', () => {
  it('passes a new migration that sorts after main', () => {
    expect(
      checkMigrationOrder({ baseNames: MAIN, headNames: [...MAIN, '20261002090000_new_thing'] })
    ).toEqual([]);
  });

  it('fails the real collision: same timestamp as main newest (ordering AND duplicate)', () => {
    const v = checkMigrationOrder({
      baseNames: MAIN,
      headNames: [...MAIN, '20261001120000_payment_config_key_fingerprint'],
    });
    expect(v.join('\n')).toMatch(
      /does not sort after main's newest migration 20261001120000_backorder/
    );
    expect(v.join('\n')).toMatch(/timestamp 20261001120000 is shared by 2/);
  });

  it('fails a new migration that sorts BEFORE main newest', () => {
    const v = checkMigrationOrder({
      baseNames: MAIN,
      headNames: [...MAIN, '20260930110000_backdated'],
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/20260930110000_backdated: timestamp 20260930110000 does not sort after/);
  });

  it('fails two NEW migrations sharing a timestamp even when both sort after main', () => {
    const v = checkMigrationOrder({
      baseNames: MAIN,
      headNames: [...MAIN, '20261003000000_x', '20261003000000_y'],
    });
    expect(v).toEqual([expect.stringMatching(/timestamp 20261003000000 is shared by 2/)]);
  });

  it('fails a malformed folder name', () => {
    const v = checkMigrationOrder({ baseNames: MAIN, headNames: [...MAIN, '2026-10-03_x'] });
    expect(v[0]).toMatch(/must be <14-digit UTC timestamp>_<lower_snake_name>/);
  });

  it('allows the grandfathered production collisions exactly, and nothing joining them', () => {
    const legacy = Object.values(GRANDFATHERED_DUPLICATES).flat() as string[];
    const base = [...legacy, ...MAIN];
    expect(checkMigrationOrder({ baseNames: base, headNames: base })).toEqual([]);
    // A folder joining a grandfathered timestamp is both backdated and a new duplicate.
    const joined = checkMigrationOrder({
      baseNames: base,
      headNames: [...base, '20260615000000_sneaky'],
    });
    expect(joined.join('\n')).toMatch(/timestamp 20260615000000 is shared by 6/);
  });

  it('the grandfather list matches the collisions that really exist on disk', () => {
    const onDisk = readdirSync(path.join(ROOT, MIG)).filter(n => /^\d{14}_/.test(n));
    const byStamp = new Map<string, string[]>();
    for (const n of onDisk) {
      const s = n.slice(0, 14);
      byStamp.set(s, [...(byStamp.get(s) ?? []), n]);
    }
    const dups = Object.fromEntries(
      [...byStamp].filter(([, v]) => v.length > 1).map(([k, v]) => [k, v.sort()])
    );
    const listed = Object.fromEntries(
      Object.entries(GRANDFATHERED_DUPLICATES).map(([k, v]) => [k, [...(v as string[])].sort()])
    );
    expect(dups).toEqual(listed);
  });
});

/** Env for spawning git: strip every GIT_* var so a hook's GIT_DIR/GIT_INDEX_FILE cannot leak in. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: tmpdir(),
    GIT_AUTHOR_NAME: 'gate',
    GIT_AUTHOR_EMAIL: 'gate@example.invalid',
    GIT_COMMITTER_NAME: 'gate',
    GIT_COMMITTER_EMAIL: 'gate@example.invalid',
  };
}

describe('check-migration-order.mjs (end to end, real git repo)', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

  function repo(mainFolders: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mig-order-'));
    dirs.push(dir);
    const env = cleanEnv();
    const git = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    };
    const add = (name: string) => {
      mkdirSync(path.join(dir, MIG, name), { recursive: true });
      writeFileSync(path.join(dir, MIG, name, 'migration.sql'), 'SELECT 1;\n');
    };
    git('init', '-q', '-b', 'main');
    mainFolders.forEach(add);
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const run = (base = 'main') =>
      spawnSync('node', [SCRIPT, '--base', base], { cwd: dir, env, encoding: 'utf8' });
    return { add, run };
  }

  it('exits 0 for a correctly ordered new migration', () => {
    const r = repo(MAIN);
    r.add('20261002090000_new_thing');
    const res = r.run();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/1 new vs main \(20261002090000_new_thing\)/);
  });

  it('exits 1 on the payment_config_key_fingerprint collision', () => {
    const r = repo(MAIN);
    r.add('20261001120000_payment_config_key_fingerprint');
    const res = r.run();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(
      /::error::migration-order: 20261001120000_payment_config_key_fingerprint/
    );
  });

  it('fails CLOSED (exit 2) when the base ref cannot be read', () => {
    const res = repo(MAIN).run('no-such-ref');
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/cannot read/);
  });
});

describe('ci.yml runs the gate on every PR', () => {
  it('the guards job (no `needs`, no `if`, always runs) fetches main and runs the script', () => {
    const ci = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { needs?: unknown; if?: string; steps: Array<{ run?: string }> }>;
    };
    const guards = ci.jobs.guards;
    expect(guards.needs).toBeUndefined();
    expect(guards.if).toBeUndefined();
    const run = guards.steps.map(s => s.run ?? '').join('\n');
    expect(run).toMatch(/node scripts\/check-migration-order\.mjs --fetch --base origin\/main/);
    // The fetch lives in the script (depth only inside Actions), never as a bare
    // `git fetch --depth` a person or agent can copy into the shared repo.
    expect(run).not.toMatch(/git fetch/);
  });

  it('issue 2355: on a push to main it compares against the PRE-push tip, not origin/main', () => {
    const ci = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<
        string,
        { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
      >;
    };
    const step = ci.jobs.guards.steps.find(s => s.name === 'Migration ordering gate')!;
    expect(step.env?.BEFORE_SHA).toBe('${{ github.event.before }}');
    expect(step.run).toMatch(
      /if \[ "\$EVENT_NAME" = "push" \]; then\s+node scripts\/check-migration-order\.mjs --fetch --base "\$BEFORE_SHA"/
    );
  });
});

describe('post-merge arm (issue 2355): two PRs that each passed against the same old main', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

  /**
   * origin: main has MAIN. PR A adds 20261002090000_a_new, PR B adds
   * 20261002080000_b_new; both sort after main's newest, so each passes its
   * PR-time check. A merges, then B. On B's push the pre-push tip (A's merge)
   * already holds A's later folder, so B's must fail.
   */
  function pushed(second: string) {
    const env = cleanEnv();
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    const root = mkdtempSync(path.join(tmpdir(), 'mig-post-'));
    dirs.push(root);
    const sh = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const add = (dir: string, name: string) => {
      mkdirSync(path.join(dir, MIG, name), { recursive: true });
      writeFileSync(path.join(dir, MIG, name, 'migration.sql'), 'SELECT 1;\n');
    };
    const src = path.join(root, 'src');
    mkdirSync(src);
    sh(src, 'init', '-q', '-b', 'main');
    sh(src, 'config', 'user.email', 't@t.com');
    sh(src, 'config', 'user.name', 't');
    MAIN.forEach(n => add(src, n));
    sh(src, 'add', '.');
    sh(src, 'commit', '-q', '-m', 'base');
    add(src, '20261002090000_a_new');
    sh(src, 'add', '.');
    sh(src, 'commit', '-q', '-m', 'merge A');
    const before = sh(src, 'rev-parse', 'HEAD');
    add(src, second);
    sh(src, 'add', '.');
    sh(src, 'commit', '-q', '-m', 'merge B');
    const work = path.join(root, 'work');
    sh(root, 'clone', '-q', `file://${src}`, work);
    const gate = (base: string) =>
      spawnSync('node', [SCRIPT, '--fetch', '--base', base], { cwd: work, env, encoding: 'utf8' });
    return { gate, before };
  }

  it('fails on main when the second merge sorts before the first', () => {
    const { gate, before } = pushed('20261002080000_b_new');
    const r = gate(before);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toMatch(
      /20261002080000_b_new: timestamp .* does not sort after .*20261002090000_a_new/
    );
  });

  it('control: the PR-time arm (origin/main = the pushed commit) compares nothing and passes', () => {
    const { gate } = pushed('20261002080000_b_new');
    const r = gate('origin/main');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/0 new vs origin\/main/);
  });

  it('passes on main when the second merge sorts after the first', () => {
    const { gate, before } = pushed('20261002100000_b_new');
    const r = gate(before);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/1 new vs [0-9a-f]{40} \(20261002100000_b_new\)/);
  });

  it('fails CLOSED on the null sha', () => {
    const { gate } = pushed('20261002100000_b_new');
    expect(gate('0'.repeat(40)).status).toBe(2);
  });

  it('fetchArgs fetches a sha by id (no refspec) and keeps depth Actions-only', () => {
    const sha = 'a'.repeat(40);
    expect(fetchArgs({}, sha)).toEqual(['fetch', '--no-tags', 'origin', sha]);
    expect(fetchArgs({ CI: 'true', GITHUB_ACTIONS: 'true' }, sha)).toContain('--depth=1');
  });
});

describe('the gate never makes a developer/agent repo shallow (2026-09-30, twice)', () => {
  it('fetchArgs passes --depth ONLY when CI=true AND GITHUB_ACTIONS=true', () => {
    for (const env of [
      {},
      { CI: 'true' },
      { GITHUB_ACTIONS: 'true' },
      { CI: '1', GITHUB_ACTIONS: 'true' },
    ]) {
      expect(
        fetchArgs(env).some((a: string) => a.startsWith('--depth')),
        JSON.stringify(env)
      ).toBe(false);
    }
    expect(fetchArgs({ CI: 'true', GITHUB_ACTIONS: 'true' })).toContain('--depth=1');
  });

  // The ONLY scripts allowed a shallow `git fetch`, each with the reason. Adding one needs a reason a reviewer can check: it must be CI-only by
  // construction (the script refuses outside GitHub Actions) so it can never make a developer or agent repo shallow.
  const ALLOWED_SHALLOW_FETCH: Record<string, string> = {
    'scripts/ci/ensure-full-clone.sh':
      'CI-only: refuses to run unless GITHUB_ACTIONS=true (tests/unit/ci-ensure-full-clone.test.ts pins the refusal); refetches the depth-1 CI workspace without a leftover partial-clone filter (Ruling CI-TRUFFLE-PARTIAL-1)',
  };

  it('the shallow-fetch allow-list is exactly the CI-only full-clone script, and that script refuses outside GitHub Actions', () => {
    expect(Object.keys(ALLOWED_SHALLOW_FETCH)).toEqual(['scripts/ci/ensure-full-clone.sh']);
    const src = readFileSync(path.join(ROOT, 'scripts/ci/ensure-full-clone.sh'), 'utf8');
    expect(src).toMatch(/\[ "\$\{GITHUB_ACTIONS:-\}" = true \] \|\| \{[^\n]*exit 2/);
    expect(src).toContain('git fetch --no-tags --refetch --depth=1 origin');
  });

  it('no workflow run step, script or hook runs a bare shallow `git fetch`', () => {
    const roots = ['.github/workflows', 'scripts', '.husky'];
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) {
          if (n.name !== 'node_modules') walk(p);
          continue;
        }
        if (path.relative(ROOT, p) in ALLOWED_SHALLOW_FETCH) continue;
        readFileSync(p, 'utf8')
          .split('\n')
          .forEach((l, i) => {
            if (/^\s*(#|\*|\/\/)/.test(l)) return; // prose, not a command
            if (/git fetch[^\n]*--depth/.test(l) || /\bfetch[^\n]*--depth[^\n]*origin/.test(l))
              offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${l.trim()}`);
          });
      }
    };
    roots.forEach(r => walk(path.join(ROOT, r)));
    expect(offenders).toEqual([]);
  });

  const dirs: string[] = [];
  afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

  /** A full clone of a 3-commit origin, plus a runner for the gate inside it. */
  function cloneWithHistory() {
    const env = cleanEnv();
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    const root = mkdtempSync(path.join(tmpdir(), 'mig-shallow-'));
    dirs.push(root);
    const sh = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const src = path.join(root, 'src');
    mkdirSync(path.join(src, MIG, '20260101000000_a'), { recursive: true });
    writeFileSync(path.join(src, MIG, '20260101000000_a', 'migration.sql'), 'SELECT 1;\n');
    sh(src, 'init', '-q', '-b', 'main');
    for (const n of ['1', '2', '3']) {
      writeFileSync(path.join(src, `f${n}`), n);
      sh(src, 'add', '.');
      sh(src, 'commit', '-q', '-m', n);
    }
    const work = path.join(root, 'work');
    // file:// so git honours --depth exactly as it would against GitHub.
    sh(root, 'clone', '-q', `file://${src}`, work);
    const gate = (extra: Record<string, string> = {}) =>
      spawnSync('node', [SCRIPT, '--fetch', '--base', 'origin/main'], {
        cwd: work,
        env: { ...env, ...extra },
        encoding: 'utf8',
      });
    const shallow = () => sh(work, 'rev-parse', '--is-shallow-repository');
    return { gate, shallow };
  }

  it('run locally (CI unset) it fetches main and the repo stays FULL', () => {
    const c = cloneWithHistory();
    const r = c.gate();
    expect(r.status, r.stderr).toBe(0);
    expect(c.shallow()).toBe('false');
  });

  it('control: the same run with the Actions env DOES go shallow — the check above can see it', () => {
    const c = cloneWithHistory();
    const r = c.gate({ CI: 'true', GITHUB_ACTIONS: 'true' });
    expect(r.status, r.stderr).toBe(0);
    expect(c.shallow()).toBe('true');
  });
});
