// Ruling SEARCH-T13-8 (expand-then-contract): migration 20261024000100 KEPT the 5-argument
// `ebda_product_embed_doc` (with the AI words) for the previous Worker; the contract migration
// 20261029000100 dropped it. A caller passing the words would now fail at runtime ("function does
// not exist"); this source guard catches it earlier: every call in apps/api/src passes exactly the
// 4 arguments (names + descriptions).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'apps/api/src');

function listTs(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) listTs(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Top-level comma count of the argument list that starts right after `(` at `start`. */
function argCount(src: string, start: number): number {
  let depth = 0;
  let n = 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return n;
      depth--;
    } else if (c === ',' && depth === 0) n++;
  }
  throw new Error('unclosed call');
}

describe('ebda_product_embed_doc callers (SEARCH-T13-8)', () => {
  it('every call in apps/api/src uses the 4-argument form (no AI words in the doc vector)', () => {
    const calls: string[] = [];
    for (const f of listTs(SRC)) {
      const src = readFileSync(f, 'utf8');
      const re = /ebda_product_embed_doc\(/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const at = m.index + m[0].length;
        if (src.startsWith('...)', at)) continue; // a prose mention in a comment
        calls.push(`${relative(ROOT, f)}:${argCount(src, at)}`);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(c => !c.endsWith(':4'))).toEqual([]);
  });
});
