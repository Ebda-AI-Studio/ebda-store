/**
 * Any migration that sorts AFTER the strict-RLS migration and creates a table with a
 * store_id column must create its strict policy in the same file (the strict sweep only
 * covers tables that already exist when it runs). The migration-order guard for R-EBDA-002.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../packages/database/prisma/migrations');
const STRICT = '20261004000000_ebda_strict_rls';

describe('migrations after the strict-RLS sweep', () => {
  const later = fs
    .readdirSync(DIR)
    .filter(d => /^\d{14}_/.test(d) && d > STRICT)
    .sort();

  it('every store_id table they create also gets an ebda_tenant_isolation policy', () => {
    const offenders: string[] = [];
    for (const d of later) {
      const sql = fs
        .readFileSync(path.join(DIR, d, 'migration.sql'), 'utf8')
        .split('\n')
        .filter(l => !l.trim().startsWith('--'))
        .join('\n');
      const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql))) {
        const [, table, body] = m;
        if (!/["\s]store_id["\s]/i.test(body)) continue;
        const policy = new RegExp(
          `CREATE POLICY\\s+ebda_tenant_isolation\\s+ON\\s+"?${table}"?`,
          'i'
        );
        if (!policy.test(sql)) offenders.push(`${d}: ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the strict migration is last-but-for-later-ones: it sorts after the plans and billing migrations', () => {
    for (const earlier of [
      '20261003130000_plans_and_store_subscriptions',
      '20261003150000_billing_events_and_dunning',
    ]) {
      expect(STRICT > earlier).toBe(true);
    }
  });
});
