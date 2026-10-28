/**
 * Guard (Ruling ITEST-4): integration tests set the `ebda_app` login through `setAppRoleLogin`
 * (tests/helpers/app-role-login.ts), never a bare `ALTER ROLE ebda_app`. Roles are cluster-global, so on a
 * shared Postgres two concurrent bare ALTERs answer "tuple concurrently updated", the file's beforeAll fails
 * and every test in it is skipped. Self-tested on good and bad snippets so the scan cannot go blind.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BARE = /ALTER\s+ROLE\s+ebda_app\b/i;
export const offends = (src: string) => BARE.test(src);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  );

describe('no bare ALTER ROLE ebda_app in the integration suites', () => {
  it('the scan itself: flags the bare forms, passes the helper call', () => {
    expect(
      offends(`await owner.$executeRawUnsafe(\`ALTER ROLE ebda_app WITH LOGIN PASSWORD 'x'\`)`)
    ).toBe(true);
    expect(
      offends('await prisma.$executeRawUnsafe("alter  role ebda_app with login password \'x\'")')
    ).toBe(true);
    expect(offends('await setAppRoleLogin(owner, APP_PASSWORD);')).toBe(false);
  });

  it('no integration file contains one', () => {
    const root = join(__dirname, '..', 'integration');
    const bad = walk(root).filter(f => offends(readFileSync(f, 'utf8')));
    expect(bad.map(f => f.slice(root.length + 1))).toEqual([]);
  });
});
