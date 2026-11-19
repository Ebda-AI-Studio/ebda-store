/**
 * Search page density (UI audit P2 #12) without giving back the CLS fix (#584): the loading skeleton and the settled page reserve
 * the SAME height at every width, 50svh on phones (a two-result grid no longer floats over 300px of blank) and 70svh from sm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) =>
  readFileSync(join(__dirname, '../../apps/web/src/app/search', f), 'utf8');
const reserved = (src: string) => [...src.matchAll(/min-h-\[(\d+svh)\]/g)].map(m => m[0]);

describe('search page reserved height', () => {
  it('skeleton and settled page reserve the same min-height classes', () => {
    const settled = reserved(read('SearchClient.tsx'));
    const loading = reserved(read('loading.tsx'));
    expect(settled.sort()).toEqual(['min-h-[50svh]', 'min-h-[70svh]'].sort());
    expect(loading.sort()).toEqual(settled);
  });
  it('the phone reservation is the lower one', () => {
    expect(read('SearchClient.tsx')).toMatch(/min-h-\[50svh\][^"]*sm:min-h-\[70svh\]/);
    expect(read('loading.tsx')).toMatch(/min-h-\[50svh\][^"]*sm:min-h-\[70svh\]/);
  });
});
