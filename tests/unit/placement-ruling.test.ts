import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** The "on" row of the ruling's table: whitespace-tolerant, because prettier pads every table cell to the column width. */
export function onArm(md: string): 'missing' | 'unmeasured' | 'measured' {
  const row = md.split('\n').find(l => /^\|\s*on\s*\|/.test(l));
  if (!row) return 'missing';
  const cells = row
    .split('|')
    .slice(1, -1)
    .map(c => c.trim());
  if (cells.slice(2).some(c => /NOT MEASURED/i.test(c))) return 'unmeasured';
  return cells.slice(2).length >= 2 && cells.slice(2).every(c => /^\d+(\.\d+)?\s*ms$/.test(c))
    ? 'measured'
    : 'unmeasured';
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

  it('a real "on" flip is recognised after prettier re-pads the cells (and a half flip is not)', async () => {
    const flipped = ruling.replace(/\| on\s*\|[^\n]*\n/, '| on | hit / miss | 140 ms | 210 ms |\n');
    expect(flipped).not.toBe(ruling);
    expect(onArm(await prettified(flipped))).toBe('measured');
    const half = ruling.replace(
      /\| on\s*\|[^\n]*\n/,
      '| on | hit / miss | 140 ms | NOT MEASURED |\n'
    );
    expect(onArm(await prettified(half))).toBe('unmeasured');
    const gone = ruling.replace(/\| on\s*\|[^\n]*\n/, '');
    expect(onArm(gone)).toBe('missing');
  });
});
