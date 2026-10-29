#!/usr/bin/env node
/**
 * Regenerates apps/api/src/cf/stubs/mime-db.json from the installed `mime-db` (Ruling BUNDLE-BUDGET-5).
 *   node scripts/ci/gen-mime-db-slim.mjs          write
 *   node scripts/ci/gen-mime-db-slim.mjs --check  exit 1 when the committed file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { slimMimeDb } from './api-bundle-slimming.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SLIM_PATH = path.join(ROOT, 'apps/api/src/cf/stubs/mime-db.json');

export function renderSlimMimeDb() {
  const db = createRequire(import.meta.url)('mime-db');
  return JSON.stringify(slimMimeDb(db)) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const next = renderSlimMimeDb();
  if (process.argv.includes('--check')) {
    if (readFileSync(SLIM_PATH, 'utf8') !== next) {
      console.error('mime-db.json is stale: run node scripts/ci/gen-mime-db-slim.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(SLIM_PATH, next);
    console.log(`wrote ${SLIM_PATH} (${next.length} B)`);
  }
}
