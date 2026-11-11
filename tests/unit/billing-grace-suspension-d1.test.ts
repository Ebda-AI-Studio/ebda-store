/**
 * Ruling BILL-NOTICE-1 (S2-13), SERVICE level on the real platform D1 schema: an InstaPay store that goes overdue, is
 * told one day before the pause, and then passes its grace period is SUSPENDED by the billing cycle, and every notice
 * stage leaves its `billing_reminders` row. Drives the real `runBillingCycle` / `sendGraceEndingNotice` / `claimGraceStage`
 * over the routed `prisma` proxy on node:sqlite wrapped as D1 (the same rig as platform-billing-d1.test.ts).
 *
 * Without platform migration 0013 production's `billing_reminders_kind_check` rejects `grace_start`/`grace_d1`: the claim
 * throws, the cycle reports an error and no stage is recorded or sent. The second test runs it on the pre-0013 schema.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ suspend: null as null | ((id: string) => Promise<boolean>) }));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/billing/billing-notify', () => ({
  runBillingEffects: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/lib/definer', () => ({
  getEntityStoreId: async () => '11111111-1111-4111-8111-111111111111',
  getBillingRefundStoreId: async () => null,
}));
vi.mock('../../apps/api/src/middleware/security', () => ({
  auditLog: vi.fn(async () => undefined),
}));
// The store row's own suspension (Postgres/DO side, bust caches, owner cascade) is account.service's job and is covered
// there; here it is replaced by the one statement that matters: flip the store row on the same D1 the cycle just wrote.
vi.mock('../../apps/api/src/services/billing/account.service', () => ({
  isBillableStoreId: async () => true,
  assertPayableStore: vi.fn(),
  suspendForBilling: (id: string) => h.suspend!(id),
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  // a real transaction, as on D1: a failed claim must roll the past_due decision back with it
  return {
    ...real,
    withStore: (_id: string, fn: (tx: unknown) => Promise<unknown>) =>
      (real.prisma as any).$transaction((tx: unknown) => fn(tx)),
  };
});

import { setModelRouter } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { cutoverKey, resetCutoverCache } from '../../apps/api/src/services/platform/cutover';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { runBillingCycle } from '../../apps/api/src/services/billing/subscription-billing.service';
import { sendGraceEndingNotice } from '../../apps/api/src/services/billing/reminders.service';

const DIR = new URL('../../packages/cf-schema/migrations/platform/', import.meta.url);
const files = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();
const M10 = files.find(f => f.startsWith('0013_billing_reminders_grace_kinds'))!;
const OLD_CHECK = `CHECK ("kind" IN ('d7', 'd3', 'd1', 'd0', 'suspended'))`;
const NEW_CHECK_RE = /CHECK \("kind" IN \('d7', 'd3', 'd1', 'd0', 'suspended'[^)]*\)\)/;

const STORE = '11111111-1111-4111-8111-111111111111';
const SUB = 'sub-1';
const DAY = 86_400_000;
const PERIOD_END = new Date('2026-11-01T00:00:00Z');

/** Production's D1 as deployed: every migration before 0013 with the OLD kind CHECK, then 0013 only if `migrated`. */
function rig(migrated: boolean) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of files) {
    if (f === M10 && !migrated) continue;
    let sql = fs.readFileSync(new URL(f, DIR), 'utf8');
    if (f.startsWith('0001_init') && !migrated) sql = sql.replace(NEW_CHECK_RE, OLD_CHECK);
    db.exec(sql);
  }
  db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c1', ?, '{}')`).run(
    cutoverKey('billing')
  );
  db.prepare(
    `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES ('plan-growth','growth','g','g','professional','{}')`
  ).run();
  db.prepare(
    `INSERT INTO stores (id, name, slug, owner_id, status) VALUES (?, 's', 's', 'o', 'active')`
  ).run(STORE);
  db.prepare(
    `INSERT INTO store_subscriptions (id, store_id, plan_code, status, billing_method, current_period_end) VALUES (?, ?, 'growth', 'active', 'instapay', ?)`
  ).run(SUB, STORE, PERIOD_END.getTime());
  const exec = (sql: string, v: unknown[]) =>
    /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
      ? { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) } };
  const bound = (sql: string, v: unknown[]) => ({
    all: async () => (await Promise.resolve(), exec(sql, v)),
    run: async () => (await Promise.resolve(), exec(sql, v)),
    first: async () => (await Promise.resolve(), (exec(sql, v).results[0] ?? null) as never),
  });
  const d1 = {
    prepare: (sql: string) => ({ ...bound(sql, []), bind: (...v: unknown[]) => bound(sql, v) }),
  };
  h.suspend = async id =>
    Number(
      db
        .prepare(
          `UPDATE stores SET status='suspended', billing_suspended_reason='unpaid', billing_suspended_at=? WHERE id=? AND status='active'`
        )
        .run(Date.now(), id).changes
    ) === 1;
  setCfBindings({ PLATFORM_DB: d1 } as never);
  return db;
}

const kinds = (db: DatabaseSync) =>
  (
    db
      .prepare(`SELECT kind FROM billing_reminders WHERE subscription_id = ? ORDER BY kind`)
      .all(SUB) as { kind: string }[]
  ).map(r => r.kind);
const storeStatus = (db: DatabaseSync) =>
  db
    .prepare(`SELECT status, billing_suspended_reason AS reason FROM stores WHERE id = ?`)
    .get(STORE) as { status: string; reason: string | null };
const subRow = (db: DatabaseSync) =>
  db
    .prepare(`SELECT status, next_retry_at AS retry FROM store_subscriptions WHERE id = ?`)
    .get(SUB) as { status: string; retry: number | null };

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  setModelRouter(null as never);
  registerPlatformRouter();
});

describe('InstaPay grace -> suspension through the billing cycle (BILL-NOTICE-1)', () => {
  it('with 0013: overdue -> grace_start; one day left -> grace_d1; grace over -> store suspended + suspended stage', async () => {
    const db = rig(true);
    const day1 = new Date(PERIOD_END.getTime() + 1000);

    expect((await runBillingCycle(day1, undefined, { subscriptionIds: [SUB] })).errors).toBe(0);
    expect(subRow(db).status).toBe('past_due');
    expect(kinds(db)).toEqual(['grace_start']);
    const suspendAt = subRow(db).retry!;
    expect(suspendAt).toBeGreaterThan(day1.getTime());

    const dayBefore = new Date(suspendAt - DAY / 2);
    expect(await sendGraceEndingNotice(SUB, dayBefore)).toMatchObject({ sent: true });
    expect(await sendGraceEndingNotice(SUB, dayBefore)).toMatchObject({ sent: false }); // once
    expect(kinds(db)).toEqual(['grace_d1', 'grace_start']);
    expect(storeStatus(db).status).toBe('active');

    const after = new Date(suspendAt + 60_000);
    const summary = await runBillingCycle(after, undefined, { subscriptionIds: [SUB] });
    expect(summary).toMatchObject({ errors: 0, suspended: 1 });
    expect(storeStatus(db)).toEqual({ status: 'suspended', reason: 'unpaid' });
    expect(kinds(db)).toEqual(['grace_d1', 'grace_start', 'suspended']);

    // a re-run changes nothing
    expect((await runBillingCycle(after, undefined, { subscriptionIds: [SUB] })).suspended).toBe(0);
    expect(kinds(db)).toHaveLength(3);
  });

  it('WITHOUT 0013 (production today) every grace notice claim violates the CHECK: errors, no stage rows, no notice', async () => {
    const db = rig(false);
    const day1 = new Date(PERIOD_END.getTime() + 1000);
    const first = await runBillingCycle(day1, undefined, { subscriptionIds: [SUB] });
    expect(first.errors).toBe(1); // grace_start claim -> CHECK constraint failed
    expect(kinds(db)).toEqual([]);
    // D1 has no interactive transaction (prisma-lite d1.ts), so the past_due write itself survives the failed claim.
    const suspendAt = subRow(db).retry!;
    await expect(sendGraceEndingNotice(SUB, new Date(suspendAt - DAY / 2))).rejects.toThrow(
      /billing_reminders_kind_check|constraint/i
    );
    expect(kinds(db)).toEqual([]);
  });
});
