#!/usr/bin/env node
// Prints the apps/api workerd test files the PR lane runs: every workers-test/**/*.test.ts except those
// listed in workers-test/full-lane-only.txt. Discovery by glob means adding a test never edits a shared CI line
// (the hand-maintained file list in ci.yml re-conflicted every PR that added a test). The full lane runs
// `cf:test` with no file arguments, i.e. every file, so no workerd test is ever orphaned.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/api');

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory()
      ? walk(path.join(dir, e.name), base)
      : e.name.endsWith('.test.ts')
        ? [path.relative(path.dirname(base), path.join(dir, e.name)).split(path.sep).join('/')]
        : []
  );
}

export function fullLaneOnly(api = API) {
  return readFileSync(path.join(api, 'workers-test/full-lane-only.txt'), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

export function allWorkersTests(api = API) {
  return walk(path.join(api, 'workers-test')).sort();
}

export function prLaneTests(api = API) {
  const skip = new Set(fullLaneOnly(api));
  return allWorkersTests(api).filter(f => !skip.has(f));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(prLaneTests().join(' '));
}
