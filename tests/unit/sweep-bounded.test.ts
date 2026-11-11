/** SWEEP-BOUND-1 (audit M-149): cross-store sweeps are bounded and checkpoint per item. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const api = (p: string) => readFileSync(join(__dirname, '../../apps/api/src', p), 'utf8');

describe('SWEEP-BOUND-1', () => {
  it('sweepAcrossStores requires take and cuts the merged rows to it', () => {
    const src = api('lib/cross-store.ts');
    expect(src).toMatch(/orderKey: \(row: T\) => Date \| number;\n\s+take: number;/);
    expect(src).toMatch(/\.slice\(0, args\.take\)/);
  });
  it('every caller passes take', () => {
    for (const f of ['lib/jobs/store-db.ts', 'services/shipping-carrier.service.ts']) {
      const src = api(f);
      const i = src.indexOf('sweepAcrossStores({');
      expect(i, f).toBeGreaterThan(-1);
      expect(src.slice(i, i + 1500), f).toMatch(/\btake\b/);
    }
  });
  it('the tracking cron caps a run and stamps lastPolledAt per polled shipment', () => {
    const src = api('services/shipping-carrier.service.ts');
    expect(src).toMatch(/RUN_CAP = 200/);
    expect(src).toMatch(/orderBy: \{ lastPolledAt: \{ sort: 'asc', nulls: 'first' \} \}/);
    expect(src).toMatch(/lastPolledAt: new Date\(\)/);
  });
});
