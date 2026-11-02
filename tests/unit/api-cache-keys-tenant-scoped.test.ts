/**
 * SP4 / Review Focus 1 — every API cache entry that holds store-specific data
 * is keyed by the store (id, or the canonical host / slug that resolves to
 * exactly one store). A key with no tenant component is a cross-tenant leak
 * waiting for its second tenant.
 *
 * This is a static sweep over `apps/api/src`: it finds every `getCached(` /
 * `getCachedAnalytics(` call, resolves the key expression (following a
 * `const <name> = …` in the same file), and requires a tenant token. The
 * behavioural half (store A then store B at the same path) lives in
 * `store-host-resolver.test.ts`; this guard makes adding an UNKEYED cache
 * fail loudly instead of passing a two-store test nobody wrote.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(__dirname, '../../apps/api/src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

/** Text of the first argument of the call whose `(` is at `open`. */
function firstArg(src: string, open: number): string {
  let depth = 0;
  let inTpl = 0;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '`') inTpl = inTpl ? 0 : 1;
    if (inTpl) continue;
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return src.slice(open + 1, i).trim();
      depth--;
    }
    if (c === ',' && depth === 0) return src.slice(open + 1, i).trim();
  }
  return '';
}

const TENANT_TOKEN = /storeId|store\.id|slugOrId|cacheHost|lookup\./;
/** Key builders that take the store id as their argument (checked at their definition). */
const KEY_BUILDERS = new Set(['bundlesCacheKey', 'customersCacheKey']);
/**
 * lib/store-directory.ts (NEON-SCALE-1 rule 1): the platform store DIRECTORY, keyed by the id / slug / verified domain that
 * resolves to exactly ONE store. Not store data, so it carries no storeId; its builder is pinned below.
 */
const DIRECTORY_BUILDERS = new Set(['directoryCacheKey']);

interface Finding {
  file: string;
  key: string;
}

function collect(): Finding[] {
  const out: Finding[] = [];
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (file.endsWith('lib/public-cache.ts')) continue; // the helper itself
    const re = /\b(getCached|getCachedAnalytics)\s*(?:<[^>(]*>)?\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      // Skip the definitions and doc mentions.
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/function\s+$|\*\s+$|\/\/\s*$/.test(before)) continue;
      let key = firstArg(src, m.index + m[0].length - 1)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .trim();
      if (!key) continue;
      const ident = key.match(/^([A-Za-z_]\w*)(\(|$)/);
      if (ident && !KEY_BUILDERS.has(ident[1])) {
        const def = new RegExp(`const\\s+${ident[1]}\\s*=\\s*([\\s\\S]{0,400}?);`).exec(
          src.slice(0, m.index)
        );
        if (def) key = def[1];
      }
      out.push({ file: relative(ROOT, file), key });
    }
  }
  return out;
}

describe('API cache keys are tenant-scoped', () => {
  const findings = collect();

  it('finds the public + admin caches (the sweep is not vacuous)', () => {
    expect(findings.length).toBeGreaterThanOrEqual(10);
    expect(findings.some(f => f.file.endsWith('routes/public.routes.ts'))).toBe(true);
  });

  it('every getCached / getCachedAnalytics key carries a tenant token', () => {
    const unkeyed = findings.filter(
      f =>
        !KEY_BUILDERS.has(f.key.split('(')[0]) &&
        !DIRECTORY_BUILDERS.has(f.key.split('(')[0]) &&
        !TENANT_TOKEN.test(f.key)
    );
    expect(unkeyed).toEqual([]);
  });

  it('the shared key builders embed the store id', () => {
    const src = readFileSync(join(ROOT, 'lib/public-cache.ts'), 'utf8');
    for (const name of KEY_BUILDERS) {
      const def = new RegExp(
        `function\\s+${name}\\s*\\(\\s*storeId[^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`
      ).exec(src);
      expect(def, `${name} must take a storeId`).not.toBeNull();
      expect(def![1]).toContain('${storeId}');
    }
  });

  it('there is no store-agnostic "default store" cache key anywhere in the API', () => {
    for (const file of walk(ROOT)) {
      expect(readFileSync(file, 'utf8'), relative(ROOT, file)).not.toMatch(
        /public:store:default|['"`]store:default['"`]/
      );
    }
  });

  it('no public route falls back to "the first store" (findFirst ordered by createdAt, no where)', () => {
    const src = readFileSync(join(ROOT, 'routes/public.routes.ts'), 'utf8');
    expect(src).not.toMatch(/store\.findFirst\(\s*\{\s*orderBy/);
    expect(src).not.toMatch(/GET \/store - Get default store/);
  });
});
