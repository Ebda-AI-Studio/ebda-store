#!/usr/bin/env node
/**
 * Backport of the @opennextjs/cloudflare Next 16.4 fix (Ruling DEP-OPENNEXT-PREVIEW-1).
 *
 * Next 16.4 constructs its server by calling `loadManifest(".next/server/preview-props.json")`.
 * @opennextjs/cloudflare 1.19.11 inlines manifests at build time but its glob
 * (`**\/{*-manifest,required-server-files,prefetch-hints}.json`) does not include that file, so
 * on workerd EVERY request threw `Unexpected loadManifest(/.next/server/preview-props.json) call!`
 * (HTTP 500) after the #256 `next` 16.3.8 -> 16.4.3 bump, while the build and CI stayed green.
 * Adapter >= 1.20.12 fixes it but peers `wrangler ^4.148`, which pulls a miniflare 5 alpha (barred
 * by DEP-WRANGLER-1). Until that can move, apply the same one-glob change to the installed adapter.
 *
 *   node scripts/ci/patch-opennext-preview-props.mjs   (idempotent; run by scripts/cf-build.sh)
 *
 * Fails loudly when the adapter shape changed and the fix is not already there, so it can never
 * silently stop patching. Delete this file + its cf-build.sh call once the adapter is >= 1.20.12.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = path.join(
  ROOT,
  'node_modules/@opennextjs/cloudflare/dist/cli/build/patches/plugins/load-manifest.js',
);

const OLD = `    const manifests = await glob(join(dotNextDir, "**/{*-manifest,required-server-files,prefetch-hints}.json"), {
        windowsPathsNoEscape: true,
    });`;
const NEW = `    const manifests = await glob([
        join(dotNextDir, "**/{*-manifest,required-server-files,prefetch-hints}.json"),
        join(dotNextDir, "server/preview-props.json"),
    ], {
        windowsPathsNoEscape: true,
        nodir: true,
    });`;

/** Pure transform, exported for the unit test. Returns { source, changed }. */
export function patchLoadManifest(source) {
  if (source.includes('server/preview-props.json')) return { source, changed: false };
  if (!source.includes(OLD)) {
    throw new Error(
      'patch-opennext-preview-props: load-manifest.js has neither the preview-props fix nor the ' +
        'expected 1.19.11 glob. Upgrade the adapter (>= 1.20.12) or update this script.',
    );
  }
  return { source: source.replace(OLD, NEW), changed: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(FILE)) throw new Error(`patch-opennext-preview-props: ${FILE} not found (npm ci first)`);
  const { source, changed } = patchLoadManifest(readFileSync(FILE, 'utf8'));
  if (changed) writeFileSync(FILE, source);
  console.log(`patch-opennext-preview-props: ${changed ? 'patched' : 'already patched'}`);
}
