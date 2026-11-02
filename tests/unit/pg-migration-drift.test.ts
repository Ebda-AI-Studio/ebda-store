/** Ruling MIGRATION-DRIFT-1: the drift check's comparison, and that the workflow is wired read-only. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { missingMigrations, listOnDisk } from '../../scripts/ci/pg-migration-drift.mjs';

const ROOT = path.resolve(__dirname, '../..');
const MIG = path.join(ROOT, 'packages/database/prisma/migrations');

describe('pg-migration-drift', () => {
  it('names exactly the migrations on disk that the database lacks', () => {
    expect(missingMigrations(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect(missingMigrations(['a'], ['a', 'old-renamed'])).toEqual([]);
    expect(missingMigrations(['b', 'a'], [])).toEqual(['a', 'b']);
  });

  it('scans the real migrations directory (not an empty-set pass)', () => {
    const disk = listOnDisk(MIG);
    expect(disk.length).toBeGreaterThan(100);
    expect(disk).toEqual(
      readdirSync(MIG, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort()
    );
    expect(disk).toContain('20261107000280_ci_insights_hints');
  });

  it('the workflow only runs the read-only script and is off hosted runners on schedule', () => {
    const wf = readFileSync(path.join(ROOT, '.github/workflows/pg-migration-drift.yml'), 'utf8');
    expect(wf).toContain('node scripts/ci/pg-migration-drift.mjs');
    expect(wf).toMatch(/github\.event_name != 'schedule' \|\| vars\.EBDA_RUNS_ON != ''/);
    expect(wf).not.toMatch(/prisma migrate|migrate deploy|DROP|INSERT|UPDATE |DELETE /);
    const script = readFileSync(path.join(ROOT, 'scripts/ci/pg-migration-drift.mjs'), 'utf8');
    expect(script).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b\s/);
  });
});
