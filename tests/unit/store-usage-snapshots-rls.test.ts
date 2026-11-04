// tests/unit/store-usage-snapshots-rls.test.ts — #1059
//
// Ruling MCP-1 (docs/RULINGS.md) named store_usage_snapshots as carrying the
// same RLS omission merchant_api_keys was fixed for, and deliberately left it
// for its own dedicated change. This pins that follow-up migration, plus the
// static verification (both current call sites already use withRlsBypass)
// that made it safe to land (updated for the strict-RLS cutover: store scopes, no bypass).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const MIG_DIR = resolve(ROOT, 'packages/database/prisma/migrations');

function migrationSql(nameFragment: string): string {
  const dir = readdirSync(MIG_DIR).find(d => d.includes(nameFragment));
  if (!dir) throw new Error(`migration matching "${nameFragment}" not found`);
  return readFileSync(resolve(MIG_DIR, dir, 'migration.sql'), 'utf8');
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
}

describe('store_usage_snapshots RLS follow-up (#1059)', () => {
  const sql = migrationSql('store_usage_snapshots_rls');
  const ddl = stripComments(sql);

  it('enables and FORCES row level security', () => {
    expect(ddl).toMatch(/ALTER TABLE "store_usage_snapshots" ENABLE ROW LEVEL SECURITY/i);
    expect(ddl).toMatch(/ALTER TABLE "store_usage_snapshots" FORCE ROW LEVEL SECURITY/i);
  });

  it('has all 4 policies (select/insert/update/delete), matching the merchant_api_keys shape', () => {
    for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const re = new RegExp(
        `CREATE POLICY "store_usage_snapshots_app_${action.toLowerCase()}"[\\s\\S]*?FOR ${action}`,
        'i'
      );
      expect(ddl, `missing ${action} policy`).toMatch(re);
    }
  });

  it('every policy checks store_id against current_store_id() with a bypass escape hatch', () => {
    const storeIdChecks = (ddl.match(/store_id = current_store_id\(\)/g) ?? []).length;
    const bypassChecks = (ddl.match(/app\.bypass_rls/g) ?? []).length;
    expect(storeIdChecks).toBeGreaterThanOrEqual(4);
    expect(bypassChecks).toBeGreaterThanOrEqual(4);
  });

  it('drops nothing and writes no data — policy only', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\s+/im);
  });

  it('both call sites read and write the table inside a store scope (strict RLS, no bypass)', () => {
    // The old migration's safety argument was "nothing touches this table without bypassing
    // RLS". Under the strict model (20261004000000_ebda_strict_rls) the table's policy is
    // `store_id = current_store_id`, so every site must run in ONE store's scope.
    const cron = readFileSync(
      resolve(ROOT, 'apps/api/src/lib/inngest/functions/store-usage-snapshot.ts'),
      'utf8'
    );
    const upsertIdx = cron.indexOf('storeUsageSnapshot.upsert');
    expect(upsertIdx, 'storeUsageSnapshot.upsert call moved — re-point this test').toBeGreaterThan(
      -1
    );
    const scopeBeforeUpsert = cron.lastIndexOf('withStore(', upsertIdx);
    expect(scopeBeforeUpsert, 'the cron upsert is no longer inside withStore').toBeGreaterThan(-1);
    expect(upsertIdx - scopeBeforeUpsert, 'cron upsert moved outside withStore').toBeLessThan(2000);
    expect(cron).not.toMatch(/import[^;]*withRlsBypass/);

    const admin = readFileSync(resolve(ROOT, 'apps/api/src/routes/admin.routes.ts'), 'utf8');
    // The usage-history reads live in `loadUsageHistoryRows(tx, months)` (issue 2329), which
    // takes the client it must read on. The ONLY caller runs it once per store through
    // `acrossStores`, and the helper reads the table through that client, never the bare `prisma`.
    expect(admin, 'the usage-history route no longer reads store by store').toContain(
      'acrossStores(\n    storeId => loadUsageHistoryRows('
    );
    expect(admin.split('loadUsageHistoryRows(').length - 1, 'a second caller appeared').toBe(2);
    const helper = admin.slice(
      admin.indexOf('export async function loadUsageHistoryRows('),
      admin.indexOf('\n}\n', admin.indexOf('export async function loadUsageHistoryRows('))
    );
    expect(helper).toContain('tx.storeUsageSnapshot.groupBy');
    expect(helper).toContain('tx.storeUsageSnapshot.findMany');
    expect(admin).not.toMatch(/\bprisma\.storeUsageSnapshot\./);
    expect(admin).not.toMatch(/import[^;]*withRlsBypass/);
  });
});
