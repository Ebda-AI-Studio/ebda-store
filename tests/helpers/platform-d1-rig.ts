/**
 * The PLATFORM D1 for node tests: the real cf-schema platform migrations on node:sqlite wrapped as an async D1, the
 * cutover markers set (billing / access / platform), bound as PLATFORM_DB and the platform router registered, so `prisma.*`
 * for platform models takes the production D1 branch. Same rig as tests/unit/subscription-billing-d1.test.ts, shared.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';

const DIR = new URL('../../packages/cf-schema/migrations/platform/', import.meta.url);
const MIG = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => fs.readFileSync(new URL(f, DIR), 'utf8'))
  .join('\n');

export function installPlatformD1(
  families: Array<'billing' | 'access' | 'platform' | 'payments'> = [
    'billing',
    'access',
    'platform',
  ]
): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(MIG);
  const stmt = (sql: string, v: unknown[]) => {
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql))
      return { results: raw.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(raw.prepare(sql).run(...(v as never[])).changes) },
    };
  };
  const prep = (sql: string) => ({
    bind: (...v: unknown[]) => ({
      all: async () => (await Promise.resolve(), stmt(sql, v)),
      run: async () => (await Promise.resolve(), stmt(sql, v)),
      first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      __run: () => stmt(sql, v),
    }),
  });
  const d1 = {
    prepare: prep,
    // atomic: roll everything back if a statement throws (D1 batch semantics)
    batch: async (list: Array<{ __run: () => { meta: { changes: number } } }>) => {
      raw.exec('BEGIN');
      try {
        const out = list.map(x => x.__run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  for (const family of families)
    raw
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES (?, ?, '{}')`)
      .run(`m-${family}`, cutoverKey(family as never));
  setCfBindings({ PLATFORM_DB: d1 } as never);
  resetCutoverCache();
  registerPlatformRouter();
  return raw;
}

/** The locked plan catalog (real prices) and the 20 founding slots filled with inert rows, so period ends do not depend on that counter. */
export function seedBillingCatalog(raw: DatabaseSync): void {
  for (const [i, p] of DEFAULT_PLAN_SEEDS.entries())
    raw
      .prepare(
        `INSERT INTO plans (id, code, name_en, name_ar, sort, is_public, price_monthly_minor, price_yearly_minor, feature_tier, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `plan-${p.code}`,
        p.code,
        p.nameEn,
        p.nameAr,
        i,
        p.isPublic ? 1 : 0,
        p.priceMonthlyMinor,
        p.priceYearlyMinor,
        p.featureTier,
        JSON.stringify(p.limits)
      );
  for (let g = 1; g <= 20; g++)
    raw
      .prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, months, status, idempotency_key) VALUES (?, 'founding', ?, 1, 'applied', ?)`
      )
      .run(`filler-${g}`, `test-filler-${g}`, `founding:test-filler-${g}`);
}

export const uninstallPlatformD1 = (): void => clearCfBindings();
