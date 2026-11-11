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

const h = vi.hoisted(() => ({
  suspend: null as null | ((id: string) => Promise<boolean>),
  restore: null as null | ((id: string) => Promise<boolean>),
  restored: [] as string[],
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
const h2 = vi.hoisted(() => ({
  sent: [] as Array<{ kind: string; applied?: boolean }>,
  killOn: null as null | string,
  failAll: false,
}));
vi.mock('../../apps/api/src/services/billing/billing-notify', () => ({
  runBillingEffects: vi.fn(async () => undefined),
  // the notice sender: records what went out; `killOn` simulates the process dying right before that send
  deliverBillingEffect: vi.fn(async (e: { kind: string; applied?: boolean }) => {
    if (h2.killOn === e.kind) throw new Error(`KILLED before sending ${e.kind}`);
    if (h2.failAll) {
      h2.sent.push({ kind: `FAILED:${e.kind}` });
      return false;
    }
    h2.sent.push(e);
    return true;
  }),
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
  restoreFromBilling: (id: string, reason: string) => {
    h.restored.push(`${id}:${reason}`);
    return h.restore!(id);
  },
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
import {
  RESEND_MAX_ATTEMPTS,
  leaseGraceStage,
  resendUnsentGraceNotices,
  sendGraceEndingNotice,
} from '../../apps/api/src/services/billing/reminders.service';

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
  h.restore = async id =>
    Number(
      db
        .prepare(
          `UPDATE stores SET status='active', billing_suspended_reason=NULL, billing_suspended_at=NULL WHERE id=? AND status='suspended'`
        )
        .run(id).changes
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
  h2.sent.length = 0;
  h2.killOn = null;
  h2.failAll = false;
  h.restored.length = 0;
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

describe('a failure mid-suspension is finished by the next cycle (BILL-NOTICE-2: D1 writes are not atomic)', () => {
  const pastDue = async (db: DatabaseSync) => {
    await runBillingCycle(new Date(PERIOD_END.getTime() + 1000), undefined, {
      subscriptionIds: [SUB],
    });
    expect(subRow(db).status).toBe('past_due');
    return new Date(subRow(db).retry! + 60_000);
  };

  it('the suspend call fails once: the row stays due, the next run suspends and claims the stage', async () => {
    const db = rig(true);
    const after = await pastDue(db);
    const real = h.suspend!;
    h.suspend = async () => {
      throw new Error('injected: transient failure before the store flips');
    };
    expect((await runBillingCycle(after, undefined, { subscriptionIds: [SUB] })).errors).toBe(1);
    expect(storeStatus(db).status).toBe('active');
    expect(subRow(db).retry).not.toBeNull(); // still due: this is what lets the next run find it

    h.suspend = real;
    expect(await runBillingCycle(after, undefined, { subscriptionIds: [SUB] })).toMatchObject({
      errors: 0,
      suspended: 1,
    });
    expect(storeStatus(db)).toEqual({ status: 'suspended', reason: 'unpaid' });
    expect(kinds(db)).toContain('suspended');
    expect(subRow(db).retry).toBeNull();
  });

  it('the store flips but the claim write fails: the next run finds it still due, finishes the claim, owns the notice once', async () => {
    const db = rig(true);
    const after = await pastDue(db);
    db.exec(
      `CREATE TRIGGER inject BEFORE INSERT ON billing_reminders WHEN NEW.kind = 'suspended' BEGIN SELECT RAISE(ABORT, 'injected'); END`
    );
    expect((await runBillingCycle(after, undefined, { subscriptionIds: [SUB] })).errors).toBe(1);
    expect(storeStatus(db).status).toBe('suspended'); // step 1 done
    expect(kinds(db)).not.toContain('suspended'); // step 2 not
    expect(subRow(db).retry).not.toBeNull();

    db.exec('DROP TRIGGER inject');
    expect(await runBillingCycle(after, undefined, { subscriptionIds: [SUB] })).toMatchObject({
      errors: 0,
      suspended: 1,
    });
    expect(kinds(db)).toContain('suspended');
    expect(subRow(db).retry).toBeNull();
    expect(h2.sent.filter(e => e.kind === 'store_suspended' && e.applied === true)).toHaveLength(1);
    // and a third run is a no-op
    expect((await runBillingCycle(after, undefined, { subscriptionIds: [SUB] })).suspended).toBe(0);
  });
});

describe('the notice is an outbox: claimed, sent, then stamped (BILL-NOTICE-3)', () => {
  // the claim row's created_at is the real wall clock; these tests run on a simulated one, so pin it to the claim's moment
  const claimedAt = (db: DatabaseSync, at: Date) =>
    db
      .prepare(`UPDATE billing_reminders SET created_at = ? WHERE notice_sent_at IS NULL`)
      .run(at.getTime());
  const sentAt = (db: DatabaseSync, kind: string) =>
    (
      db
        .prepare(
          `SELECT notice_sent_at AS s FROM billing_reminders WHERE subscription_id = ? AND kind = ?`
        )
        .get(SUB, kind) as { s: number | null } | undefined
    )?.s;

  it('a run killed after the claim and before the send is finished by a later run, which sends exactly once', async () => {
    const db = rig(true);
    const day1 = new Date(PERIOD_END.getTime() + 1000);
    h2.killOn = 'grace_started';
    expect((await runBillingCycle(day1, undefined, { subscriptionIds: [SUB] })).errors).toBe(1);
    expect(kinds(db)).toEqual(['grace_start']); // claimed ...
    expect(sentAt(db, 'grace_start')).toBeNull(); // ... not sent
    expect(h2.sent).toHaveLength(0);
    claimedAt(db, day1);

    h2.killOn = null;
    // too soon: the first run may still be in its send
    await runBillingCycle(new Date(day1.getTime() + 60_000));
    expect(h2.sent).toHaveLength(0);
    // later: the full cycle (not the per-subscription one) re-sends
    const later = new Date(day1.getTime() + 6 * 60_000);
    await runBillingCycle(later);
    expect(h2.sent.map(e => e.kind)).toEqual(['grace_started']);
    expect(sentAt(db, 'grace_start')).not.toBeNull();
    // exactly once: every further run sends nothing more
    await runBillingCycle(new Date(later.getTime() + 10 * 60_000));
    await runBillingCycle(new Date(later.getTime() + 20 * 60_000));
    expect(h2.sent.map(e => e.kind)).toEqual(['grace_started']);
  });

  it('killed before the suspended notice: the store is already suspended and the next cycle sends the notice once', async () => {
    const db = rig(true);
    await runBillingCycle(new Date(PERIOD_END.getTime() + 1000), undefined, {
      subscriptionIds: [SUB],
    });
    const after = new Date(subRow(db).retry! + 60_000);
    h2.sent.length = 0;
    h2.killOn = 'store_suspended';
    await runBillingCycle(after, undefined, { subscriptionIds: [SUB] });
    expect(storeStatus(db).status).toBe('suspended');
    expect(sentAt(db, 'suspended')).toBeNull();
    claimedAt(db, after);
    h2.killOn = null;
    await runBillingCycle(new Date(after.getTime() + 6 * 60_000));
    await runBillingCycle(new Date(after.getTime() + 20 * 60_000));
    expect(h2.sent.filter(e => e.kind === 'store_suspended')).toHaveLength(1);
    expect(sentAt(db, 'suspended')).not.toBeNull();
  });

  it('a failed send (effect returns false) is not stamped; a store that paid meanwhile is stamped without a send', async () => {
    const db = rig(true);
    const day1 = new Date(PERIOD_END.getTime() + 1000);
    const { deliverBillingEffect } =
      await import('../../apps/api/src/services/billing/billing-notify');
    vi.mocked(deliverBillingEffect).mockResolvedValueOnce(false);
    await runBillingCycle(day1, undefined, { subscriptionIds: [SUB] });
    expect(sentAt(db, 'grace_start')).toBeNull();
    claimedAt(db, day1);
    db.prepare(`UPDATE store_subscriptions SET status = 'active' WHERE id = ?`).run(SUB);
    await runBillingCycle(new Date(day1.getTime() + 6 * 60_000));
    expect(h2.sent).toHaveLength(0);
    expect(sentAt(db, 'grace_start')).not.toBeNull();
  });
});

describe('the outbox stops, and one worker owns a row (BILL-NOTICE-3)', () => {
  const MIN = 60_000;
  const claimedAt = (db: DatabaseSync, at: Date) =>
    db.prepare(`UPDATE billing_reminders SET created_at = ?`).run(at.getTime());
  const row = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT created_at AS c, notice_attempts AS a, notice_sent_at AS s FROM billing_reminders WHERE subscription_id = ? AND kind = 'grace_start'`
      )
      .get(SUB) as { c: number; a: number; s: number | null };
  /** A grace_start claimed at `at` whose first send was killed, so the row is unsent. */
  const unsent = async (db: DatabaseSync, at: Date) => {
    h2.killOn = 'grace_started';
    await runBillingCycle(at, undefined, { subscriptionIds: [SUB] });
    h2.killOn = null;
    claimedAt(db, at);
    h2.sent.length = 0;
  };

  it('the 2-day cutoff: an unsent stage older than 2 days is never re-sent (a 1-day-old one is)', async () => {
    const db = rig(true);
    const t0 = new Date(PERIOD_END.getTime() + 1000);
    await unsent(db, t0);
    await runBillingCycle(new Date(t0.getTime() + 3 * DAY)); // 3 days later: past the cutoff
    expect(h2.sent.filter(e => e.kind.endsWith('grace_started'))).toEqual([]);
    expect(row(db).s).toBeNull();
    expect(row(db).a).toBe(0); // not even leased

    await runBillingCycle(new Date(t0.getTime() + 1 * DAY)); // control: inside the window it IS re-sent
    expect(h2.sent.map(e => e.kind).filter(k => k === 'grace_started')).toEqual(['grace_started']);
  });

  it('the attempts cap: a notice that keeps failing is tried RESEND_MAX_ATTEMPTS times, then never again; created_at never moves', async () => {
    const db = rig(true);
    const t0 = new Date(PERIOD_END.getTime() + 1000);
    await unsent(db, t0);
    const created = row(db).c;
    h2.failAll = true;
    for (let i = 1; i <= RESEND_MAX_ATTEMPTS + 6; i++)
      await runBillingCycle(new Date(t0.getTime() + i * 10 * MIN)); // each one past the previous lease, all inside 2 days
    expect(h2.sent.filter(e => e.kind === 'FAILED:grace_started')).toHaveLength(
      RESEND_MAX_ATTEMPTS
    );
    expect(row(db)).toMatchObject({ a: RESEND_MAX_ATTEMPTS, s: null });
    expect(row(db).c).toBe(created); // the lease no longer rewrites created_at
  });

  it('a live lease blocks a second attempt until it expires', async () => {
    const db = rig(true);
    const t0 = new Date(PERIOD_END.getTime() + 1000);
    await unsent(db, t0);
    h2.failAll = true;
    await runBillingCycle(new Date(t0.getTime() + 6 * MIN));
    await runBillingCycle(new Date(t0.getTime() + 8 * MIN)); // inside the 5-minute lease
    expect(h2.sent).toHaveLength(1);
    await runBillingCycle(new Date(t0.getTime() + 12 * MIN)); // lease over
    expect(h2.sent).toHaveLength(2);
  });

  it('two workers racing for one row: exactly one gets the lease and exactly one notice goes out', async () => {
    const db = rig(true);
    const t0 = new Date(PERIOD_END.getTime() + 1000);
    await unsent(db, t0);
    const id = (db.prepare(`SELECT id FROM billing_reminders`).get() as { id: string }).id;
    const now = new Date(t0.getTime() + 6 * MIN);
    const wins = await Promise.all(Array.from({ length: 8 }, () => leaseGraceStage(id, 0, now)));
    expect(wins.filter(n => n === 1)).toHaveLength(1);
    expect(row(db).a).toBe(1);

    // and end to end: two whole resend passes at once send once
    const db2 = rig(true);
    await unsent(db2, t0);
    const sent = await Promise.all([resendUnsentGraceNotices(now), resendUnsentGraceNotices(now)]);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h2.sent.map(e => e.kind)).toEqual(['grace_started']);
  });
});

describe('a store that pays mid-suspension is un-suspended (BILL-NOTICE-2)', () => {
  const seedDue = async (db: DatabaseSync) => {
    await runBillingCycle(new Date(PERIOD_END.getTime() + 1000), undefined, {
      subscriptionIds: [SUB],
    });
    return new Date(subRow(db).retry! + 60_000);
  };

  it('payment lands between the suspend and the claim: our suspension is undone', async () => {
    const db = rig(true);
    const after = await seedDue(db);
    const flip = h.suspend!;
    h.suspend = async id => {
      const did = await flip(id);
      // the payment is recorded now: subscription active again, retry cleared
      db.prepare(
        `UPDATE store_subscriptions SET status = 'active', next_retry_at = NULL WHERE id = ?`
      ).run(SUB);
      return did;
    };
    await runBillingCycle(after, undefined, { subscriptionIds: [SUB] });
    expect(h.restored).toEqual([`${STORE}:unpaid`]);
    expect(storeStatus(db)).toEqual({ status: 'active', reason: null });
    expect(h2.sent.filter(e => e.kind === 'store_suspended')).toHaveLength(0);
  });

  it('another worker finished the same suspension meanwhile (still past_due): nothing is restored', async () => {
    const db = rig(true);
    const after = await seedDue(db);
    const flip = h.suspend!;
    h.suspend = async id => {
      const did = await flip(id);
      db.prepare(`UPDATE store_subscriptions SET next_retry_at = NULL WHERE id = ?`).run(SUB); // the other run's step 3
      return did;
    };
    await runBillingCycle(after, undefined, { subscriptionIds: [SUB] });
    expect(h.restored).toEqual([]);
    expect(storeStatus(db).status).toBe('suspended');
  });
});
