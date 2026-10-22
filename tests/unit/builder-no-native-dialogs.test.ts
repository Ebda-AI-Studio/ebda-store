/**
 * Task 9: nothing in the visual editor asks with a native `confirm` / `alert` / `prompt`. They are
 * unstyled, untranslated by us, and block the page and the canvas iframe; the editor confirms in the app
 * (`ConfirmDialog`).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../apps/admin/src/app/stores/[id]/builder');

function walk(d: string): string[] {
  return readdirSync(d).flatMap(n => {
    const p = path.join(d, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe('the visual editor never uses a native dialog', () => {
  const files = walk(DIR);
  it('finds the editor sources', () => expect(files.length).toBeGreaterThan(10));
  it.each(files.map(f => [path.relative(DIR, f), f] as const))('%s', (_n, f) => {
    // comments may mention the words; code may not call them
    const code = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
  });
});
