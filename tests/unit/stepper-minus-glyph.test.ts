/**
 * VT-c (independent audit): one quantity stepper drew its minus as an ASCII hyphen "-"
 * while the others used "−" (U+2212). Every decrease control renders U+2212 or an icon.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '../../apps/web/src');
function walk(d: string): string[] {
  return readdirSync(d).flatMap(f => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

describe('decrease controls use the minus sign', () => {
  it('no ASCII hyphen as the visible glyph of a decrease button', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(
        /aria-label=\{(?:t\('Decrease[^']*'|cartLineLabel\('decrease')/g
      )) {
        seen++;
        const end = src.indexOf('</button>', m.index!);
        const body = src.slice(src.indexOf('>', m.index!) + 1, end);
        const text = body.replace(/<[^>]*>/g, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
        if (/(^|[\s>{'"])-(?=[\s<}'"]|$)/.test(text)) bad.push(relative(SRC, f));
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });
});
