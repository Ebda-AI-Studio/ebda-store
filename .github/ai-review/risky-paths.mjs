#!/usr/bin/env node
// Classifies changed file paths as risky (money / auth / data / migrations). Reads one path per line on stdin and
// prints the risky ones. Matching is on whole path TOKENS (split on / . _ - and camelCase), not substrings: the old
// drain regex matched `cod` inside `codemod` and `role` inside `controller`, which held harmless PRs forever.
// usage: git diff --name-only base...head | node risky-paths.mjs        exit 0 always; empty output = not risky
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RISKY_WORDS = [
  'billing', 'payment', 'refund', 'checkout', 'coupon', 'promotion', 'discount', 'wallet', 'ledger', 'invoice',
  'instapay', 'kashier', 'cod', 'money', 'price', 'pricing', 'auth', 'authn', 'authz', 'authentication',
  'authorization', 'identity', 'session', 'passkey', 'mfa', 'erasure', 'pdpl', 'migration', 'tenant',
  'permission', 'role', 'webhook', 'secret',
];
const WORDS = new Set(RISKY_WORDS);

export function tokens(path) {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const singular = (t) => (t.endsWith('ies') ? t.slice(0, -3) + 'y' : t.endsWith('es') && WORDS.has(t.slice(0, -2)) ? t.slice(0, -2) : t.endsWith('s') ? t.slice(0, -1) : t);

export function isRisky(path) {
  return tokens(path).some((t) => WORDS.has(t) || WORDS.has(singular(t)));
}

export const riskyPaths = (paths) => paths.filter((p) => p.trim() && isRisky(p.trim()));

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = riskyPaths(readFileSync(0, 'utf8').split('\n'));
  if (out.length) process.stdout.write(out.join('\n') + '\n');
}
