/**
 * #696 — the storefront's persistent (R2) fetch cache is tenant-keyed.
 *
 * Several storefront server fetches hit a URL that is IDENTICAL across tenants
 * (`${API_URL}/public/products/<slug>`) and name the store only in the
 * `X-Store-ID` request header. The worry was that Next's fetch Data Cache
 * ignores custom request headers, so two stores sharing a slug would share one
 * R2 entry. It does not: Next 16's `IncrementalCache.generateCacheKey` hashes
 * the request headers (minus traceparent/tracestate) into the key, and
 * OpenNext's r2IncrementalCache stores under sha256(that key). This pins both
 * halves so a Next upgrade that changes the key, or a fetch that drops the
 * header, goes red instead of silently merging tenants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { IncrementalCache } = require('next/dist/server/lib/incremental-cache');

const URL_ = 'https://api.force-ai.co/api/v1/public/products/shoes';

function keyFor(storeId: string, tags: string[] = ['products:fixed']): Promise<string> {
  return IncrementalCache.prototype.generateCacheKey.call({ fetchCacheKeyPrefix: '' }, URL_, {
    headers: { 'Content-Type': 'application/json', 'X-Store-ID': storeId },
    next: { revalidate: 60, tags },
  });
}

describe('Next fetch-cache key folds in the X-Store-ID header (#696)', () => {
  it('two stores fetching the same slug URL get different cache keys — ONLY the header differs', async () => {
    // Same URL, same tags, same everything else: the header is the only
    // variable, so a difference here can only come from the header.
    expect(await keyFor('store-a')).not.toBe(await keyFor('store-b'));
  });

  it('mirror control: the same header with DIFFERENT tags gives the SAME key', async () => {
    // Tags are revalidation targets, not key identity. If this ever differs,
    // the per-tenant `products:<storeId>` tag would be doing the keying and
    // the test above would no longer isolate the header.
    expect(await keyFor('store-a', ['products:store-a'])).toBe(
      await keyFor('store-a', ['products:store-b'])
    );
  });

  it('the same store gets a stable key (control: the key is not just random)', async () => {
    expect(await keyFor('store-a')).toBe(await keyFor('store-a'));
  });
});

describe('every cached storefront fetch of a tenant-agnostic /public/products URL sends X-Store-ID', () => {
  const WEB_SRC = path.resolve(__dirname, '../../apps/web/src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) files.push(p);
    }
  };
  walk(WEB_SRC);

  // `fetch(`${API_URL}/public/products...` — the URL carries no store id.
  const CALL = /fetch\(\s*`\$\{API_URL\}\/public\/products[^`]*`\s*,\s*\{/g;

  it('finds the call sites (positive control)', () => {
    const count = files.reduce(
      (n, f) => n + (readFileSync(f, 'utf-8').match(CALL)?.length ?? 0),
      0
    );
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('each one names the store in its request headers', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8');
      for (const m of src.matchAll(CALL)) {
        // The init object is the next ~12 lines; it must carry the tenant
        // header, either literally or via the shared `storeHeaders` object.
        const init = src.slice(m.index!, m.index! + 600);
        if (!/'X-Store-ID'|storeHeaders/.test(init)) {
          missing.push(`${path.relative(WEB_SRC, f)}@${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
