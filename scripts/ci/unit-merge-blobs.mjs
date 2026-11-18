#!/usr/bin/env node
/**
 * The unit-test merge job (`vitest --merge-reports`) and its two failure modes (Ruling UNIT-MERGE-ROOTS-1, 2026-11-18).
 *
 * vitest keeps only the blob entries whose ABSOLUTE paths sit under the merge job's checkout root. The shards and the merge job run on different
 * self-hosted runners (…/actions-runner-ebda/_work/ebda-store/ebda-store vs …/actions-runner-ebda-2/_work/ebda-store/ebda-store):
 *   - no blob matches  -> "No test files found, exiting with code 1" with no failure text (group run 44343978493 on #951);
 *   - SOME blobs match -> the others are DROPPED SILENTLY: #955's group run 44326426543 merged "1386 passed | 3 skipped (1389)" of 2083 files, one whole
 *     shard missing from the merged report and from the coverage the threshold is computed on.
 *
 *   node scripts/ci/unit-merge-blobs.mjs reroot <blobs dir> <checkout root>   rewrite every `<runner root>/_work/<repo>/<repo>` prefix to <checkout root>
 *   node scripts/ci/unit-merge-blobs.mjs check  <blobs dir> <merge log>       fail unless the merged "Test Files (N)" == the sum of the shards' file counts
 *
 * A blob is a flatted array: [ref-array, version, files (one entry per test file), errors, ...]; the file count of a shard is `blob[2].length`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `<anything without a quote, backslash, space or paren>/_work/<name>/<name>`: the runner's workspace root inside a path string. */
const ROOT_RE = /\/[^"\\\s()]*?\/_work\/([^/"\\\s()]+)\/\1(?=\/|["\\\s)]|$)/g;

/** Rewrites every runner workspace root in a blob's text to `root`. Returns the new text and how many were rewritten. */
export function rerootText(text, root) {
  let n = 0;
  const out = text.replace(ROOT_RE, () => {
    n += 1;
    return root;
  });
  return { text: out, n };
}

/** The shard's test-file count from a blob's parsed JSON. */
export function blobFileCount(blob) {
  if (!Array.isArray(blob) || !Array.isArray(blob[2])) throw new Error('not a vitest blob: entry 2 (the files) is missing');
  return blob[2].length;
}

/** The merged total from vitest's default reporter: ` Test Files  2080 passed | 3 skipped (2083)` -> 2083. */
export function mergedFileTotal(log) {
  const m = /^\s*Test Files\s.*\((\d+)\)\s*$/m.exec(log);
  return m ? Number(m[1]) : null;
}

export function reroot(dir, root) {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no blobs in ${dir}`);
  let total = 0;
  for (const f of files) {
    const p = join(dir, f);
    const { text, n } = rerootText(readFileSync(p, 'utf8'), root);
    if (n === 0) throw new Error(`${f}: no runner workspace root found to rewrite (is this a vitest blob from this repo?)`);
    writeFileSync(p, text);
    total += n;
    console.log(`reroot: ${f}: ${n} path(s) now under ${root}`);
  }
  return total;
}

export function check(dir, logText) {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  let expected = 0;
  for (const f of files) expected += blobFileCount(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const merged = mergedFileTotal(logText);
  if (merged === null) throw new Error('the merge log has no "Test Files … (N)" line: the merge did not report a result');
  if (merged !== expected)
    throw new Error(`the merged report has ${merged} test files but the ${files.length} shard blobs carry ${expected}: ${expected - merged} test file(s) were DROPPED from the merge`);
  console.log(`check: merged ${merged} test files == ${expected} from ${files.length} shard blobs`);
  return expected;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'reroot' && a && b) reroot(a, b);
    else if (cmd === 'check' && a && b) check(a, readFileSync(b, 'utf8'));
    else throw new Error('usage: unit-merge-blobs.mjs reroot <blobs dir> <checkout root> | check <blobs dir> <merge log>');
  } catch (e) {
    console.error(`::error::unit-merge-blobs: ${e.message}`);
    process.exit(1);
  }
}
