#!/usr/bin/env node
// Ruling WEB-MW-DUP-2: after the web build, prove Next compiled a middleware and that it is OURS (the nonce CSP code),
// not an empty or stale one. Usage: node scripts/ci/assert-web-middleware.mjs [apps/web]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const app = resolve(process.argv[2] ?? 'apps/web');
const server = join(app, '.next', 'server');
const manifestPath = join(server, 'middleware-manifest.json');
let seen = '(manifest not read)';
const fail = msg => {
  console.error(`assert-web-middleware: ${msg}`);
  console.error(`assert-web-middleware: what was found: ${seen}`);
  process.exit(1);
};
if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
seen = `top-level keys=${JSON.stringify(Object.keys(manifest))}; middleware keys=${JSON.stringify(
  Object.keys(manifest.middleware ?? {})
)}; functions keys=${JSON.stringify(Object.keys(manifest.functions ?? {}))}; entry fields=${JSON.stringify(
  Object.values(manifest.middleware ?? {}).flatMap(e => Object.keys(e))
)}; .next/server files=${JSON.stringify(readdirSync(server).filter(f => /middleware|proxy/i.test(f)))}`;
const entries = Object.values(manifest.middleware ?? {});
if (entries.length === 0) fail('middleware-manifest.json has no middleware entry');
const files = entries.flatMap(e => e.files ?? []).map(f => join(app, '.next', f));
if (files.length === 0) fail('the middleware entry lists no bundle files');
const text = files.filter(existsSync).map(f => readFileSync(f, 'utf8')).join('\n');
if (!text) fail('none of the middleware bundle files exist');
// 'x-nonce' is a string literal in the root middleware (minifiers keep it; they mangle function names).
if (!text.includes('x-nonce')) fail('the middleware bundle does not contain the nonce CSP code (x-nonce)');
console.log(`assert-web-middleware: ok (${files.length} bundle file(s), nonce CSP present)`);
