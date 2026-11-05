/**
 * Every shipment STATUS write path either feeds CI or says why it does not (CI 1.2, the cache-invalidation
 * rule applied to capture: a write path with no emit is a hole in the data we cannot recover).
 *
 * A write that sets a status (`status:` or the booking `...fields`) must carry, in the 6 lines above it,
 * `// ci: emits <event>` (and that event must be sent from the same file) or `// ci: not-an-outcome (<why>)`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../apps/api/src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === 'ci' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : [];
  });
}
const CALL = /(?:\b(?:prisma|tx|w)|\))\.shipment\.(create|update|updateMany|upsert)\(/g;
const WRITES_STATUS = /\bstatus\s*:|\.\.\.fields\b/;

const found: Array<{ file: string; line: number; tag: string | null; file$: string }> = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const m of text.matchAll(CALL)) {
    const at = text.slice(0, m.index).split('\n').length - 1;
    const call = lines.slice(at, at + 12).join('\n');
    if (!WRITES_STATUS.test(call)) continue;
    const above = lines.slice(Math.max(0, at - 6), at).join('\n');
    const tag = /\/\/ ci: (emits \S+|not-an-outcome \(.+\))/.exec(above)?.[1] ?? null;
    found.push({ file: file.replace(SRC, ''), line: at + 1, tag, file$: text });
  }
}

describe('shipment status write paths', () => {
  it('finds the write paths (the scan itself is alive)', () => {
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it('every one emits to CI or carries a waiver with a reason', () => {
    const naked = found.filter(f => !f.tag).map(f => `${f.file}:${f.line}`);
    expect(naked, `shipment status writes with no "// ci:" tag: ${naked.join(', ')}`).toEqual([]);
  });

  it('every "emits" tag names an event the same file really sends', () => {
    for (const f of found.filter(x => x.tag?.startsWith('emits'))) {
      const event = f.tag!.split(' ')[1]!; // ci/shipment-tracked | ci/shipment-booked
      const constant =
        event === 'ci/shipment-tracked' ? 'CI_SHIPMENT_TRACKED_EVENT' : 'CI_SHIPMENT_BOOKED_EVENT';
      expect(f.file$, `${f.file}:${f.line} says it emits ${event}`).toMatch(
        new RegExp(`name:\\s*${constant}`)
      );
    }
  });
});
