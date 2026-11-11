import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Every "on" row of the ruling's table (whitespace-tolerant: prettier pads every cell). Measured only when ALL of them carry numbers
 * in both columns and together they cover the hit and the miss path; one NOT MEASURED cell anywhere makes it unmeasured.
 */
export function onArm(md: string): 'missing' | 'unmeasured' | 'measured' {
  const rows = md
    .split('\n')
    .filter(l => /^\|\s*on\s*\|/.test(l))
    .map(l =>
      l
        .split('|')
        .slice(1, -1)
        .map(c => c.trim())
    );
  if (rows.length === 0) return 'missing';
  const numeric = (c: string) => /^\d+(\.\d+)?\s*ms$/.test(c);
  if (!rows.every(r => r.length >= 4 && numeric(r[2]!) && numeric(r[3]!))) return 'unmeasured';
  const paths = rows.map(r => r[1]!.toLowerCase()).join(' ');
  return /hit/.test(paths) && /miss/.test(paths) ? 'measured' : 'unmeasured';
}

const prettified = async (md: string) =>
  format(md, { ...(await resolveConfig(join(root, 'docs/rulings/x.md'))), parser: 'markdown' });

// Ruling PERF-PLACEMENT-1: Smart Placement changes where every API call runs and was once measured slower.
// It may only be switched on together with measured numbers for BOTH arms in the ruling.
describe('Smart Placement is only on with a measured ruling (PERF-PLACEMENT-1)', () => {
  const wrangler = read('apps/api/wrangler.jsonc')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  const ruling = read('docs/rulings/PERF-PLACEMENT-1.md');

  it('the A/B harness exists and tags both arms and the placement header', () => {
    const k6 = read('loadtests/scenarios/placement-ab.js');
    expect(k6).toContain('ARM');
    expect(k6).toContain('Cf-Placement');
    expect(k6).toContain('ab_miss_ms');
  });

  it('if wrangler enables placement, the ruling must carry a measured "on" arm', () => {
    if (!/"placement"\s*:/.test(wrangler)) return; // off: nothing to prove
    expect(onArm(ruling)).toBe('measured');
  });

  it('the committed ruling reads as unmeasured both raw and after prettier pads the table', async () => {
    expect(onArm(ruling)).toBe('unmeasured');
    expect(onArm(await prettified(ruling))).toBe('unmeasured');
  });

  const ON_ROW = /\| on\s*\|[^\n]*\n/;
  it('a real "on" flip (one row, or one row per path) is recognised after prettier re-pads the cells', async () => {
    const one = ruling.replace(ON_ROW, '| on | hit / miss | 140 ms | 210 ms |\n');
    expect(one).not.toBe(ruling);
    expect(onArm(await prettified(one))).toBe('measured');
    const two = ruling.replace(
      ON_ROW,
      '| on | hit | 120 ms | 190 ms |\n| on | miss | 160 ms | 240 ms |\n'
    );
    expect(onArm(await prettified(two))).toBe('measured');
  });

  it('a half-measured flip is NOT measured, after prettier', async () => {
    const cases = [
      '| on | hit / miss | 140 ms | NOT MEASURED |\n',
      '| on | hit | 120 ms | 190 ms |\n| on | miss | NOT MEASURED | NOT MEASURED |\n',
      '| on | hit | NOT MEASURED | NOT MEASURED |\n| on | miss | 160 ms | 240 ms |\n',
      '| on | hit | 120 ms | 190 ms |\n', // miss path never measured
    ];
    for (const row of cases)
      expect(onArm(await prettified(ruling.replace(ON_ROW, row)))).toBe('unmeasured');
  });

  it('a ruling with no "on" row at all is missing', () => {
    expect(onArm(ruling.replace(ON_ROW, ''))).toBe('missing');
  });
});
