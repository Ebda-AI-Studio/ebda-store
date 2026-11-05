import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Ruling WA-COPY-1 / WA-RENAME-PLAN-1 (Ahmad 2026-11-01): the product is "Ebda Chat" / "ابدأ شات". WhatsApp appears only in
 * describing sentences ("... on WhatsApp"), never in the product name. These spellings are banned everywhere a visitor,
 * merchant or search engine can read the site, help, docs and shared brand copy.
 */
const ROOT = path.resolve(__dirname, '../..');
const DIRS = [
  'apps/marketing/src',
  'apps/marketing/public',
  'apps/marketing/legal-source',
  'apps/help/content',
  'apps/help/wa-source',
  'apps/docs/content',
  'apps/docs/wa-source',
  'packages/shared/src',
];
const BANNED = [
  'Ebda WhatsApp',
  'ابدأ واتساب',
  'Ebda for WhatsApp',
  'WhatsApp by Ebda',
  'شريك واتساب الرسمي',
  /\bEbda WA\b/,
] as const;
const TEXT = /\.(tsx?|mdx?|txt|json|html|xml|svg|mjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next') continue;
    const f = path.join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (TEXT.test(n)) out.push(f);
  }
  return out;
}

const hit = (text: string, b: (typeof BANNED)[number]) =>
  typeof b === 'string' ? text.includes(b) : b.test(text);

describe('the product is Ebda Chat, never Ebda WhatsApp (WA-COPY-1)', () => {
  const files = DIRS.flatMap(d => walk(path.join(ROOT, d)));

  it('actually scans the copy surfaces (not an empty-set pass)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no banned product spelling appears in any scanned file', () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const b of BANNED)
        if (hit(text, b)) hits.push(`${path.relative(ROOT, f)}: ${String(b)}`);
    }
    expect(hits).toEqual([]);
  });

  it('the matcher catches each banned spelling', () => {
    const sample =
      'Ebda WhatsApp ابدأ واتساب Ebda for WhatsApp WhatsApp by Ebda Ebda WA شريك واتساب الرسمي';
    for (const b of BANNED) expect(hit(sample, b)).toBe(true);
    expect(/\bEbda WA\b/.test('Ebda WB, Ebda WAVE')).toBe(false);
  });
});
