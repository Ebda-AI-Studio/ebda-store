/**
 * Ruling DEMO-LAYOUT-PURGE-1: the demo showroom's layout response cache is cleared by every publish path.
 * Every publish / rollback / layout PUT / look apply ends in `bustStoreCaches` (pinned by
 * layout-save-purges-storefront-cache.test.ts and the page-builder purge contract), so the key must be cleared there,
 * and the route must fill through `getCached` (generation guard), never a bare `redis.set` that a racing read could use to
 * write the old layout back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSource, findFunction, callsTo } from './helpers/ts-ast';

const calls = vi.hoisted(() => ({ del: [] as string[], bump: [] as string[] }));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    get: async () => null,
    set: async () => undefined,
    delete: async (k: string) => void calls.del.push(k),
    deleteByPattern: async () => 0,
    getCacheGenerations: async (names: string[]) => names.map(() => '0'),
    bumpCacheGeneration: async (n: string) => void calls.bump.push(n),
  },
}));
vi.mock('../../apps/api/src/lib/store-directory', () => ({
  invalidateStoreDirectory: async () => undefined,
}));
vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({ revalidateStorefront: () => {} }));

const { bustStoreCaches } = await import('../../apps/api/src/services/store.service');
const { demoLayoutCacheKey } = await import('../../apps/api/src/lib/demo-layout-cache-key');

beforeEach(() => {
  calls.del.length = 0;
  calls.bump.length = 0;
});

describe('demo layout cache is purged on publish', () => {
  it('bustStoreCaches (every publish path) bumps the generation and deletes the demo layout key', async () => {
    await bustStoreCaches('store-1', 'storedemo-lamma', null);
    const key = demoLayoutCacheKey('store-1');
    expect(calls.bump).toContain(key);
    expect(calls.del).toContain(key);
    expect(calls.bump.indexOf(key)).toBeGreaterThan(-1);
  });
  it('the route reads and fills the key through getCached only (no bare redis.set of the layout)', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/public-store-layout.routes.ts'),
      'utf8'
    );
    expect(src).toContain('getCached(\n          demoKey');
    expect(src).not.toMatch(/redis\.set\(\s*demoKey/);
    expect(src).toContain('demoLayoutCacheKey(storeId)');
    // only demo rows are ever stored
    expect(src).toContain('cacheIf: v => v?.isDemo === true');
  });
  it('the demo-home seed route publishes through publishDraft (which purges via bustStoreCaches)', () => {
    const routes = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/routes/demo-home.routes.ts'),
      'utf8'
    );
    expect(routes).toMatch(/await publishDraft\(/);
    // AST call-chain: publishDraft -> applyPublishedLayout -> purgePublishedCaches -> bustStoreCaches.
    // The functions are real declarations and the calls real CallExpressions inside them, so a
    // comment, or a call sitting in a different function, cannot satisfy a link. Behaviour is not
    // practical: publishDraft needs the page-builder DB rig, and the purge end itself is already
    // exercised above through bustStoreCaches.
    const sf = parseSource(
      path.resolve(__dirname, '../../apps/api/src/services/page-builder.service.ts')
    );
    const calls = (fn: string, callee: string) => {
      const decl = findFunction(sf, fn);
      expect(decl, `${fn} not found`).toBeDefined();
      return callsTo(decl!, callee);
    };
    expect(calls('publishDraft', 'applyPublishedLayout').length).toBeGreaterThan(0);
    expect(calls('applyPublishedLayout', 'purgePublishedCaches').length).toBeGreaterThan(0);
    const bust = calls('purgePublishedCaches', 'bustStoreCaches');
    expect(bust.map(c => c.arguments.map(a => a.getText()).join(','))).toContain(
      'storeId,slug,domain'
    );
  });
});
