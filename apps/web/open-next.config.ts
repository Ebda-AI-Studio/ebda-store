// ⚠️  REGENERATED AT DEPLOY TIME — EDITING THIS FILE CHANGES NOTHING IN PROD.
//
// `.github/workflows/cf-web-deploy.yml` runs `scripts/cf-setup-local.sh web` BEFORE
// the build, and that script OVERWRITES this file unconditionally. Whatever is
// committed here is replaced by the generator's output, so a cache override,
// binding or entry point added here alone is dead weight that deploys as a
// no-op while the repo, the docs and a green pipeline all say otherwise.
//
// This is not hypothetical: a D1 tag cache was added here on 2026-09-02,
// documented as REQUIRED, given its own migration step, and never once
// deployed. The live worker's bindings (confirmed against the Cloudflare API)
// are NEXT_TAG_CACHE_DO_SHARDED, NEXT_CACHE_DO_QUEUE and
// NEXT_INC_CACHE_R2_BUCKET — the OPENNEXT_CACHE=true branch of the generator.
//
// To change what actually deploys, edit scripts/cf-setup-local.sh.
// To verify what IS deployed, read the worker's bindings, not this file.

import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from './shared-fetch-cache'; // fetch entries survive a deploy (Ruling WEB-COLD-2)

// R2-backed ISR/SSG incremental cache (bucket already exists: ebda-web-isr-cache,
// bound as NEXT_INC_CACHE_R2_BUCKET in wrangler.jsonc). Without this, OpenNext
// falls back to an in-memory cache that's cold on every Worker isolate restart —
// every ISR/SSG page revalidates from origin instead of serving from cache.
export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache });
