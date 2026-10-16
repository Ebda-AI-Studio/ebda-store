/**
 * The API runs on Cloudflare Workers (workerd), where `sharp` (a native addon) cannot load:
 * wrangler aliases it to cf/stubs/sharp.ts, which throws. Every code path that imported it
 * (PWA icons, the upload resizer, Gemini rasterizing) was therefore broken in production while
 * its Node tests stayed green. Nothing under apps/api/src may import it (static, dynamic or
 * require); the stub itself is the only file allowed to mention the module.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'apps/api/src';
const STUB = 'apps/api/src/cf/stubs/sharp.ts';
const IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]sharp['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

describe('no sharp under apps/api', () => {
  it('no source file imports sharp', () => {
    const offenders = walk(ROOT)
      .filter(f => relative('.', f) !== STUB)
      .filter(f => IMPORT.test(readFileSync(f, 'utf8')))
      .map(f => relative('.', f));
    expect(offenders).toEqual([]);
  });

  it('the gate is not blind: it sees an import in each form', () => {
    expect(IMPORT.test("import sharp from 'sharp';")).toBe(true);
    expect(IMPORT.test('const s = await import("sharp");')).toBe(true);
    expect(IMPORT.test("const s = require('sharp');")).toBe(true);
    expect(IMPORT.test("import { x } from 'sharpen';")).toBe(false);
  });
});
