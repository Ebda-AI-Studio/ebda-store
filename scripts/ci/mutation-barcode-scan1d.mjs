#!/usr/bin/env node
/**
 * Mutation check for the in-house 1D reader (Ruling BARCODE-1a): each mutation removes ONE safety
 * rule from packages/shared/src/barcode/scan1d.ts and the reader's test file must go RED. A
 * mutation that leaves the tests green means a rule is untested. The source file is restored in
 * `finally`, and again from the byte-for-byte backup if anything throws.
 *
 *   node scripts/ci/mutation-barcode-scan1d.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const file = resolve(root, 'packages/shared/src/barcode/scan1d.ts');
const original = readFileSync(file, 'utf8');

const MUTATIONS = [
  ['code128 checksum not verified', 'if (sum % 103 !== codes[codes.length - 1]) return null;', ''],
  [
    'quiet zone not required',
    'export const MIN_QUIET_MODULES = 6;',
    'export const MIN_QUIET_MODULES = 0;',
  ],
  ['contrast floor removed', 'export const MIN_CONTRAST = 80;', 'export const MIN_CONTRAST = 0;'],
  [
    'a single scanline is enough',
    'const minAgree = opts.minAgree ?? 2;',
    'const minAgree = opts.minAgree ?? 1;',
  ],
  [
    'EAN-13 check digit not verified',
    'return isValidEan13(value) ? value : null;',
    'return value;',
  ],
  [
    'right-to-left reads removed',
    '      { quietL: runs.quietR, widths: [...runs.widths].reverse(), quietR: runs.quietL },\n',
    '',
  ],
  [
    'selfCheck accepts any readable code (value not compared)',
    "const matches = !!got && (got === expected || (r.kind === 'ean13' && got === `0${expected}`));",
    'const matches = !!got;',
  ],
  [
    'pattern tolerance wide open',
    'const MAX_PATTERN_ERROR = 2.2;',
    'const MAX_PATTERN_ERROR = 50;',
  ],
];

let survived = 0;
try {
  for (const [name, from, to] of MUTATIONS) {
    if (!original.includes(from)) {
      console.error(`MUTATION TARGET NOT FOUND: ${name}`);
      process.exitCode = 2;
      continue;
    }
    writeFileSync(file, original.replace(from, to));
    const r = spawnSync('npx', ['vitest', 'run', 'tests/unit/barcode-scan1d.test.ts'], {
      cwd: root,
      encoding: 'utf8',
    });
    const killed = r.status !== 0;
    if (!killed) survived++;
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'}  ${name}`);
  }
} finally {
  writeFileSync(file, original);
}
if (survived || process.exitCode) {
  console.error(`${survived} mutation(s) survived: the reader has an untested rule.`);
  process.exit(1);
}
console.log('all mutations killed');
