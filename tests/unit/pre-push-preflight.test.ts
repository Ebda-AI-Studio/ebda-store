/**
 * Pre-push preflight (scripts/ci/pre-push-preflight.mjs): the three classes of CI waste Ahmad called out on 2026-10-26.
 * Each refusal is proven on a real throw-away git repo, and mutation-checked by the *_PASSES counterpart beside it.
 */
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain .mjs without types
import {
  cronProblems,
  cronsIn,
  preflight,
  unregisteredMigrations,
} from '../../scripts/ci/pre-push-preflight.mjs';
import { cleanGitEnv, initSandboxRepo } from '../helpers/git-env';

const ROOT = join(__dirname, '../..');
const MIG = 'packages/database/prisma/migrations';

function repo() {
  const { dir, git } = initSandboxRepo('preflight-');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(
    join(ROOT, 'scripts/check-migration-order.mjs'),
    join(dir, 'scripts/check-migration-order.mjs')
  );
  mkdirSync(join(dir, MIG, '20261101000000_base'), { recursive: true });
  writeFileSync(join(dir, MIG, '20261101000000_base/migration.sql'), '-- base\n');
  mkdirSync(join(dir, 'apps/api'), { recursive: true });
  writeFileSync(
    join(dir, 'apps/api/wrangler.jsonc'),
    '{ "triggers": { "crons": ["0 2 * * MON", "*/15 * * * *"] } }\n'
  );
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}
const pf = (dir: string, registry = '/nonexistent') =>
  preflight({ root: dir, registry, base: 'main', fetch: false, env: cleanGitEnv() });

describe('preflight: merges cleanly into the fresh main', () => {
  it('REFUSES a branch that conflicts with main and names the file', () => {
    const { dir, git } = repo();
    git('checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'f.txt'), 'branch\n');
    git('commit', '-qam', 'branch edit');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'f.txt'), 'main\n');
    git('commit', '-qam', 'main edit');
    git('checkout', '-q', 'feat');
    const r = pf(dir);
    expect(r.refusals.join('\n')).toMatch(/does not merge cleanly into main.*f\.txt.*Rebase/s);
  });
  it('PASSES a branch that merges cleanly', () => {
    const { dir, git } = repo();
    git('checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'g.txt'), 'x\n');
    git('add', 'g.txt');
    git('commit', '-qm', 'add g');
    expect(pf(dir).refusals).toEqual([]);
  });
});

describe('preflight: migration order + controller registry', () => {
  const addMigration = (dir: string, git: (...a: string[]) => string, name: string) => {
    git('checkout', '-q', '-b', 'feat');
    mkdirSync(join(dir, MIG, name), { recursive: true });
    writeFileSync(join(dir, MIG, name, 'migration.sql'), '-- m\n');
    git('add', '-A');
    git('commit', '-qm', 'migration');
  };
  it('REFUSES a new migration number the controller did not register', () => {
    const { dir, git } = repo();
    addMigration(dir, git, '20261105000100_surprise');
    const reg = join(dir, 'registry.md');
    writeFileSync(reg, '- #218 -> 20261104000100..20261104000400\n- #233 -> 20261103000250_x\n');
    expect(pf(dir, reg).refusals.join('\n')).toMatch(
      /not in the controller's "Migration number registry": 20261105000100_surprise/
    );
  });
  it('PASSES a registered number (exact and inside a range)', () => {
    const { dir, git } = repo();
    addMigration(dir, git, '20261104000200_in_range');
    const reg = join(dir, 'registry.md');
    writeFileSync(reg, '- #218 -> 20261104000100..20261104000400\n');
    expect(pf(dir, reg).refusals).toEqual([]);
  });
  it('REFUSES a migration that sorts before main (repo check, fresh main)', () => {
    const { dir, git } = repo();
    addMigration(dir, git, '20261031000000_too_old');
    const reg = join(dir, 'registry.md');
    writeFileSync(reg, '20261031000000\n');
    expect(pf(dir, reg).refusals.join('\n')).toMatch(/migration order/);
  });
  it('an unreadable registry WARNS and the repo check still runs', () => {
    const { dir, git } = repo();
    addMigration(dir, git, '20261105000100_surprise');
    const r = pf(dir, '/nonexistent/registry.md');
    expect(r.warnings.join('\n')).toMatch(/registry unreadable/);
    expect(r.refusals).toEqual([]);
  });
  it('unregisteredMigrations is exact', () => {
    expect(unregisteredMigrations(['20261104000500_a'], '20261104000500_a')).toEqual([]);
    expect(unregisteredMigrations(['20261104000501_a'], '20261104000500_a')).toEqual([
      '20261104000501_a',
    ]);
  });
});

describe('preflight: wrangler crons use weekday names (diff-scoped)', () => {
  const setCrons = (dir: string, crons: string[]) =>
    writeFileSync(
      join(dir, 'apps/api/wrangler.jsonc'),
      `{\n // c\n "triggers": { "crons": ${JSON.stringify(crons)} } }\n`
    );
  it('REFUSES a numeric weekday ADDED or CHANGED in the push', () => {
    const { dir, git } = repo();
    git('checkout', '-q', '-b', 'feat');
    setCrons(dir, ['0 2 * * MON', '*/15 * * * *', '0 3 * * 0', '0 2 * * 1']);
    git('commit', '-qam', 'add crons');
    const r = pf(dir);
    expect(r.refusals.filter((x: string) => x.includes('day-of-week')).length).toBe(2);
  });
  it('only WARNS about a violation that already exists on main (an in-flight fix elsewhere must not block every push)', () => {
    const { dir, git } = repo();
    setCrons(dir, ['0 3 * * 0']);
    git('commit', '-qam', 'main already has a numeric weekday');
    git('checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'g.txt'), 'x\n');
    git('add', 'g.txt');
    git('commit', '-qm', 'unrelated');
    const r = pf(dir);
    expect(r.refusals).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/day-of-week.*already on main/);
  });
  it('PASSES names, ranges of names and *', () => {
    for (const c of [
      '0 3 * * SUN',
      '0 3 * * MON-FRI',
      '0 3 * * *',
      '0 3 * * MON,WED',
      '*/15 * * * *',
    ])
      expect(cronProblems(c)).toEqual([]);
  });
  it('rejects numbers in lists and ranges', () => {
    expect(cronProblems('0 3 * * 1-5').length).toBe(1);
    expect(cronProblems('0 3 * * MON,3').length).toBe(1);
  });
  it('cronsIn ignores comments', () => {
    expect(cronsIn('{ // "crons": ["1 1 * * 1"]\n "crons": ["0 0 * * SUN"] }')).toEqual([
      '0 0 * * SUN',
    ]);
  });
});

describe('the gate runs the preflight first', () => {
  it('pre-push-gate.sh calls it before the plan', async () => {
    const { readFileSync } = await import('node:fs');
    const g = readFileSync(join(ROOT, 'scripts/ci/pre-push-gate.sh'), 'utf8');
    expect(g.indexOf('node scripts/ci/pre-push-preflight.mjs')).toBeGreaterThan(0);
    expect(g.indexOf('node scripts/ci/pre-push-preflight.mjs')).toBeLessThan(
      g.indexOf('node scripts/ci/pre-push-plan.mjs')
    );
  });
});
