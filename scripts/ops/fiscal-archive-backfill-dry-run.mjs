// Ruling FISCAL-ARCHIVE-1. READ-ONLY. Lists the DO stores that were deleted BEFORE the platform fiscal archive existed (retired D1
// directory row: storage_backend='do' AND deleted_at IS NOT NULL) and says which still have no archive manifest in R2 ebda-private.
// It never writes. The export itself is the admin-only API path (super admin + MFA), one store at a time:
//   POST /api/v1/admin/fiscal-archive/<storeId>/backfill            -> dry run (counts the closed DO's rows, shows any manifest)
//   POST /api/v1/admin/fiscal-archive/<storeId>/backfill?apply=1    -> export (idempotent, refuses to shrink an archive)
// Usage: node scripts/ops/fiscal-archive-backfill-dry-run.mjs [--local] [--config apps/api/.wrangler.deploy.jsonc]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { d1Query } from '../cf/lib/d1.mjs';
const run = promisify(execFile);

export const DIRECTORY_SQL =
  "SELECT id, name, slug, deleted_at FROM stores WHERE storage_backend = 'do' AND deleted_at IS NOT NULL ORDER BY deleted_at";

/** Pure: which retired DO stores still need an export. */
export function plan(stores, archivedIds) {
  const have = new Set(archivedIds);
  return {
    total: stores.length,
    archived: stores.filter(s => have.has(s.id)).length,
    todo: stores.filter(s => !have.has(s.id)),
  };
}

async function hasManifest(id, remote, config) {
  try {
    await run(
      'npx',
      [
        'wrangler',
        'r2',
        'object',
        'get',
        `ebda-private/fiscal-archive/v1/manifests/${id}.json`,
        remote ? '--remote' : '--local',
        '--pipe',
        ...(config ? ['-c', config] : []),
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const remote = !args.includes('--local');
  const ci = args.indexOf('--config');
  const config = ci >= 0 ? args[ci + 1] : undefined;
  const stores = await d1Query(
    { db: 'ebda-platform', target: remote ? 'remote' : 'local', config },
    DIRECTORY_SQL
  );
  const archived = [];
  for (const s of stores) if (await hasManifest(s.id, remote, config)) archived.push(s.id);
  const p = plan(stores, archived);
  console.log(
    `retired DO stores: ${p.total}; already archived: ${p.archived}; need export: ${p.todo.length}`
  );
  for (const s of p.todo)
    console.log(
      `  ${s.id}  ${s.slug}  deleted ${new Date(Number(s.deleted_at)).toISOString()}  -> POST /api/v1/admin/fiscal-archive/${s.id}/backfill?apply=1`
    );
  console.log('read-only: nothing was written.');
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
