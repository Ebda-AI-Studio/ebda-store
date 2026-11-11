/**
 * The strict-RLS migration must run on Neon, where the project owner has CREATEROLE + BYPASSRLS but
 * is NOT a real superuser: `ALTER ROLE ebda_app NOSUPERUSER NOBYPASSRLS ...` then fails with "Only
 * roles with the SUPERUSER attribute may change the SUPERUSER attribute", so a fresh Neon project
 * could not migrate. `CREATE ROLE` already yields the strict attributes, so the ALTER must only run
 * for a pre-existing role that deviates. The real proof is a migrate deploy on Postgres with a
 * non-superuser owner (see PR); this guards the source shape against a regression.
 *
 * Mutation-proof: restoring the unconditional ALTER reddens the second test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    __dirname,
    '../../packages/database/prisma/migrations/20261004000000_ebda_strict_rls/migration.sql'
  ),
  'utf8'
);
// SQL has no parser in this repo (and no pg in unit tests), so this is a tokenised, comment-stripped structure scoped to the
// exact plpgsql statement: dollar-quoted DO blocks are extracted, then IF / THEN / ELSE / END IF are matched with a stack, so
// "the ALTER sits in the THEN branch of an IF EXISTS(...) over pg_roles" is a property of the parse, not a text window.
const code = sql
  .split('\n')
  .map(l => l.replace(/--.*$/, ''))
  .join('\n');

interface IfFrame {
  cond: string;
  branch: 'then' | 'else';
}

/** The IF frames (outermost first) enclosing the first match of `needle` inside the dollar-quoted DO block holding it. */
function enclosingIfs(needle: RegExp): IfFrame[] {
  const blocks = [...code.matchAll(/DO\s+\$(\w*)\$([\s\S]*?)\$\1\$/g)].map(m => m[2]!);
  const block = blocks.find(b => needle.test(b));
  if (!block) throw new Error(`no DO block contains ${needle}`);
  const stack: Array<IfFrame & { condStart: number; inCond: boolean }> = [];
  const re = new RegExp(
    `\\bEND\\s+IF\\b|\\bIF\\b|\\bTHEN\\b|\\bELSE\\b|\\bELSIF\\b|(${needle.source})`,
    'gi'
  );
  for (const m of block.matchAll(re)) {
    const t = m[0].toUpperCase().replace(/\s+/g, ' ');
    if (m[1]) return stack.map(({ cond, branch }) => ({ cond, branch }));
    if (t === 'END IF') stack.pop();
    else if (t === 'IF')
      stack.push({ cond: '', branch: 'then', condStart: m.index! + 2, inCond: true });
    else if (t === 'THEN') {
      const top = stack.at(-1)!;
      if (top.inCond) {
        top.cond = block.slice(top.condStart, m.index!).replace(/\s+/g, ' ').trim();
        top.inCond = false;
      }
    } else if (t === 'ELSE' || t === 'ELSIF') stack.at(-1)!.branch = 'else';
  }
  throw new Error(`${needle} not reached`);
}

describe('20261004000000_ebda_strict_rls role statement is Neon-safe', () => {
  it('creates ebda_app NOLOGIN when absent', () => {
    const ifs = enclosingIfs(/CREATE ROLE ebda_app NOLOGIN;/);
    expect(ifs).toHaveLength(1);
    expect(ifs[0]).toMatchObject({ branch: 'then' });
    expect(ifs[0]!.cond).toMatch(
      /^NOT EXISTS \(SELECT FROM pg_roles WHERE rolname = 'ebda_app'\)$/i
    );
  });

  it('only ALTERs the role when it deviates from the strict attributes', () => {
    const ifs = enclosingIfs(/ALTER ROLE ebda_app NOSUPERUSER/);
    expect(ifs, 'the ALTER is guarded by exactly one IF').toHaveLength(1);
    const [guard] = ifs;
    expect(guard!.branch).toBe('then');
    // a POSITIVE existence test over pg_roles for ebda_app ...
    expect(guard!.cond).toMatch(/^EXISTS \(/i);
    expect(guard!.cond).toMatch(/FROM pg_roles/i);
    expect(guard!.cond).toMatch(/rolname = 'ebda_app'/i);
    // ... on every strict attribute the ALTER normalises
    for (const col of [
      'rolsuper',
      'rolbypassrls',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
    ]) {
      expect(guard!.cond).toContain(col);
    }
  });
});
