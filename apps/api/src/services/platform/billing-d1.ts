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
import { acrossStores, type Prisma } from '@ebda/database';
import { cfBindings } from '../../cf/bindings';
import { AppError } from '../../middleware/error-handler';
import { platformFamilyOnD1 } from './cutover';

interface RawD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  };
}

function raw(): RawD1 {
  const d1 = (cfBindings() as { PLATFORM_DB?: RawD1 } | undefined)?.PLATFORM_DB;
  if (!d1) throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
  return d1;
}

async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    (
      await raw()
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results ?? []
  );
}

async function run(sql: string, ...params: unknown[]): Promise<number> {
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

export const onD1 = (): Promise<boolean> => platformFamilyOnD1('billing');

type Tx = Prisma.TransactionClient;

/**
 * `SELECT id FROM store_subscriptions WHERE store_id = $1 FOR UPDATE` -> whether the row exists. On D1 it only checks
 * existence (no lock; see the header for what replaces it).
 */
export async function lockSubscription(tx: Tx, storeId: string): Promise<boolean> {
  if (await onD1()) {
    const rows = await all<{ id: string }>(
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
  const rows = await all<{ plan_code: string; n: number }>(
    'SELECT plan_code, COUNT(*) AS n FROM store_subscriptions GROUP BY plan_code'
  );
  return new Map(rows.map(r => [r.plan_code, Number(r.n)]));
}

/** `ebda_plan_store_ids(code)`. */
export async function storeIdsOnPlanD1(planCode: string): Promise<string[]> {
  return (
    await all<{ store_id: string }>(
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
  const rows = await all<{ store_id: string }>(
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
  const rows = await all<{ store_id: string }>(
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
  const changes = await run(
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
  return all(
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
  const rows = await all<{ period_end_before: number; period_end_after: number }>(
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
