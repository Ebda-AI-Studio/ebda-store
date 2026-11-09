// Ruling EDGE-BUILD-1: the Worker version id that partitions both HTML edge caches, and its wiring.
// The cross-build behaviour of each layer is in demo-edge-cache.test.ts and store-edge-cache.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildScopedKey, edgeBuildId } from '../../apps/web/edge-build-id';

const ROOT = path.resolve(__dirname, '../..');
const VERSION = 'b66bf413-e28d-4a48-a882-704fbf604904';

describe('edgeBuildId', () => {
  it('is the Worker version id of the version_metadata binding', () => {
    expect(edgeBuildId({ CF_VERSION_METADATA: { id: VERSION } })).toBe(VERSION);
  });
  it.each([
    ['no binding', {}],
    ['a null binding', { CF_VERSION_METADATA: null }],
    ['no id', { CF_VERSION_METADATA: {} }],
    ['an empty id', { CF_VERSION_METADATA: { id: '' } }],
    ['a blank id', { CF_VERSION_METADATA: { id: '        ' } }],
    ['a non-string id', { CF_VERSION_METADATA: { id: 12345678 } }],
    ['a too-short id', { CF_VERSION_METADATA: { id: 'abc' } }],
    [
      'an id that would change the key shape',
      { CF_VERSION_METADATA: { id: `${VERSION}&__lang=en` } },
    ],
    ['an id with a path', { CF_VERSION_METADATA: { id: '../../aaaaaaaa' } }],
  ])('%s -> null (the layers then do not cache)', (_name, env) => {
    expect(edgeBuildId(env as never)).toBeNull();
  });
});

describe('buildScopedKey', () => {
  it('appends the build to a key with and without a query, and stays a parseable URL of the same host', () => {
    expect(buildScopedKey('https://storedemo.ebda.app/en', VERSION)).toBe(
      `https://storedemo.ebda.app/en?__build=${VERSION}`
    );
    const scoped = buildScopedKey('https://shop.example.com/ar?__edge=store', VERSION);
    expect(scoped).toBe(`https://shop.example.com/ar?__edge=store&__build=${VERSION}`);
    expect(new URL(scoped).hostname).toBe('shop.example.com');
    expect(new URL(scoped).searchParams.get('__build')).toBe(VERSION);
  });
  it('two builds never share a key', () => {
    const k = 'https://storedemo.ebda.app/ar?look=qamar.lookbook';
    expect(buildScopedKey(k, VERSION)).not.toBe(buildScopedKey(k, VERSION.replace('b66', 'c77')));
  });
});

describe('wiring: the id must exist in the Worker that ships, and reach both layers', () => {
  it('the Worker entry reads the id from env and hands it to the demo and the store layer', () => {
    const entry = readFileSync(path.join(ROOT, 'apps/web/sentry-worker-entry.ts'), 'utf8');
    expect(entry).toContain('const build = edgeBuildId(env);');
    // store layer: a `build` dep; demo layer: the argument after the resolver callback.
    expect(entry).toMatch(/cache: edgeCache,\s+build,/);
    expect(entry).toMatch(/isDemoStoreHost\(host, DEMO_EDGE_API_URL\),\s+build\s+\)/);
  });
  it('the config generator gives every storefront config the version_metadata binding', () => {
    const gen = readFileSync(path.join(ROOT, 'scripts/cf-setup-local.sh'), 'utf8');
    const all = gen.match(/"version_metadata": \{ "binding": "CF_VERSION_METADATA" \}/g) ?? [];
    expect(all.length).toBe((gen.match(/cat > "\$dir\/wrangler\.jsonc"/g) ?? []).length);
    expect(all.length).toBeGreaterThan(0);
  });
});
