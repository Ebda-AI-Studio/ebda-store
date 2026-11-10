/**
 * Ruling WEB-COLD-2: `scripts/cf-setup-local.sh` (web, OPENNEXT_CACHE=true) bakes the storefront's fetch-cache
 * data-contract hash into the generated config by running `scripts/ci/fetch-contract-version.mjs` over the contract
 * files. A test that runs the generator in a scratch copy of the repo seeds both with this helper.
 */
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs script, no types
import { CONTRACT_PATHS } from '../../scripts/ci/fetch-contract-version.mjs';

const ROOT = path.resolve(__dirname, '../..');

export function seedFetchContract(scratch: string): void {
  mkdirSync(path.join(scratch, 'scripts/ci'), { recursive: true });
  cpSync(
    path.join(ROOT, 'scripts/ci/fetch-contract-version.mjs'),
    path.join(scratch, 'scripts/ci/fetch-contract-version.mjs')
  );
  for (const p of CONTRACT_PATHS as string[])
    cpSync(path.join(ROOT, p), path.join(scratch, p), { recursive: true });
}
