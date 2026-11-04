/**
 * NEON-ZERO-1 (N-10): the raw-SQL corners of the billing family that the prisma-shaped router cannot reach: SECURITY
 * DEFINER lookups, row locks and advisory-lock caps. Each helper has a Postgres original next to its caller; the caller
 * picks D1 only when `platformFamilyOnD1('billing')` (services/platform/cutover.ts), so before the cutover none of this
 * runs.
 *
 * D1 has no `SELECT ... FOR UPDATE` and no advisory lock. What replaces them:
 *   - caps ("20 founding slots", "3 referrer rewards") -> ONE `INSERT ... SELECT ... WHERE (SELECT COUNT(*)) < cap`
 *     statement; D1 runs a statement atomically and one at a time per database, so two concurrent first payments cannot
 *     both take the last slot (`insertCappedGrant`).
 *   - claims (revoke / restore) -> one `UPDATE ... RETURNING`, already a single statement in Postgres.
 *   - the subscription row lock -> none; the writers that used it compare-and-set on the value they read
 *     (grants.service `applyPendingGrants`, account.service manual payment) and alert on a lost race.
 * Rows are the raw D1 shape here (epoch-ms integers, snake_case): callers convert with `fromMs`.
 */
import { acrossStores, notifyModelWrite, type Prisma } from '@ebda/database';
import { cfBindings } from '../../cf/bindings';
import { AppError } from '../../middleware/error-handler';
import { platformFamilyOnD1, type PlatformFamily } from './cutover';

interface RawD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
  /** Atomic: all statements commit or none do. */
  batch?(stmts: unknown[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

function raw(): RawD1 {
  const d1 = (cfBindings() as { PLATFORM_DB?: RawD1 } | undefined)?.PLATFORM_DB;
  if (!d1) throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
  return d1;
}

export async function d1All<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    (
      await raw()
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results ?? []
  );
}

export async function d1Run(sql: string, ...params: unknown[]): Promise<number> {
  return Number(
    (
      await raw()
        .prepare(sql)
        .bind(...params)
        .run()
    ).meta?.changes ?? 0
  );
}

export const fromMs = (v: number | null | undefined): Date | null =>
  v === null || v === undefined ? null : new Date(Number(v));

export const onD1 = (family: PlatformFamily = 'billing'): Promise<boolean> =>
  platformFamilyOnD1(family);

type Tx = Prisma.TransactionClient;

/**
 * `SELECT id FROM store_subscriptions WHERE store_id = $1 FOR UPDATE` -> whether the row exists. On D1 it only checks
 * existence (no lock; see the header for what replaces it).
 */
export async function lockSubscription(tx: Tx, storeId: string): Promise<boolean> {
  if (await onD1()) {
    const rows = await d1All<{ id: string }>(
      'SELECT id FROM store_subscriptions WHERE store_id = ?1',
      storeId
    );
    return rows.length > 0;
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM store_subscriptions WHERE store_id = ${storeId} FOR UPDATE`;
  return rows.length > 0;
}

/** `ebda_plan_subscriber_counts()`. The caller is a super_admin route (the definer's own check is the route's `authorize`). */
export async function planSubscriberCountsD1(): Promise<Map<string, number>> {
  const rows = await d1All<{ plan_code: string; n: number }>(
    'SELECT plan_code, COUNT(*) AS n FROM store_subscriptions GROUP BY plan_code'
  );
  return new Map(rows.map(r => [r.plan_code, Number(r.n)]));
}

/** `ebda_plan_store_ids(code)`. */
export async function storeIdsOnPlanD1(planCode: string): Promise<string[]> {
  return (
    await d1All<{ store_id: string }>(
      'SELECT store_id FROM store_subscriptions WHERE plan_code = ?1',
      planCode
    )
  ).map(r => r.store_id);
}

/** `ebda_entity_store_id` for the two kinds this family owns. */
export async function entityStoreIdD1(
  kind: 'billing_event' | 'store_subscription',
  id: string
): Promise<string | null> {
  const table = kind === 'billing_event' ? 'billing_events' : 'store_subscriptions';
  const rows = await d1All<{ store_id: string }>(
    `SELECT store_id FROM ${table} WHERE id = ?1 LIMIT 1`,
    id
  );
  return rows[0]?.store_id ?? null;
}

/** `ebda_billing_refund_store_id`: the store of the PENDING refund row with this provider reference. */
export async function refundStoreIdD1(
  provider: string,
  providerRef: string
): Promise<string | null> {
  const rows = await d1All<{ store_id: string }>(
    `SELECT store_id FROM billing_events
      WHERE type = 'refund' AND status = 'pending' AND provider = ?1 AND provider_ref = ?2 LIMIT 1`,
    provider,
    providerRef
  );
  return rows[0]?.store_id ?? null;
}

export interface GrantInsert {
  id: string;
  kind: string;
  beneficiaryId: string;
  counterpartId: string | null;
  valueMinor: number;
  key: string;
  sourceEventId: string;
  sourceStoreId: string;
}

/**
 * Insert a grant only while fewer than `cap.max` live (not revoked) grants match `cap`, in ONE statement. Idempotent on
 * the key (`ON CONFLICT DO NOTHING`). Returns whether a row was inserted.
 */
export async function insertCappedGrant(
  g: GrantInsert,
  cap: { kind: string; beneficiaryId?: string; max: number }
): Promise<boolean> {
  const changes = await d1Run(
    `INSERT INTO billing_grants (id, kind, beneficiary_id, counterpart_id, months, value_minor, status, idempotency_key, source_event_id, source_store_id)
     SELECT ?1, ?2, ?3, ?4, 1, ?5, 'pending', ?6, ?7, ?8
      WHERE (SELECT COUNT(*) FROM billing_grants
              WHERE kind = ?9 AND status <> 'revoked' AND (?10 IS NULL OR beneficiary_id = ?10)) < ?11
     ON CONFLICT (idempotency_key) DO NOTHING`,
    g.id,
    g.kind,
    g.beneficiaryId,
    g.counterpartId,
    g.valueMinor,
    g.key,
    g.sourceEventId,
    g.sourceStoreId,
    cap.kind,
    cap.beneficiaryId ?? null,
    cap.max
  );
  return changes === 1;
}

/** `UPDATE billing_grants SET status = 'revoked' ... RETURNING id, beneficiary_id` (pending|applied -> revoked, once). */
export async function revokeGrantsD1(
  eventId: string,
  reason: string,
  now: Date
): Promise<Array<{ id: string; beneficiary_id: string }>> {
  return d1All(
    `UPDATE billing_grants SET status = 'revoked', revoked_at = ?1, revoke_reason = ?2
      WHERE source_event_id = ?3 AND status IN ('pending', 'applied')
      RETURNING id, beneficiary_id`,
    now.getTime(),
    reason,
    eventId
  );
}

/** Claim the restore of one revoked, applied grant (once). Returns the period it moved, or null if already claimed. */
export async function claimRestoreD1(
  grantId: string,
  now: Date
): Promise<{ before: Date; after: Date } | null> {
  const rows = await d1All<{ period_end_before: number; period_end_after: number }>(
    `UPDATE billing_grants SET restored_at = ?1
      WHERE id = ?2 AND status = 'revoked' AND restored_at IS NULL AND period_end_after IS NOT NULL
      RETURNING period_end_before, period_end_after`,
    now.getTime(),
    grantId
  );
  return rows[0]
    ? {
        before: new Date(Number(rows[0].period_end_before)),
        after: new Date(Number(rows[0].period_end_after)),
      }
    : null;
}

/**
 * A cross-store scan over billing models only. Postgres: one transaction per store (`acrossStores`, strict RLS). D1: ONE
 * query without a store filter (NEON-SCALE-1 rule 7: nothing loops over stores inside a job step when one indexed query
 * does it); `fn` receives `undefined` and must then omit the `storeId` condition.
 */
export async function acrossBilling<T>(
  fn: (storeId?: string) => Promise<T>,
  opts: { onStoreError?: (storeId: string, err: unknown) => void } = {}
): Promise<Array<{ storeId?: string; value: T }>> {
  if (await onD1()) return [{ value: await fn(undefined) }];
  return acrossStores(storeId => fn(storeId), opts);
}

/** D1 `batch`: every statement commits together or none does. Returns the rows changed by each statement. */
export async function d1Batch(stmts: Array<{ sql: string; params: unknown[] }>): Promise<number[]> {
  const d1 = raw();
  if (!d1.batch)
    throw new AppError(503, 'PLATFORM_DB_NO_BATCH', 'Platform database has no batch()');
  const res = await d1.batch(stmts.map(st => d1.prepare(st.sql).bind(...st.params)));
  return res.map(r => Number(r.meta?.changes ?? 0));
}

export interface ManualPaymentD1 {
  eventId: string;
  idempotencyKey: string;
  storeId: string;
  subscriptionId: string | null;
  planCode: string;
  interval: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinor: number;
  providerRef: string;
  vatMinor: number;
  vat: unknown | null;
  raw: unknown;
  anchorDay: number;
  billingMethod: string;
  /** `updated_at` of the subscription row this payment was computed from (null = there was none). */
  expectedSubUpdatedAt: Date | null;
  now: Date;
}

/**
 * Ledger row + subscription change of a manual payment as ONE atomic D1 batch (Ruling NZ-10-2). Both statements carry the
 * same compare-and-set on the subscription row the period was computed from, so a concurrent change (a grant, a renewal)
 * makes BOTH miss; the second statement additionally requires that THIS batch inserted the ledger row. Returns
 * 'applied', 'duplicate' (the key already existed) or 'conflict' (the subscription moved: nothing was written; retry).
 */
export async function commitManualPaymentD1(
  a: ManualPaymentD1
): Promise<'applied' | 'duplicate' | 'conflict'> {
  const nowMs = a.now.getTime();
  const cas = `(NOT EXISTS (SELECT 1 FROM store_subscriptions WHERE store_id = ?2)
        OR EXISTS (SELECT 1 FROM store_subscriptions WHERE store_id = ?2 AND updated_at IS ?3))`;
  const changes = await d1Batch([
    {
      sql: `INSERT INTO billing_events (id, store_id, subscription_id, type, plan_code, billing_interval, for_period_end, amount_minor, currency, provider, provider_ref, idempotency_key, status, vat_minor, vat, raw, created_at, updated_at)
            SELECT ?1, ?2, ?4, 'manual_payment', ?5, ?6, ?7, ?8, 'EGP', 'manual', ?9, ?10, 'succeeded', ?11, ?12, ?13, ?14, ?14
             WHERE ${cas}
            ON CONFLICT (idempotency_key) DO NOTHING`,
      params: [
        a.eventId,
        a.storeId,
        a.expectedSubUpdatedAt ? a.expectedSubUpdatedAt.getTime() : null,
        a.subscriptionId,
        a.planCode,
        a.interval,
        a.periodEnd.getTime(),
        a.amountMinor,
        a.providerRef,
        a.idempotencyKey,
        a.vatMinor,
        a.vat === null ? null : JSON.stringify(a.vat),
        JSON.stringify(a.raw),
        nowMs,
      ],
    },
    {
      sql: `INSERT INTO store_subscriptions (id, store_id, plan_code, status, billing_interval, current_period_start, current_period_end, billing_anchor_day, trial_ends_at, pending_plan_code, cancel_at_period_end, dunning_attempts, next_retry_at, billing_method, created_at, updated_at)
            SELECT ?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, NULL, NULL, 0, 0, NULL, ?8, ?9, ?9
             WHERE EXISTS (SELECT 1 FROM billing_events WHERE id = ?10 AND created_at = ?9 AND store_id = ?2)
            ON CONFLICT (store_id) DO UPDATE SET
              plan_code = excluded.plan_code, status = 'active', billing_interval = excluded.billing_interval,
              current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
              billing_anchor_day = excluded.billing_anchor_day, trial_ends_at = NULL, pending_plan_code = NULL,
              cancel_at_period_end = 0, dunning_attempts = 0, next_retry_at = NULL,
              billing_method = excluded.billing_method, updated_at = excluded.updated_at`,
      params: [
        a.subscriptionId ?? crypto.randomUUID(),
        a.storeId,
        a.planCode,
        a.interval,
        a.periodStart.getTime(),
        a.periodEnd.getTime(),
        a.anchorDay,
        a.billingMethod,
        nowMs,
        a.eventId,
      ],
    },
  ]);
  if (changes[0] === 1 && changes[1] >= 1) {
    // wa-plan: observer notified here (raw D1 write; tests/unit/wa-plan-observer-wiring.test.ts)
    notifyModelWrite(
      'StoreSubscription',
      'update',
      {
        where: { storeId: a.storeId },
        data: { planCode: a.planCode, status: 'active', currentPeriodEnd: a.periodEnd },
      },
      { storeId: a.storeId }
    );
    return 'applied';
  }
  const existing = await d1All<{ id: string }>(
    'SELECT id FROM billing_events WHERE idempotency_key = ?1 AND store_id = ?2',
    a.idempotencyKey,
    a.storeId
  );
  return existing.length ? 'duplicate' : 'conflict';
}

const GRANT_CHUNK = 50;

export interface GrantBatchD1 {
  storeId: string;
  status: string;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  /** The chain, oldest first: each grant moves the end from `before` to `after`. */
  grants: Array<{ id: string; before: Date; after: Date }>;
  trialing: boolean;
  now: Date;
}

/**
 * Apply N pending free-month grants and move the subscription as ONE atomic batch. The subscription update goes first and
 * is guarded by (the period and status this call read) AND (all N grants still pending); the grant updates then require
 * that the subscription now ends where the chain ends. So either everything applies or nothing does: a concurrent
 * renewal or grant makes the guard miss and the grants simply stay `pending` for the next sweep. Returns grants applied.
 */
export async function applyGrantsBatchD1(a: GrantBatchD1): Promise<number> {
  // D1 caps bound parameters per statement (~100): the guard binds 7 + one per grant, so cut the chain into chunks. Each
  // chunk is atomic on its own and starts from the end the previous chunk left; a miss stops the rest (still pending).
  if (a.grants.length > GRANT_CHUNK) {
    let applied = 0;
    let current: GrantBatchD1 = a;
    for (let i = 0; i < a.grants.length; i += GRANT_CHUNK) {
      const part = a.grants.slice(i, i + GRANT_CHUNK);
      const n = await applyGrantsBatchD1({ ...current, grants: part });
      applied += n;
      if (n !== part.length) break;
      const end = part[part.length - 1].after;
      current = {
        ...current,
        currentPeriodEnd: end,
        trialEndsAt: a.trialing ? end : a.trialEndsAt,
        now: new Date(a.now.getTime() + 1),
      };
    }
    return applied;
  }
  const end = a.grants[a.grants.length - 1].after;
  const ids = a.grants.map(g => g.id);
  const marks = ids.map((_, i) => `?${i + 8}`).join(', ');
  const nowMs = a.now.getTime();
  const subStmt = {
    sql: `UPDATE store_subscriptions
             SET current_period_end = ?1, ${a.trialing ? 'trial_ends_at = ?1,' : ''} updated_at = ?2
           WHERE store_id = ?3 AND status = ?4 AND current_period_end IS ?5 AND trial_ends_at IS ?6
             AND (SELECT COUNT(*) FROM billing_grants WHERE id IN (${marks}) AND status = 'pending') = ?7`,
    params: [
      end.getTime(),
      nowMs,
      a.storeId,
      a.status,
      a.currentPeriodEnd ? a.currentPeriodEnd.getTime() : null,
      a.trialEndsAt ? a.trialEndsAt.getTime() : null,
      ids.length,
      ...ids,
    ],
  };
  const grantStmts = a.grants.map(g => ({
    sql: `UPDATE billing_grants SET status = 'applied', applied_at = ?1, period_end_before = ?2, period_end_after = ?3
           WHERE id = ?4 AND status = 'pending'
             AND EXISTS (SELECT 1 FROM store_subscriptions WHERE store_id = ?5 AND current_period_end = ?6 AND updated_at = ?1)`,
    params: [nowMs, g.before.getTime(), g.after.getTime(), g.id, a.storeId, end.getTime()],
  }));
  const changes = await d1Batch([subStmt, ...grantStmts]);
  const applied = changes[0] === 1 ? changes.slice(1).reduce((n, c) => n + c, 0) : 0;
  if (applied > 0)
    // wa-plan: observer notified here (raw D1 write; tests/unit/wa-plan-observer-wiring.test.ts)
    notifyModelWrite(
      'StoreSubscription',
      'update',
      { where: { storeId: a.storeId }, data: { currentPeriodEnd: end } },
      { storeId: a.storeId }
    );
  return applied;
}

/** The store that already holds this idempotency key in the ledger (any store), or null. */
export async function idempotencyKeyStoreD1(key: string): Promise<string | null> {
  const rows = await d1All<{ store_id: string }>(
    'SELECT store_id FROM billing_events WHERE idempotency_key = ?1 LIMIT 1',
    key
  );
  return rows[0]?.store_id ?? null;
}

/** Stores whose directory tier (`stores.plan`) differs from the tier of the plan their subscription names. */
export async function planTierDriftD1(
  limit: number
): Promise<Array<{ storeId: string; current: string; tier: string }>> {
  return d1All<{ storeId: string; current: string; tier: string }>(
    `SELECT s.id AS storeId, s.plan AS current, p.feature_tier AS tier
       FROM store_subscriptions ss
       JOIN stores s ON s.id = ss.store_id
       JOIN plans p ON p.code = ss.plan_code
      WHERE s.deleted_at IS NULL AND s.plan <> p.feature_tier
      LIMIT ?1`,
    limit
  );
}

/**
 * A verified billing webhook that arrived while the family is frozen: stored durably (raw SQL, so the router's write
 * freeze does not apply) in the dedupe table as `outcome = 'deferred'`, idempotent on (provider, event_id). The payload
 * is the provider-verified normalised event plus the raw body for audit. Returns false when the event was already known.
 */
export async function deferBillingWebhookD1(a: {
  provider: string;
  eventId: string;
  eventType: string;
  payload: unknown;
}): Promise<boolean> {
  const changes = await d1Run(
    `INSERT INTO billing_webhook_events (id, provider, event_id, event_type, outcome, detail, received_at)
     VALUES (?1, ?2, ?3, ?4, 'deferred', ?5, ?6)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    crypto.randomUUID(),
    a.provider,
    a.eventId,
    a.eventType,
    JSON.stringify(a.payload),
    Date.now()
  );
  return changes === 1;
}

export async function listDeferredBillingWebhooksD1(
  limit: number
): Promise<Array<{ provider: string; eventId: string; detail: string }>> {
  return d1All<{ provider: string; eventId: string; detail: string }>(
    `SELECT provider, event_id AS eventId, detail FROM billing_webhook_events
      WHERE outcome = 'deferred' ORDER BY received_at ASC LIMIT ?1`,
    limit
  );
}
