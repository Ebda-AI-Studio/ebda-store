#!/usr/bin/env node
/**
 * One-off ops (P17, Ahmad 2026-11-12): GRANT a store a paid plan for one period on the platform D1, with NO money row.
 * Internal test store (owner family) stays out of the financial records: no billing_events row, no amount.
 * DRY-RUN by default; --apply needs --confirm <store-id>. Compare-and-set on store_subscriptions.updated_at.
 *   CLOUDFLARE_ACCOUNT_ID=... PLATFORM_DB_ID=<uuid> node scripts/ops/grant-plan-d1.mjs --store-id <uuid> \
 *     --plan business --interval yearly --reason "<text>" [--apply --confirm <store-id>]
 * Writes (apply): store_subscriptions (plan, active, interval, period now -> +1 interval, instapay, pending/trial/dunning cleared),
 * stores.plan = plan feature tier, one platform_audit_log row. Caches (feature 5 min TTL, store payload) are NOT bustable
 * from here: they expire on their own; for an immediate bust re-save the store in super-admin.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const lit = v =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
export const addInterval = (d, interval) => {
  const e = new Date(d.getTime());
  if (interval === 'yearly') e.setUTCFullYear(e.getUTCFullYear() + 1);
  else e.setUTCMonth(e.getUTCMonth() + 1);
  return e;
};

/** Pure decision. state = { store, sub, plan, vatRow }. */
export function planGrant(state, { planCode, interval }) {
  const { store, sub, plan } = state;
  if (!store || store.deleted_at !== null)
    return { action: 'refuse', reason: 'store_missing_or_deleted' };
  if (!plan || plan.code !== planCode) return { action: 'refuse', reason: 'plan_not_found' };
  if (!sub) return { action: 'refuse', reason: 'no_subscription' };
  if (
    sub.plan_code === planCode &&
    sub.status === 'active' &&
    sub.billing_interval === interval &&
    !sub.pending_plan_code
  )
    return { action: 'noop', reason: 'already_granted' };
  if (
    sub.status === 'active' &&
    sub.plan_code !== 'comped' &&
    sub.billing_method === 'instapay' &&
    sub.updated_at &&
    state.hasPaid
  )
    return { action: 'refuse', reason: 'has_paid_history' };
  return {
    action: 'grant',
    from: {
      plan: sub.plan_code,
      status: sub.status,
      interval: sub.billing_interval,
      periodEnd: sub.current_period_end,
      pending: sub.pending_plan_code,
    },
  };
}

export function buildStatements({
  storeId,
  plan,
  interval,
  now,
  expectedUpdatedAt,
  reason,
  auditId,
}) {
  const n = now.getTime(),
    end = addInterval(now, interval).getTime();
  const cas = `(SELECT updated_at FROM store_subscriptions WHERE store_id = ${lit(storeId)}) IS ${lit(expectedUpdatedAt)}`;
  return [
    `UPDATE store_subscriptions SET plan_code=${lit(plan.code)}, status='active', billing_interval=${lit(interval)}, current_period_start=${n}, current_period_end=${end}, billing_anchor_day=${now.getUTCDate()}, billing_method='instapay', pending_plan_code=NULL, trial_ends_at=NULL, cancel_at_period_end=0, dunning_attempts=0, next_retry_at=NULL, past_due_since=NULL, orders_over_limit_month=NULL, orders_over_limit_notified_at=NULL, updated_at=${n} WHERE store_id=${lit(storeId)} AND ${cas}`,
    `UPDATE stores SET plan=${lit(plan.feature_tier)}, updated_at=${n} WHERE id=${lit(storeId)} AND EXISTS (SELECT 1 FROM store_subscriptions WHERE store_id=${lit(storeId)} AND updated_at=${n} AND plan_code=${lit(plan.code)})`,
    `INSERT INTO platform_audit_log (id, actor_id, action, target_type, target_id, store_id, meta, created_at) SELECT ${lit(auditId)}, NULL, 'billing.plan_granted_no_payment', 'store_subscription', ${lit(storeId)}, ${lit(storeId)}, ${lit(JSON.stringify({ planCode: plan.code, interval, periodStart: new Date(n).toISOString(), periodEnd: new Date(end).toISOString(), reason, ledger: 'none' }))}, ${n} WHERE EXISTS (SELECT 1 FROM store_subscriptions WHERE store_id=${lit(storeId)} AND updated_at=${n} AND plan_code=${lit(plan.code)})`,
  ];
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const a = process.argv.slice(2),
    opt = k => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : undefined);
  const die = m => {
    console.error(m);
    process.exit(2);
  };
  const dbId = process.env.PLATFORM_DB_ID;
  if (!dbId || !process.env.CLOUDFLARE_ACCOUNT_ID)
    die('set CLOUDFLARE_ACCOUNT_ID and PLATFORM_DB_ID');
  const storeId = opt('--store-id'),
    planCode = opt('--plan'),
    interval = opt('--interval'),
    reason = opt('--reason');
  if (!/^[0-9a-f-]{36}$/.test(storeId ?? '')) die('--store-id <uuid> required');
  if (!planCode || !['monthly', 'yearly'].includes(interval) || !reason)
    die('--plan, --interval monthly|yearly, --reason required');
  const apply = a.includes('--apply');
  if (apply && opt('--confirm') !== storeId) die(`--apply needs --confirm ${storeId}`);
  const dir = mkdtempSync(join(tmpdir(), 'grant-plan-'));
  writeFileSync(
    join(dir, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'q',
      d1_databases: [{ binding: 'DB', database_name: 'ebda-platform', database_id: dbId }],
    })
  );
  try {
    const run = sql => {
      const out = execFileSync(
        'npx',
        ['wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql],
        { cwd: dir, encoding: 'utf8' }
      );
      const j = JSON.parse(out.slice(out.indexOf('[')));
      if (j.some(x => x.success === false))
        throw new Error('D1 failed: ' + JSON.stringify(j).slice(0, 300));
      return j;
    };
    const one = sql => run(sql).at(-1).results;
    const state = {
      store: one(
        `SELECT id, slug, status, plan, deleted_at FROM stores WHERE id=${lit(storeId)}`
      )[0],
      sub: one(`SELECT * FROM store_subscriptions WHERE store_id=${lit(storeId)}`)[0],
      plan: one(
        `SELECT code, feature_tier, price_yearly_minor FROM plans WHERE code=${lit(planCode)}`
      )[0],
      hasPaid:
        one(
          `SELECT 1 x FROM billing_events WHERE store_id=${lit(storeId)} AND status='succeeded' LIMIT 1`
        ).length > 0,
    };
    const now = new Date();
    const decision = planGrant(state, { planCode, interval });
    const stmts =
      decision.action === 'grant'
        ? buildStatements({
            storeId,
            plan: state.plan,
            interval,
            now,
            expectedUpdatedAt: state.sub.updated_at,
            reason,
            auditId: randomUUID(),
          })
        : [];
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'APPLY' : 'DRY-RUN',
          storeId,
          slug: state.store?.slug,
          decision,
          would:
            decision.action === 'grant'
              ? {
                  plan: planCode,
                  interval,
                  periodStart: now.toISOString(),
                  periodEnd: addInterval(now, interval).toISOString(),
                  billingMethod: 'instapay',
                  clears: ['pending_plan_code', 'trial_ends_at'],
                  ledgerRow: false,
                  storesPlan: state.plan.feature_tier,
                  audit: 'platform_audit_log billing.plan_granted_no_payment',
                }
              : null,
        },
        null,
        2
      )
    );
    if (decision.action === 'refuse') process.exitCode = 1;
    if (apply && decision.action === 'grant') {
      const r = run(stmts.join(';\n'));
      console.log(
        'changes',
        r.map(x => x.meta?.changes)
      );
      if (!(r[0].meta.changes >= 1))
        throw new Error('compare-and-set lost: subscription changed; nothing written, re-run');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
