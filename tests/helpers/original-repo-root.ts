import path from 'node:path';

/**
 * Repo root of the ORIGINAL (uninstrumented) checkout.
 *
 * Stryker runs the unit tier inside `<repo>/stryker-tmp/sandbox-*` after instrumenting every file in
 * `stryker.conf.json` `mutate` (the text becomes `// @ts-nocheck\nfunction stryNS_...`). A test that
 * asserts on the SOURCE TEXT of such a file must read the original from the real checkout, or
 * Stryker's initial dry run fails and the whole mutation job is red. Outside Stryker this is just the
 * repo root.
 */
export const ORIGINAL_ROOT = path
  .resolve(__dirname, '../..')
  .replace(/[\\/]stryker-tmp[\\/]sandbox-[^\\/]+$/, '');
