// tests/unit/store-usage-snapshots-rls.test.ts — #1059
//
// Ruling MCP-1 (docs/RULINGS.md) named store_usage_snapshots as carrying the
// same RLS omission merchant_api_keys was fixed for, and deliberately left it
// for its own dedicated change. This pins that follow-up migration, plus the
// static verification (both current call sites already use withRlsBypass)
// that made it safe to land.
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

  it('both current call sites this migration relies on being safe still use withRlsBypass', () => {
    // The migration's own safety argument is "nothing reads/writes this table
    // without already bypassing RLS". If either site stops doing that, this
    // test must catch it BEFORE the migration is assumed still harmless.
    const cron = readFileSync(
      resolve(ROOT, 'apps/api/src/lib/inngest/functions/store-usage-snapshot.ts'),
      'utf8'
    );
    const upsertIdx = cron.indexOf('storeUsageSnapshot.upsert');
    const nearestWithRlsBypassBeforeUpsert = cron.lastIndexOf('withRlsBypass', upsertIdx);
    expect(upsertIdx, 'storeUsageSnapshot.upsert call moved — re-point this test').toBeGreaterThan(
      -1
    );
    expect(
      // The withRlsBypass call wraps a per-store data object built inline
      // before the upsert, so the gap is real — 2000 chars comfortably
      // covers that while still failing if the upsert moved to a
      // differently-scoped, unguarded call far from any withRlsBypass.
      upsertIdx - nearestWithRlsBypassBeforeUpsert,
      'cron upsert moved outside withRlsBypass'
    ).toBeLessThan(2000);

    const admin = readFileSync(resolve(ROOT, 'apps/api/src/routes/admin.routes.ts'), 'utf8');
    // The usage-history reads live in `loadUsageHistoryRows(tx, months)`
    // (issue 2329), which takes the transaction client it must read on. Two
    // things must hold: the ONLY caller hands it a withRlsBypass tx, and the
    // helper reads the table through that `tx`, never the bare `prisma`.
    expect(admin, 'the usage-history route no longer reads inside withRlsBypass').toContain(
      'withRlsBypass(tx => loadUsageHistoryRows(tx, months))'
    );
    expect(admin.split('loadUsageHistoryRows(').length - 1, 'a second caller appeared').toBe(2);
    const helper = admin.slice(
      admin.indexOf('export async function loadUsageHistoryRows('),
      admin.indexOf('\n}\n', admin.indexOf('export async function loadUsageHistoryRows('))
    );
    expect(helper).toContain('tx.storeUsageSnapshot.groupBy');
    expect(helper).toContain('tx.storeUsageSnapshot.findMany');
    expect(admin).not.toMatch(/\bprisma\.storeUsageSnapshot\./);
  });
});
