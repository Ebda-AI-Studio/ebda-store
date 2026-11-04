#!/usr/bin/env node
/**
 * Merge the per-track i18n fragments into the admin message files.
 *
 *   node scripts/merge-i18n-fragments.mjs            # write ar.json / en.json
 *   node scripts/merge-i18n-fragments.mjs --check    # exit 1 when a write would change anything
 *
 * Fragments live at apps/admin/src/i18n/fragments/<track>.<locale>.json as nested objects shaped like the message
 * files. Rules (admin fix pass, plan section 1):
 *  - fragment keys WIN over the base file (that is how a track overrides an existing Egyptian-register string);
 *  - two DIFFERENT fragments may not define the same leaf key: the run fails and names both owners;
 *  - idempotent: running it twice leaves the files byte-identical (key order of the base file is kept, new keys are
 *    appended in fragment order).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge `src` into `dst` (mutates dst). Fragment values win. */
export function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v) && isObj(dst[k])) deepMerge(dst[k], v);
    else dst[k] = isObj(v) ? deepMerge({}, v) : v;
  }
  return dst;
}

/** Every leaf path of a nested object, dot-joined. */
export function leafPaths(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    isObj(v) ? leafPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

/**
 * @param {Record<string, object>} fragments  fragment name -> nested object
 * @returns {{ merged: object, conflicts: string[] }}
 */
export function mergeFragments(base, fragments) {
  const owners = new Map();
  const conflicts = [];
  const merged = structuredClone(base);
  for (const [name, frag] of Object.entries(fragments)) {
    for (const path of leafPaths(frag)) {
      const prev = owners.get(path);
      if (prev && prev !== name) conflicts.push(`${path} is defined by both "${prev}" and "${name}"`);
      else owners.set(path, name);
    }
    deepMerge(merged, frag);
  }
  return { merged, conflicts };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const i18n = join(root, 'apps/admin/src/i18n');
  const fragDir = join(i18n, 'fragments');
  const check = process.argv.includes('--check');
  let failed = false;
  for (const locale of ['ar', 'en']) {
    const basePath = join(i18n, 'messages', `${locale}.json`);
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    const files = existsSync(fragDir)
      ? readdirSync(fragDir).filter(f => f.endsWith(`.${locale}.json`)).sort()
      : [];
    const fragments = Object.fromEntries(
      files.map(f => [f.slice(0, -`.${locale}.json`.length), JSON.parse(readFileSync(join(fragDir, f), 'utf8'))])
    );
    const { merged, conflicts } = mergeFragments(base, fragments);
    if (conflicts.length) {
      console.error(`[${locale}] key conflicts:\n  ${conflicts.join('\n  ')}`);
      failed = true;
      continue;
    }
    const next = JSON.stringify(merged, null, 2) + '\n';
    const prev = readFileSync(basePath, 'utf8');
    if (next === prev) {
      console.log(`[${locale}] up to date (${files.length} fragment(s))`);
    } else if (check) {
      console.error(`[${locale}] would change; run node scripts/merge-i18n-fragments.mjs`);
      failed = true;
    } else {
      writeFileSync(basePath, next);
      console.log(`[${locale}] merged ${files.length} fragment(s)`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
