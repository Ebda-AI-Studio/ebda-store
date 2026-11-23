import fs from 'node:fs';

const DIR = new URL('../../packages/cf-schema/migrations/platform/', import.meta.url);

/** Every numbered platform D1 migration, in order: a test D1 must look like production, not just 0001 + 0002. */
export const PLATFORM_MIGRATION_FILES: string[] = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => fs.readFileSync(new URL(f, DIR), 'utf8'));

export const PLATFORM_MIGRATION_SQL: string = PLATFORM_MIGRATION_FILES.join('\n');
