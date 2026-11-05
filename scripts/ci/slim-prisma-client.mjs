#!/usr/bin/env node
/**
 * Post-`prisma generate` step: rewrite the `inlineSchema` string of every generated client entry with the slimmed
 * schema (scripts/ci/api-bundle-slimming.mjs, Ruling BUNDLE-BUDGET-5). Idempotent. Usage:
 *   node scripts/ci/slim-prisma-client.mjs [<generated client dir>]   (default: node_modules/.prisma/client)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { slimPrismaSchema } from './api-bundle-slimming.mjs';

const INLINE = /("inlineSchema": )("(?:[^"\\]|\\.)*")/;

/** Returns the bytes saved in one generated file (0 when it has no inline schema). */
export function slimGeneratedFile(file) {
  const src = readFileSync(file, 'utf8');
  const m = INLINE.exec(src);
  if (!m) return 0;
  const slim = JSON.stringify(slimPrismaSchema(JSON.parse(m[2])));
  if (slim.length >= m[2].length) return 0;
  writeFileSync(
    file,
    src.replace(INLINE, (_all, key) => key + slim)
  );
  return m[2].length - slim.length;
}

export function slimGeneratedClient(dir) {
  let saved = 0;
  for (const f of ['wasm.js', 'edge.js', 'index.js']) {
    const p = path.join(dir, f);
    if (existsSync(p)) saved += slimGeneratedFile(p);
  }
  return saved;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir =
    process.argv[2] ??
    path.join(
      path.dirname(createRequire(import.meta.url).resolve('@prisma/client/package.json')),
      '../../.prisma/client'
    );
  console.log(`slim-prisma-client: ${dir}: -${slimGeneratedClient(dir)} B`);
}
