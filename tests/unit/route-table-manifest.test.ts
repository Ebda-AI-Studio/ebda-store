/**
 * N-15: the route manifest the Workers route sweep (apps/api/workers-test/route-sweep.test.ts) walks. The sweep runs inside
 * workerd, where the Express router table cannot be imported, so the REAL table (`@api/routes`, every mount, every nested
 * router) is flattened here into `apps/api/workers-test/route-table.json`. This test fails when the checked-in file is stale;
 * regenerate with `WRITE_ROUTE_TABLE=1 npx vitest run tests/unit/route-table-manifest.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
  keys: Array<{ name: string }>;
}

function mountPrefix(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  let i = 0;
  src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys[i++]?.name ?? 'param'}`);
  // Express 4.21 spells a param mount `(?:/([^/]+?))` once the slashes are unescaped.
  return src
    .replace(/\\\//g, '/')
    .replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g, () => `/:${layer.keys[i++]?.name ?? 'param'}`);
}

function collect(stack: Layer[], prefix: string, out: Array<[string, string]>) {
  for (const layer of stack) {
    if (layer.route) {
      const p = typeof layer.route.path === 'string' ? layer.route.path : String(layer.route.path);
      for (const m of Object.keys(layer.route.methods)) out.push([m.toUpperCase(), prefix + p]);
    } else if (Array.isArray(layer.handle?.stack)) {
      collect(layer.handle.stack, prefix + mountPrefix(layer), out);
    }
  }
}

const FILE = path.resolve(__dirname, '../../apps/api/workers-test/route-table.json');

describe('route table manifest (N-15)', () => {
  it('apps/api/workers-test/route-table.json matches the real router table', async () => {
    const { default: apiRoutes } = await import('@api/routes');
    const found: Array<[string, string]> = [];
    collect((apiRoutes as unknown as { stack: Layer[] }).stack, '', found);
    const uniq = [...new Set(found.map(([m, p]) => `${m} ${p}`))].sort();
    expect(uniq.length).toBeGreaterThan(200);
    const text = JSON.stringify(uniq, null, 1) + '\n';
    if (process.env.WRITE_ROUTE_TABLE === '1') writeFileSync(FILE, text);
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  }, 60_000);
});
