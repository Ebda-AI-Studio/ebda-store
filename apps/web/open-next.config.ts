import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';

// R2-backed ISR/SSG incremental cache (bucket already exists: force-web-isr-cache,
// bound as NEXT_INC_CACHE_R2_BUCKET in wrangler.jsonc). Without this, OpenNext
// falls back to an in-memory cache that's cold on every Worker isolate restart —
// every ISR/SSG page revalidates from origin instead of serving from cache.
export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache });
