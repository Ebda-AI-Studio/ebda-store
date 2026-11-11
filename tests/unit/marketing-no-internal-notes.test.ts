// Ahmad 2026-11-11: nothing internal or unfinished reaches a public ebda.app surface. llms.txt carried
// "(wording pending a match to the company registration papers)" - an internal note, live to every answer
// engine. Guard: the public machine files and every marketing copy STRING (comments stripped) carry no
// internal-note, TODO or company-registration wording, and Ebda AI Studio / Ebda Store / Ebda Chat are never
// described as launching, pre-launch, pending or in progress (they exist; "coming soon" is for upcoming products).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MKT = 'apps/marketing';
const INTERNAL =
  /wording (is )?pending|pending a match|registration papers|company registration|internal note|\bTODO\b|\bTBD\b|\bFIXME\b|تسجيل الشركة|أوراق الشركة|السجل التجاري/i;
const NOT_PRESENT = /\b(pre-launch|launching|pending|in progress|under review)\b/i;
const EXISTING = /Ebda AI Studio|Ebda Store|Ebda Chat|ابدأ ستوديو|ابدأ ستور|ابدأ شات/;

const publicFiles = readdirSync(path.join(MKT, 'public'))
  .filter(f => /\.(txt|md|json|xml|webmanifest)$/.test(f))
  .map(f => path.join(MKT, 'public', f));
// Copy modules: string literals only (block + line comments removed), so a code comment may still explain.
const copyFiles = readdirSync(path.join(MKT, 'src/lib'))
  .filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
  .map(f => path.join(MKT, 'src/lib', f));
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('no internal or unfinished notes on public ebda.app surfaces', () => {
  it('public machine files and marketing copy carry no internal-note / TODO / registration wording', () => {
    const hits: string[] = [];
    for (const f of [...publicFiles, ...copyFiles]) {
      const text = f.includes('/public/')
        ? readFileSync(f, 'utf8')
        : stripComments(readFileSync(f, 'utf8'));
      text.split('\n').forEach((line, i) => {
        if (INTERNAL.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('Ebda AI Studio, Ebda Store and Ebda Chat are never described as launching, pending or in progress', () => {
    const hits: string[] = [];
    for (const f of publicFiles) {
      for (const sentence of readFileSync(f, 'utf8').split(/[.;!?\n]/)) {
        if (EXISTING.test(sentence) && NOT_PRESENT.test(sentence))
          hits.push(`${f}: ${sentence.trim().slice(0, 120)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the guard bites: the removed note would fail it', () => {
    expect(INTERNAL.test('(wording pending a match to the company registration papers)')).toBe(
      true
    );
  });
});
