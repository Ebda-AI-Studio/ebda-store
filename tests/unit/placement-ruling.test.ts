import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

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

  it('if wrangler enables placement, the ruling must carry an "on" arm with numbers', () => {
    if (!/"placement"\s*:/.test(wrangler)) return; // off: nothing to prove
    expect(ruling).not.toMatch(/\| on \|[^|]*\| NOT MEASURED/);
    expect(ruling).toMatch(/\| on \|[^|]*\| \d+ ms/);
  });
});
