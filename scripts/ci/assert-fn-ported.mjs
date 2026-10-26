#!/usr/bin/env node
/**
 * Cutover gate (audit DB-3 / M-045): refuse while docs/cf/fn-unported.json lists any Postgres function or trigger
 * whose Cloudflare replacement has no contract test. flip-backend.mjs --to do and the cutover runbook call this.
 *   node scripts/ci/assert-fn-ported.mjs        exit 0 = every function has a real test, exit 1 = list the rest
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { unported } = JSON.parse(readFileSync(path.join(root, 'docs/cf/fn-unported.json'), 'utf8'));
if (unported.length) {
  console.error(
    `${unported.length} function(s) have no contract test yet:\n- ${unported.join('\n- ')}`
  );
  process.exit(1);
}
console.log('every mapped function has a contract test');
