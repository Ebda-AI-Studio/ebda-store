// Ruling WEB-COLD-2 (amended): the DATA-CONTRACT version of the storefront's shared fetch cache.
//
// The storefront's data cache survives a deploy (apps/web/shared-fetch-cache.ts), so the entries a new build reads may
// have been written by the previous build. That is only safe while both builds expect the same SHAPE of API data. This
// script hashes the files that define that shape; `scripts/cf-setup-local.sh` bakes the hash into the shared cache key
// at build time, so a deploy that changes any of them starts a fresh, empty namespace (the old behaviour), and a deploy
// that does not keeps the warm cache. No hand-bumped constant, so nothing to forget.
//
// CONTRACT_PATHS = what the storefront parses API JSON into:
//   - packages/shared/src/types    shared response/entity types (Product, Category, Store, layout settings, ...)
//   - packages/shared/src/schemas  Zod schemas of the API payloads
//   - packages/shared/src/builder  page-builder definition schema (the layout endpoint's `definition`)
//   - apps/web/src/lib/store-resolver.ts  the storefront's ResolvedStore (store resolve payload)
// Over-inclusion only costs one cold render per store after such a deploy; under-inclusion is the bug, so when a new
// storefront fetch parses a payload into a type defined elsewhere, add that file here (tests/unit/web-fetch-contract.test.ts).
//
// Usage (repo root):  node scripts/ci/fetch-contract-version.mjs   -> prints 16 hex chars
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_PATHS = [
  'packages/shared/src/types',
  'packages/shared/src/schemas',
  'packages/shared/src/builder',
  'apps/web/src/lib/store-resolver.ts',
];

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|json)$/;
const NOT_CONTRACT = /(\.test\.|\.spec\.|__tests__)/;

function walk(abs, out) {
  const st = statSync(abs);
  if (st.isFile()) {
    out.push(abs);
    return;
  }
  for (const name of readdirSync(abs).sort()) walk(path.join(abs, name), out);
}

/** The contract files under `root`, sorted, repo-relative with `/` separators. Throws if a contract path is missing. */
export function contractFiles(root, paths = CONTRACT_PATHS) {
  const files = [];
  for (const p of paths) walk(path.join(root, p), files);
  return files
    .map(f => path.relative(root, f).split(path.sep).join('/'))
    .filter(f => SOURCE.test(f) && !NOT_CONTRACT.test(f))
    .sort();
}

/** 16 hex chars: sha256 over every contract file's path and bytes. Changes iff a contract file changes. */
export function contractVersion(root, paths = CONTRACT_PATHS) {
  const h = createHash('sha256');
  const files = contractFiles(root, paths);
  if (files.length === 0) throw new Error('fetch-contract-version: no contract files found');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(path.join(root, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// Real paths on both sides: a symlinked tmp dir (/var -> /private/var) must still count as "run directly".
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const root = path.resolve(path.dirname(self), '../..');
  process.stdout.write(contractVersion(root) + '\n');
}
