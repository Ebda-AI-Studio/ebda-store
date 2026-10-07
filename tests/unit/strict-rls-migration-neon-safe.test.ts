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
const code = sql
  .split('\n')
  .filter(l => !l.trim().startsWith('--'))
  .join('\n');

describe('20261004000000_ebda_strict_rls role statement is Neon-safe', () => {
  it('creates ebda_app NOLOGIN when absent', () => {
    expect(code).toMatch(/CREATE ROLE ebda_app NOLOGIN;/);
  });

  it('only ALTERs the role when it deviates from the strict attributes', () => {
    const alter = code.indexOf('ALTER ROLE ebda_app NOSUPERUSER');
    expect(alter).toBeGreaterThan(-1);
    const guard = code.lastIndexOf('IF EXISTS', alter);
    expect(guard).toBeGreaterThan(code.indexOf('CREATE ROLE ebda_app NOLOGIN;'));
    const between = code.slice(guard, alter);
    for (const col of [
      'rolsuper',
      'rolbypassrls',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
    ]) {
      expect(between).toContain(col);
    }
  });
});
