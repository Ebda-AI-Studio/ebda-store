#!/usr/bin/env node
// Writes apps/api/.wrangler.local.jsonc: apps/api/wrangler.jsonc without the Workers AI binding.
// An `AI` binding always runs REMOTELY, so a plain `wrangler dev` opens a remote proxy session and
// refuses to start without a Cloudflare login (measured 2026-10-16, wrangler 4.116: "Failed to
// start the remote proxy session"). Local dev (`npm run cf:dev -w apps/api`, stage1-exit-run.sh)
// boots this copy: no AI binding -> no embedding provider -> lexical search, which the boot check
// accepts while SEARCH_SEMANTIC_ENABLED is "false". `npm run cf:dev:ai -w apps/api` keeps the
// binding for someone logged in to the Whisky account (billed per token). Ruling SEARCH-T10-4.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { stripAiBinding } from './ci/workerd-smoke.mjs';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/api');

/** The local dev config text: the same strip the workerd smoke uses. */
export function localDevConfig(source) {
  return stripAiBinding(source);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(
    path.join(API, '.wrangler.local.jsonc'),
    localDevConfig(readFileSync(path.join(API, 'wrangler.jsonc'), 'utf8'))
  );
}
