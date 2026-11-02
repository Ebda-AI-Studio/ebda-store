/**
 * Ruling WEB-MW-DUP-2: one middleware implementation. Next loads middleware from apps/web/src/ OR apps/web/, depending
 * on layout; both files exist and run the same code, so an edit can never land in a copy that is not the one running.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as root from '../../apps/web/middleware';
import * as src from '../../apps/web/src/middleware';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('web middleware has a single implementation (WEB-MW-DUP-2)', () => {
  it('src/middleware.ts is the re-export, with no logic of its own', () => {
    const code = read('apps/web/src/middleware.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain("export { middleware } from '../middleware';");
    expect(code).not.toMatch(/\bfunction\b|NextResponse|NextRequest|\bimport\b/);
    expect(src.middleware).toBe(root.middleware);
  });

  it('both files carry the same matcher (the one Next reads must equal the root file)', () => {
    expect(src.config).toEqual(root.config);
    expect(root.config.matcher.length).toBeGreaterThan(0);
  });

  it('no third middleware file exists', () => {
    for (const p of [
      'apps/web/src/proxy.ts',
      'apps/web/proxy.ts',
      'apps/web/src/middleware.js',
      'apps/web/middleware.js',
    ]) {
      expect(() => read(p), p).toThrow();
    }
  });
});
