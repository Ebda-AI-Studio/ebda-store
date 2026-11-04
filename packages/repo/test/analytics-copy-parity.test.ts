// Ruling NZ-AN-1: the controller's copy script and the DO's verifier must agree on tables and checked columns, and every
// copied column must exist in the generated StoreDO schema.
import { describe, expect, it } from 'vitest';
import { ANALYTICS_TABLES } from '../src/do/analytics-ops';
import { TABLES, SUMS } from '../../../scripts/cf/copy-analytics-to-do.mjs';
import { openSqlite } from './diff-harness';

describe('copy-analytics-to-do.mjs and analytics-ops.ts', () => {
  it('copy the same tables and verify the same SUM columns', () => {
    expect([...TABLES].sort()).toEqual(Object.keys(ANALYTICS_TABLES).sort());
    for (const t of TABLES) expect(SUMS[t], t).toEqual(ANALYTICS_TABLES[t].sums);
  });

  it('every copied column is a column of the real StoreDO table, and no column is left out', () => {
    const raw = openSqlite();
    for (const [t, spec] of Object.entries(ANALYTICS_TABLES)) {
      const cols = (raw.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(
        c => c.name
      );
      expect([...spec.columns].sort(), t).toEqual([...cols].sort());
    }
  });
});
