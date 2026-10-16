/**
 * Every hand-written `rollback.sql` tells the operator to delete the migration's
 * `_prisma_migrations` row. Without that step a later `prisma migrate deploy` sees the migration
 * as applied and skips it, so the rolled-back objects are never recreated (Task 9 review M4).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../packages/database/prisma/migrations');
const withRollback = readdirSync(DIR).filter(d => existsSync(path.join(DIR, d, 'rollback.sql')));

describe('migration rollback.sql notes', () => {
  it('finds rollback files', () => {
    expect(withRollback.length).toBeGreaterThan(0);
  });

  it('each one names its own _prisma_migrations row to delete', () => {
    const missing = withRollback.filter(d => {
      const sql = readFileSync(path.join(DIR, d, 'rollback.sql'), 'utf8');
      return !new RegExp(
        String.raw`DELETE FROM "?_prisma_migrations"? WHERE migration_name = '${d}'`
      ).test(sql);
    });
    expect(missing).toEqual([]);
  });
});
