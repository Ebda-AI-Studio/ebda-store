/**
 * M-154 (Ruling P18-5): no tracked compiled twin of a TypeScript source file inside a `src` tree.
 * `packages/database/src/index.js` was a leftover build of index.ts that did `new PrismaClient()` with no adapter
 * and no tenant guard; Vite tries `.js` before `.ts`, so one stray relative import would have bypassed R-EBDA-003.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
    .split('\0')
    .filter(Boolean);
}

describe('compiled twins in src', () => {
  it('no tracked .js/.js.map/.d.ts/.mjs sits next to a .ts/.tsx of the same name under a src directory', () => {
    const files = new Set(tracked());
    const offenders: string[] = [];
    for (const f of files) {
      if (!/(^|\/)src\//.test(f)) continue;
      const m = /^(.*)\.(js|mjs|cjs|jsx)(\.map)?$|^(.*)\.d\.ts$/.exec(f);
      if (!m) continue;
      const stem = m[1] ?? m[4];
      if (files.has(`${stem}.ts`) || files.has(`${stem}.tsx`)) {
        // a hand-written .d.ts that declares a module for a non-TS file has no .ts twin, so it never lands here
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
