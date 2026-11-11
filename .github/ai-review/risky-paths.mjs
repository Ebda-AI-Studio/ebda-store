#!/usr/bin/env node
// Decides which changed paths need the independent AI review. FAIL CLOSED: a path is exempt only when it is provably
// harmless (markdown, docs/, test files); EVERYTHING else needs review. A word list of "risky" names (the first version)
// was open by construction: it missed packages/database, schema.prisma, order.routes, RLS, and the gate's own files.
// Reads one path per line on stdin, prints the paths that need review. Empty output = an all-safe diff (docs/tests/md only).
//   git diff --name-only --no-renames base...head | node risky-paths.mjs
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKDOWN = /\.(?:md|mdx)$/i;
const DOC_ASSET = /^docs\/.+\.(?:md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|e2e|tests?)\//;

/** true only for docs / markdown / tests: nothing that runs in production or in CI */
export function isSafe(path) {
  const p = path.trim().replace(/^\.\//, '');
  // .github/ holds the gate, its prompt (markdown!) and the workflows: never exempt, whatever the extension
  if (!p || p.includes('..') || p.startsWith('.github/')) return false;
  return MARKDOWN.test(p) || DOC_ASSET.test(p) || TEST_FILE.test(p) || TEST_DIR.test(p);
}

export const isRisky = (path) => !isSafe(path);
export const riskyPaths = (paths) => paths.map((p) => p.trim()).filter((p) => p && !isSafe(p));

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = riskyPaths(readFileSync(0, 'utf8').split('\n'));
  if (out.length) process.stdout.write(out.join('\n') + '\n');
}
