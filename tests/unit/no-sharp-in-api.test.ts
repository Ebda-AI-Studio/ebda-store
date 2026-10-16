/**
 * The API runs on Cloudflare Workers (workerd), where `sharp` (a native addon) cannot load.
 * Every code path that imported it (PWA icons, the upload resizer, Gemini rasterizing) was
 * broken in production while its Node tests stayed green (Ruling FU46-8). So `sharp` is gone
 * from the API entirely:
 *
 * - no import (static, dynamic or require) anywhere under `apps/api/**` (src, scripts,
 *   workers-test, configs) or in the workspace packages the API bundles
 *   (`@ebda/shared`, `@ebda/database`);
 * - no `sharp` dependency in apps/api/package.json;
 * - no wrangler alias and no stub that would quietly make an import bundle.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['apps/api', 'packages/shared', 'packages/database'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.turbo', 'coverage', 'generated']);
const IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]sharp['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(p);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

/** Every source file under the scanned roots that imports `sharp`. */
function sharpImporters(roots: readonly string[] = ROOTS): string[] {
  return roots
    .flatMap(r => walk(r))
    .filter(f => IMPORT.test(readFileSync(f, 'utf8')))
    .map(f => relative('.', f));
}

describe('no sharp in the API or the packages it bundles', () => {
  it('no source file imports sharp', () => {
    expect(sharpImporters()).toEqual([]);
  });

  it('apps/api/package.json does not depend on sharp', () => {
    const pkg = JSON.parse(readFileSync('apps/api/package.json', 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      expect(pkg[field]?.sharp, field).toBeUndefined();
    }
  });

  it('wrangler has no sharp alias and the stub is gone', () => {
    expect(readFileSync('apps/api/wrangler.jsonc', 'utf8')).not.toMatch(/["']sharp["']\s*:/);
    expect(existsSync('apps/api/src/cf/stubs/sharp.ts')).toBe(false);
  });

  it('the gate is not blind: it sees an import in each form', () => {
    expect(IMPORT.test("import sharp from 'sharp';")).toBe(true);
    expect(IMPORT.test('const s = await import("sharp");')).toBe(true);
    expect(IMPORT.test("const s = require('sharp');")).toBe(true);
    expect(IMPORT.test("import { x } from 'sharpen';")).toBe(false);
  });
});
