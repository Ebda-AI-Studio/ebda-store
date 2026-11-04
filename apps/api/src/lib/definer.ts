import { randomUUID } from 'node:crypto';
import { platformFamilyOnD1 } from '../services/platform/cutover';
import { requirePlatformDb } from './platform-db';
import {
  d1Run,
  entityStoreIdD1,
  onD1 as onBillingD1,
  planSubscriberCountsD1,
  refundStoreIdD1,
  storeIdsOnPlanD1,
} from '../services/platform/billing-d1';
import { prisma, withStore, withSystemJob, type Prisma } from '@ebda/database';
import { onAccessD1, ownedStoreIdsD1 } from '../services/platform/access-d1';
import {
  inboxGetD1,
  inboxListD1,
  inboxRecordD1,
  inboxStuckD1,
  inboxUpdateD1,
  revokeUserMerchantKeysD1,
  withdrawLegalSendD1,
} from '../services/platform/platform-d1';
import {
  assertFamilyWritableOnPostgres,
  assertNotFrozen,
  isFamilyFrozen,
} from '../services/platform/cutover';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import {
  d1LookupStore,
  d1PublicStorePage,
  d1StoreIdByDomain,
  d1StoreIdBySlug,
  d1StoreIdsClaimingDomain,
  platformDb,
} from './platform-directory';
import { backendFor, hasStoresOnBackend } from './store-backend';

/**
 * Typed wrappers for the SECURITY DEFINER functions of the strict-RLS migration
 * (`20261004000000_ebda_strict_rls`). They are the ONLY way the API reaches data
 * before a store or user is known, or across stores. Ebda did the same with an
 * `app.bypass_rls` GUC that the policies honoured; under `ebda_app` there is no
 * such flag, only these narrow, named functions (fixed search_path, exact-key
 * lookups, no dynamic SQL).
 *
 * Every wrapper goes through the `prisma` proxy, so inside a request
 * transaction the call joins it (savepoints, commit-before-respond) and outside
 * one it is a single short statement.
 */

/** host -> store id: an ACTIVE store whose slug or custom domain matches exactly. */
export async function resolveStoreId(match: {
  slug?: string | null;
  domain?: string | null;
}): Promise<string | null> {
  if (!match.slug && !match.domain) return null;
  // NEON-ZERO-1 (N-1 follow-up): a deployed Worker resolves a host from the D1 directory only (no Postgres fallback).
  const d1 = platformDb();
  if (d1) return (await d1LookupStore(d1, match, ['active']))?.id ?? null;
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_resolve_store_id(${match.slug ?? null}, ${match.domain ?? null}) AS id`;
  return rows[0]?.id ?? null;
}

export interface UserState {
  id: string;
  role: string;
  status: string;
  tokenVersion: number;
  storeId: string | null;
  deletedAt: Date | null;
}

/** The facts an access-token check needs about one user, by exact id. */
export async function getUserState(userId: string): Promise<UserState | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      role: string;
      status: string;
      token_version: number;
      store_id: string | null;
      deleted_at: Date | null;
    }>
  >`SELECT id, role, status, token_version, store_id, deleted_at FROM public.ebda_user_state(${userId})`;
  const r = rows[0];
  return r
    ? {
        id: r.id,
        role: r.role,
        status: r.status,
        tokenVersion: r.token_version,
        storeId: r.store_id,
        deletedAt: r.deleted_at,
      }
    : null;
}

/**
 * Email -> user id inside ONE namespace (`storeId` null = the admin namespace).
 * The login/registration lookup: the caller does not yet know who the user is,
 * so it cannot scope to them. Returns the id only; read the row afterwards with
 * `withUser(id, ...)`.
 */
export async function findUserIdByEmail(
  email: string,
  storeId: string | null,
  opts: { includeDeleted?: boolean; caseInsensitive?: boolean } = {}
): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_auth_find_user_id(
      ${email}, ${storeId}, ${opts.includeDeleted === true}, ${opts.caseInsensitive === true}) AS id`;
  return rows[0]?.id ?? null;
}

export interface AuditEntry {
  action: string;
  userId?: string | null;
  storeId?: string | null;
  resourceType: string;
  resourceId?: string | null;
  details?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append one audit row. `audit_logs` is store-scoped under RLS, but platform
 * events (a failed login, a super-admin action) carry no store and a request may
 * log against a store other than its own, so the write goes through a definer.
 * Append-only: `ebda_app` still reads its store's rows through the policy.
 */
export async function insertAuditLog(entry: AuditEntry): Promise<void> {
  // NEON-ZERO-1: a PLATFORM event (no store) goes to the platform audit trail in D1; a store's own rows live in its
  // Durable Object. Postgres is not asked on a Worker that has D1.
  if (!entry.storeId && platformDb()) {
    await d1Run(
      `INSERT INTO platform_audit_log (id, actor_id, action, target_type, target_id, store_id, meta, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)`,
      randomUUID(),
      entry.userId ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      JSON.stringify({
        ...(entry.details && typeof entry.details === 'object' ? entry.details : {}),
        ...(entry.ip ? { ip: entry.ip } : {}),
        ...(entry.userAgent ? { userAgent: entry.userAgent } : {}),
      }),
      Date.now()
    );
    return;
  }
  await prisma.$queryRaw`
    SELECT public.ebda_audit_log_insert(
      ${randomUUID()}, ${entry.action}, ${entry.userId ?? null}, ${entry.storeId ?? null},
      ${entry.resourceType}, ${entry.resourceId ?? null},
      ${JSON.stringify(entry.details ?? {})}::jsonb,
      ${entry.ip ?? null}, ${entry.userAgent ?? null}
    )`;
}

export interface AdminUser {
  id: string;
  created: boolean;
  role: string;
  status: string;
  /** The email and name the CALLER supplied: the stored name of an existing account is never returned. */
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Find-or-create an account in the ADMIN namespace (`users.store_id` NULL):
 * store owners and staff. An existing account is returned untouched (`created`
 * false); otherwise a `store_admin` or `staff` account is made. The function
 * refuses any other role, so it can never mint a super_admin or a customer.
 * Not visible from a store scope, hence the definer.
 */
export async function ensureAdminUser(
  input: {
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    role: 'store_admin' | 'staff';
    emailVerified?: boolean;
  },
  /** A transaction the caller already opened (provisioning); defaults to the ambient `prisma`. */
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma
): Promise<AdminUser> {
  const rows = await db.$queryRaw<
    Array<{ user_id: string; created: boolean; role: string; status: string }>
  >`SELECT * FROM public.ebda_admin_user_ensure(
      ${input.email}, ${input.passwordHash}, ${input.firstName}, ${input.lastName},
      ${input.role}, ${input.emailVerified === true})`;
  const r = rows[0];
  return {
    id: r.user_id,
    created: r.created,
    role: r.role,
    status: r.status,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
  };
}

// ---------------------------------------------------------------------------
// Payment webhooks: routing and the inbox
// ---------------------------------------------------------------------------

/** A provider reference (transaction or invoice id) -> the store that owns the payment. */
export async function resolveStoreFromWebhookRef(ref: {
  transactionId?: string | null;
  invoiceId?: string | null;
  /** Match only payments of this provider (a reference string is unique per provider, not across them). */
  provider?: string | null;
  /** When two stores hold the same reference, prefer this one (the store a per-store webhook URL names). */
  preferStoreId?: string | null;
}): Promise<string | null> {
  if (!ref.transactionId && !ref.invoiceId) return null;
  // Ruling NZ-N12-1/2: with D1 bound the entity index answers first (a Durable Object store). On an index miss the Postgres
  // definer is asked ONLY while a `pg` store exists in the directory, and its answer is accepted ONLY for a store the directory
  // says is `pg` (a stale Postgres row of a flipped store is never routed). A Postgres failure on that leg is "unresolved"
  // (the caller answers 503 + retry), never a 500.
  if (platformDb()) {
    const viaIndex = await resolveDoStoreFromWebhookRef(ref);
    if (viaIndex) return viaIndex;
    if (!(await hasStoresOnBackend('pg'))) return null;
    try {
      const viaPg = await resolveStoreFromWebhookRefPg(ref);
      return viaPg && (await backendFor(viaPg)) === 'pg' ? viaPg : null;
    } catch (err) {
      if (err instanceof AppError) throw err;
      return null;
    }
  }
  const found = await resolveStoreFromWebhookRefPg(ref);
  // Not a Postgres payment: a store on its Durable Object has no `payments` row here. Its references live in the D1 entity
  // index (Ruling CF-PAY-1), written in the same DO section that created the payment.
  return found ?? (await resolveDoStoreFromWebhookRef(ref));
}

async function resolveStoreFromWebhookRefPg(ref: {
  transactionId?: string | null;
  invoiceId?: string | null;
  provider?: string | null;
  preferStoreId?: string | null;
}): Promise<string | null> {
  let found: string | null;
  if (ref.provider || ref.preferStoreId) {
    const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT public.ebda_webhook_resolve_store_scoped(${ref.transactionId ?? null}, ${ref.invoiceId ?? null}, ${ref.provider ?? null}, ${ref.preferStoreId ?? null}) AS id`;
    found = rows[0]?.id ?? null;
  } else {
    const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT public.ebda_webhook_resolve_store(${ref.transactionId ?? null}, ${ref.invoiceId ?? null}) AS id`;
    found = rows[0]?.id ?? null;
  }
  return found;
}

/**
 * The Durable Object store that owns a provider reference, via the D1 entity index, or null. Only a store the fleet flag
 * lists is ever returned (an index row for a store that has gone back to Postgres is stale; the definer above owns it), and
 * a reference that points at a store NOT in the flag is treated as unresolved, never routed (tenant-resolver rule).
 */
export async function resolveDoStoreFromWebhookRef(ref: {
  transactionId?: string | null;
  invoiceId?: string | null;
  provider?: string | null;
  /** The store a per-store webhook URL names: the D1 answer is accepted only if it IS this store (WEBHOOK-SCOPE-1). */
  preferStoreId?: string | null;
}): Promise<string | null> {
  // Same contract as the Postgres resolver (`ebda_webhook_resolve_store_scoped`): a reference is unique per PROVIDER, so an
  // empty provider resolves nothing, and only the provider-scoped `webhook` key is read - never the unscoped `payment` kind.
  if (!ref.provider || !(await hasStoresOnBackend('do'))) return null;
  const d1 = (cfBindings() as { PLATFORM_DB?: unknown } | undefined)?.PLATFORM_DB;
  if (!d1) return null;
  const { resolveStoreId } = await import('@ebda-src/repo');
  for (const r of [ref.transactionId, ref.invoiceId]) {
    if (!r) continue;
    const id = await resolveStoreId(d1, 'webhook', `${ref.provider}:${r}`);
    if (!id) continue;
    // An index row naming a store the directory does not know is not routable (backendFor: 404), never an error.
    const backend = await backendFor(id).catch(e => {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    });
    if (backend !== 'do') continue;
    // a URL that names store A never accepts store B's reference: same answer as an unknown one
    if (ref.preferStoreId && id !== ref.preferStoreId) return null;
    return id;
  }
  return null;
}

/** An idempotency key -> the order it already settled, if any. */
export async function findOrderByIdempotencyKey(
  key: string
): Promise<{ orderId: string; storeId: string; webhookProcessedAt: Date | null } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ order_id: string; store_id: string; webhook_processed_at: Date | null }>
  >`SELECT order_id, store_id, webhook_processed_at FROM public.ebda_webhook_order_by_idempotency(${key})`;
  const r = rows[0];
  return r
    ? { orderId: r.order_id, storeId: r.store_id, webhookProcessedAt: r.webhook_processed_at }
    : null;
}

/**
 * The Durable Object store that owns an order / payment id, via the D1 entity index (Ruling CF-PAY-1; NZ-N12-2), or null.
 * Only a store the flag lists as `do` is returned (an index row of a store that went back to Postgres is stale; the definer
 * owns it). Null when D1 is unbound (Node / tests / local dev) or the id is not indexed.
 */
async function doStoreFromIndex(kind: 'order' | 'payment', id: string): Promise<string | null> {
  const d1 = platformDb();
  if (!d1) return null;
  let storeId: string | null;
  try {
    const { resolveStoreId: fromIndex } = await import('@ebda-src/repo');
    storeId = await fromIndex(d1 as never, kind, id);
  } catch {
    throw new AppError(503, 'PLATFORM_DIRECTORY_UNAVAILABLE', 'Store directory is unavailable');
  }
  return storeId && (await backendFor(storeId)) === 'do' ? storeId : null;
}

/**
 * Index miss with D1 bound: ask the Postgres definer only while a `pg` store exists, and accept its answer only for a store the
 * directory says is `pg`. Unknown id (no `pg` store in the fleet) -> null (a 404), no Postgres touched (Ruling NZ-N12-2).
 */
async function pgStoreFallback(lookup: () => Promise<string | null>): Promise<string | null> {
  if (!platformDb()) return lookup();
  if (!(await hasStoresOnBackend('pg'))) return null;
  const id = await lookup();
  return id && (await backendFor(id)) === 'pg' ? id : null;
}

/** An order id -> its store id (a Durable Object store from the D1 index first, no Postgres touched; else the definer). */
export async function getOrderStoreId(orderId: string): Promise<string | null> {
  const onDo = await doStoreFromIndex('order', orderId);
  if (onDo) return onDo;
  return pgStoreFallback(async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT public.ebda_order_store_id(${orderId}) AS id`;
    return rows[0]?.id ?? null;
  });
}

/** A payment id -> its store id (exact primary key). The caller then reads and authorises inside that store. */
export async function getPaymentStoreId(paymentId: string): Promise<string | null> {
  const onDo = await doStoreFromIndex('payment', paymentId);
  if (onDo) return onDo;
  return pgStoreFallback(async () => {
    const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT public.ebda_payment_store_id(${paymentId}) AS id`;
    return rows[0]?.id ?? null;
  });
}

/**
 * The store that owns a payment (or one of its events), for the admin payment timeline.
 * GUARDED in SQL by data: the acting user must be an active super_admin, or the owner / a
 * staff member of that payment's store; anyone else (and an unknown id) gets `null`.
 */
export async function resolvePaymentEventsStore(input: {
  actorUserId: string;
  paymentId?: string;
  eventId?: string;
}): Promise<{ storeId: string; paymentId: string } | null> {
  const rows = await prisma.$queryRaw<Array<{ store_id: string; payment_id: string }>>`
    SELECT store_id, payment_id FROM public.ebda_payment_events_store(
      ${input.actorUserId}, ${input.paymentId ?? null}, ${input.eventId ?? null})`;
  const r = rows[0];
  return r ? { storeId: r.store_id, paymentId: r.payment_id } : null;
}

export interface WebhookInboxRow {
  id: string;
  provider: string;
  idempotencyKey: string;
  storeId: string | null;
  payload: unknown;
  rawBody: string;
  signature: string;
  status: string;
  attempts: number;
  lastError: string | null;
  resultOrderId: string | null;
  resultStatus: string | null;
  receivedAt: Date;
}

type InboxDbRow = {
  id: string;
  provider: string;
  idempotency_key: string;
  store_id: string | null;
  payload: unknown;
  raw_body: string;
  signature: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result_order_id: string | null;
  result_status: string | null;
  received_at: Date;
};

const toInboxRow = (r: InboxDbRow): WebhookInboxRow => ({
  id: r.id,
  provider: r.provider,
  idempotencyKey: r.idempotency_key,
  storeId: r.store_id,
  payload: r.payload,
  rawBody: r.raw_body,
  signature: r.signature,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  resultOrderId: r.result_order_id,
  resultStatus: r.result_status,
  receivedAt: r.received_at,
});

export interface WebhookInboxPatch {
  status?: string;
  lastError?: string;
  incrementAttempts?: boolean;
  /** processed_at = now(), result columns set, last_error cleared. */
  markProcessed?: { resultOrderId?: string | null; resultStatus?: string | null };
  /** status 'received', attempts 0, last_error cleared, received_at = now(). */
  requeue?: boolean;
}

/**
 * `get` / `update` / `stuck` read raw payment payloads or change processing
 * state across stores, so the SQL functions only answer a super_admin or the
 * `webhook-inbox` system job. This wrapper is the sanctioned way to be that job:
 * the setting is transaction-local and dies with the transaction.
 */
const asWebhookInbox = <T>(fn: () => Promise<T>): Promise<T> => withSystemJob('webhook-inbox', fn);

/**
 * The payment-webhook inbox (`webhook_events`). `store_id` is NULL on the
 * platform path and the consumer must read a row before it can enter a store
 * scope, so every operation is a definer keyed by the row id / idempotency key.
 */
export const webhookInbox = {
  /** First delivery inserts; a redelivery refreshes a row that is not yet processed. */
  async record(input: {
    provider: string;
    idempotencyKey: string;
    storeId?: string | null;
    payload: object;
    rawBody: string;
    signature: string;
  }): Promise<string> {
    // A provider callback is the one thing that must never be refused (nobody may retry it). During the cutover freeze it
    // is recorded straight into D1: the copy script sets such rows aside and merges them (cutover-platform-family.mjs).
    if ((await onBillingD1('inbox')) || (await isFamilyFrozen('inbox')))
      return inboxRecordD1({
        id: randomUUID(),
        provider: input.provider,
        idempotencyKey: input.idempotencyKey,
        storeId: input.storeId ?? null,
        payload: input.payload,
        rawBody: input.rawBody,
        signature: input.signature,
      });
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT public.ebda_webhook_inbox_record(
        ${randomUUID()}, ${input.provider}, ${input.idempotencyKey}, ${input.storeId ?? null},
        ${JSON.stringify(input.payload)}::jsonb, ${input.rawBody}, ${input.signature}
      ) AS id`;
    return rows[0].id;
  },

  async get(id: string): Promise<WebhookInboxRow | null> {
    if (await onBillingD1('inbox')) {
      const r = await inboxGetD1(id);
      return r ? toInboxRow(r as InboxDbRow) : null;
    }
    const rows = await asWebhookInbox(
      () => prisma.$queryRaw<InboxDbRow[]>`SELECT * FROM public.ebda_webhook_inbox_get(${id})`
    );
    if (rows[0]) return toInboxRow(rows[0]);
    // a row recorded during the cutover freeze lives in D1 before the flip (bounded exception to "no dual read")
    const born = await inboxGetD1(id).catch(() => null);
    return born ? toInboxRow(born as InboxDbRow) : null;
  },

  async update(id: string, patch: WebhookInboxPatch): Promise<boolean> {
    if (await onBillingD1('inbox')) return inboxUpdateD1(id, patch);
    // a freeze-born row is in D1; every other row is in Postgres, whose copy is being taken: no write to it now
    if (
      await inboxGetD1(id).then(
        r => !!r,
        () => false
      )
    )
      return inboxUpdateD1(id, patch);
    await assertNotFrozen('inbox');
    const rows = await asWebhookInbox(
      () => prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT public.ebda_webhook_inbox_update(
        ${id}, ${patch.status ?? null}, ${patch.lastError ?? null},
        ${patch.incrementAttempts === true}, ${patch.markProcessed !== undefined},
        ${patch.markProcessed?.resultOrderId ?? null}, ${patch.markProcessed?.resultStatus ?? null},
        ${patch.requeue === true}
      ) AS ok`
    );
    return rows[0]?.ok === true;
  },

  /** Rows never consumed or wedged past `cutoff`, oldest first. */
  async stuck(cutoff: Date, limit: number) {
    if (await onBillingD1('inbox'))
      return (await inboxStuckD1(cutoff, limit)).map(r => ({
        id: r.id,
        provider: r.provider,
        idempotencyKey: r.idempotency_key,
        storeId: r.store_id,
        status: r.status,
        attempts: r.attempts,
        receivedAt: r.received_at,
      }));
    const rows = await asWebhookInbox(
      () =>
        prisma.$queryRaw<
          Array<{
            id: string;
            provider: string;
            idempotency_key: string;
            store_id: string | null;
            status: string;
            attempts: number;
            received_at: Date;
          }>
        >`SELECT * FROM public.ebda_webhook_inbox_stuck(${cutoff}::timestamp, ${limit}::int)`
    );
    return rows.map(r => ({
      id: r.id,
      provider: r.provider,
      idempotencyKey: r.idempotency_key,
      storeId: r.store_id,
      status: r.status,
      attempts: r.attempts,
      receivedAt: r.received_at,
    }));
  },

  /** Super-admin viewer. The function checks the actor and leaves an audit row. */
  async adminList(input: {
    actorUserId: string;
    status?: string;
    provider?: string;
    limit: number;
    offset: number;
  }) {
    if (await onBillingD1('inbox')) {
      // The Postgres definer leaves an audit row for every cross-store read; keep that property.
      await insertAuditLog({
        action: 'platform.cross_store_read',
        userId: input.actorUserId,
        resourceType: 'webhook_events',
        details: {
          fn: 'inbox_list',
          status: input.status ?? null,
          provider: input.provider ?? null,
        },
      });
      const rows = await inboxListD1(input);
      return {
        total: rows[0] ? Number(rows[0].total) : 0,
        events: rows.map(r => ({
          id: r.id,
          provider: r.provider,
          storeId: r.store_id,
          status: r.status,
          attempts: r.attempts,
          lastError: r.last_error,
          resultOrderId: r.result_order_id,
          resultStatus: r.result_status,
          idempotencyKey: r.idempotency_key,
          receivedAt: r.received_at,
        })),
      };
    }
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        provider: string;
        store_id: string | null;
        status: string;
        attempts: number;
        last_error: string | null;
        result_order_id: string | null;
        result_status: string | null;
        idempotency_key: string;
        received_at: Date;
        total: bigint;
      }>
    >`SELECT * FROM public.ebda_platform_webhook_inbox_list(
        ${input.actorUserId}, ${input.status ?? null}, ${input.provider ?? null},
        ${input.limit}::int, ${input.offset}::int)`;
    return {
      total: rows[0] ? Number(rows[0].total) : 0,
      events: rows.map(r => ({
        id: r.id,
        provider: r.provider,
        storeId: r.store_id,
        status: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        resultOrderId: r.result_order_id,
        resultStatus: r.result_status,
        idempotencyKey: r.idempotency_key,
        receivedAt: r.received_at,
      })),
    };
  },
};

/** The storefront (slug + domain) a payment-redirect callback should send the shopper back to. */
export async function getStorefrontForPaymentRef(
  ref: string
): Promise<{ slug: string; domain: string | null } | null> {
  const rows = await prisma.$queryRaw<Array<{ slug: string; domain: string | null }>>`
    SELECT slug, domain FROM public.ebda_storefront_for_payment_ref(${ref})`;
  return rows[0] ?? null;
}

/**
 * The storefront (slug + ACTIVE custom domain) of a store, for a payment-redirect callback. D1 directory when bound (no
 * Postgres), else the Store row. Null for an unknown store.
 */
export async function storefrontForStoreId(
  storeId: string
): Promise<{ slug: string; domain: string | null } | null> {
  const d1 = platformDb();
  if (d1) {
    let row: { slug: string; domain: string | null; domain_status: string | null } | null;
    try {
      row = await d1
        .prepare(
          'SELECT slug, domain, domain_status FROM stores WHERE id = ?1 AND deleted_at IS NULL'
        )
        .bind(storeId)
        .first();
    } catch {
      throw new AppError(503, 'PLATFORM_DIRECTORY_UNAVAILABLE', 'Store directory is unavailable');
    }
    return row
      ? { slug: row.slug, domain: row.domain_status === 'active' ? row.domain : null }
      : null;
  }
  const store = await withStore(storeId, () =>
    prisma.store.findUnique({ where: { id: storeId }, select: { slug: true, domain: true } })
  );
  return store ?? null;
}

/** A carrier tracking number -> the store that owns the shipment. */
export async function getShipmentStoreIdByTracking(trackingNumber: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_shipment_store_id_by_tracking(${trackingNumber}) AS id`;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Identity operations that cross the user/store boundary
// ---------------------------------------------------------------------------

/**
 * Bump the user's `token_version` and revoke their merchant MCP keys in every
 * store, in the caller's transaction. Returns the new version. Throws when the
 * user does not exist (the `update` it replaces threw P2025).
 */
export async function revokeUserSessionsRow(userId: string): Promise<{ tokenVersion: number }> {
  await assertNotFrozen('platform'); // the definer also revokes the merchant keys in Postgres: not during the copy
  const rows = await prisma.$queryRaw<Array<{ tv: number | null }>>`
    SELECT public.ebda_user_revoke_sessions(${userId}) AS tv`;
  const tv = rows[0]?.tv;
  if (tv === null || tv === undefined) {
    throw Object.assign(new Error(`User ${userId} not found`), { code: 'P2025' });
  }
  // The definer revoked the keys in Postgres; after the cutover the live keys are in D1.
  if (await onBillingD1('platform')) await revokeUserMerchantKeysD1(userId, new Date());
  return { tokenVersion: tv };
}

/** Delete every `addresses` row of a user (erasure). Runs in the caller's transaction. */
export async function deleteUserAddresses(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT public.ebda_user_addresses_delete(${userId}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Platform operator reads (super_admin). The SQL functions check the actor.
// ---------------------------------------------------------------------------

/** Which store owns a product / order / customer / journal entry id (exact primary-key match). */
export async function getEntityStoreId(
  kind:
    | 'product'
    | 'order'
    | 'customer'
    | 'journal_entry'
    | 'bulk_import_job'
    | 'billing_event'
    | 'store_subscription',
  id: string
): Promise<string | null> {
  // NEON-ZERO-1 (N-10): the billing family answers from D1 once its cutover marker exists.
  if ((kind === 'billing_event' || kind === 'store_subscription') && (await onBillingD1()))
    return entityStoreIdD1(kind, id);
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_entity_store_id(${kind}, ${id}) AS id`;
  return rows[0]?.id ?? null;
}

export const platformAuditLogs = {
  /** The super-admin audit viewer: store-scoped rows and store-less platform events. */
  async list(input: {
    actorUserId: string;
    action?: string;
    userId?: string;
    resourceType?: string;
    limit: number;
    offset: number;
  }) {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        action: string;
        user_id: string | null;
        store_id: string | null;
        resource_type: string;
        resource_id: string | null;
        details: unknown;
        ip_address: string | null;
        user_agent: string | null;
        created_at: Date;
        u_email: string | null;
        u_first_name: string | null;
        u_last_name: string | null;
        total: bigint;
      }>
    >`SELECT * FROM public.ebda_platform_audit_log_list(
        ${input.actorUserId}, ${input.action ?? null}, ${input.userId ?? null},
        ${input.resourceType ?? null}, ${input.limit}::int, ${input.offset}::int)`;
    return {
      total: rows[0] ? Number(rows[0].total) : 0,
      rows: rows.map(r => ({
        id: r.id,
        action: r.action,
        userId: r.user_id,
        storeId: r.store_id,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        details: r.details,
        ipAddress: r.ip_address,
        userAgent: r.user_agent,
        createdAt: r.created_at,
        user: r.user_id
          ? {
              id: r.user_id,
              email: r.u_email,
              firstName: r.u_first_name,
              lastName: r.u_last_name,
            }
          : null,
      })),
    };
  },
};

/**
 * Platform-wide count of `ai_usage` rows since `since` (a single aggregate; no
 * rows leave the database). The global AI caps and the paid answer-engine budget
 * are cross-store questions on a hot path.
 */
export async function countAiUsage(opts: {
  since: Date;
  cachedHit: boolean;
  feature?: string;
}): Promise<number> {
  // Ruling NZ-AN-1: after the `ai-usage` cutover the table is one platform table on D1 (a single indexed count, no RLS to bypass)
  if (await platformFamilyOnD1('ai-usage')) {
    return (await requirePlatformDb()).aiUsage.count({
      where: {
        createdAt: { gte: opts.since },
        cachedHit: opts.cachedHit,
        ...(opts.feature ? { feature: opts.feature } : {}),
      },
    });
  }
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT public.ebda_ai_usage_count(${opts.since}::timestamp, ${opts.cachedHit}, ${opts.feature ?? null}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Store deletion keeps the audit trail by nulling `store_id` on the store's rows.
 * That leaves the store scope (the policy's WITH CHECK would reject it), so it is
 * a definer. Runs on the caller's transaction `db`.
 */
export async function detachStoreAuditLogs(
  storeId: string,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    SELECT public.ebda_audit_logs_detach_store(${storeId}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** Null `user_id` on every audit row of a user about to be deleted (any store). */
export async function unlinkUserAuditLogs(
  userId: string,
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma
): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    SELECT public.ebda_audit_logs_unlink_user(${userId}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** The consent row an SMS opt-out token names (the store is on the row, not the token). */
export async function getSmsConsentById(id: string): Promise<{
  id: string;
  storeId: string;
  phone: string | null;
  granted: boolean;
  store: { name: string; nameAr: string | null };
} | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      store_id: string;
      phone: string | null;
      granted: boolean;
      store_name: string;
      store_name_ar: string | null;
    }>
  >`SELECT * FROM public.ebda_sms_consent_lookup(${id})`;
  const r = rows[0];
  return r
    ? {
        id: r.id,
        storeId: r.store_id,
        phone: r.phone,
        granted: r.granted,
        store: { name: r.store_name, nameAr: r.store_name_ar },
      }
    : null;
}

/** Whether an audit row for (action, resource) exists, in any store or none. */
export async function auditLogExists(
  action: string,
  resourceType: string,
  resourceId: string
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT public.ebda_audit_log_exists(${action}, ${resourceType}, ${resourceId}) AS ok`;
  return rows[0]?.ok === true;
}

/**
 * The retention functions answer only an ACTIVE super_admin or the
 * `audit-log-retention` system job (the cron has no user and no store).
 */
const asRetentionJob = <T>(fn: () => Promise<T>): Promise<T> =>
  withSystemJob('audit-log-retention', fn);

/**
 * Audit-trail retention (the weekly archive cron): count, page out and purge rows
 * older than `cutoff`, across every store and the store-less platform rows. The
 * SQL functions refuse a cutoff newer than 30 days.
 */
export const auditRetention = {
  async count(cutoff: Date): Promise<number> {
    const rows = await asRetentionJob(
      () =>
        prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT public.ebda_audit_log_retention_count(${cutoff}::timestamp) AS n`
    );
    return Number(rows[0]?.n ?? 0);
  },
  /** A page of rows (as the JSON an archive line holds), ascending by id after `afterId`. */
  async page(cutoff: Date, afterId: string | null, limit: number): Promise<Array<{ id: string }>> {
    const rows = await asRetentionJob(
      () =>
        prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM public.ebda_audit_log_retention_page(${cutoff}::timestamp, ${afterId}, ${limit}::int)`
    );
    return rows.map(r => ({
      id: r.id as string,
      action: r.action,
      userId: r.user_id,
      storeId: r.store_id,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      details: r.details,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    }));
  },
  async purge(cutoff: Date, limit: number): Promise<number> {
    const rows = await asRetentionJob(
      () =>
        prisma.$queryRaw<Array<{ n: number }>>`
      SELECT public.ebda_audit_log_retention_purge(${cutoff}::timestamp, ${limit}::int) AS n`
    );
    return Number(rows[0]?.n ?? 0);
  },
};

// ---------------------------------------------------------------------------
// Plans engine (SP5): platform-wide reads for the super-admin Plans page
// ---------------------------------------------------------------------------

/** Stores per plan code, across every store. Super_admin only (the function checks). */
export async function planSubscriberCounts(): Promise<Map<string, number>> {
  if (await onBillingD1()) return planSubscriberCountsD1();
  const rows = await prisma.$queryRaw<
    Array<{ plan_code: string; n: bigint }>
  >`SELECT plan_code, n FROM public.ebda_plan_subscriber_counts()`;
  return new Map(rows.map(r => [r.plan_code, Number(r.n)]));
}

/** The ids of every store subscribed to `planCode`. Super_admin only (the function checks). */
export async function storeIdsOnPlan(planCode: string): Promise<string[]> {
  if (await onBillingD1()) return storeIdsOnPlanD1(planCode);
  const rows = await prisma.$queryRaw<
    Array<{ store_id: string }>
  >`SELECT store_id FROM public.ebda_plan_store_ids(${planCode})`;
  return rows.map(r => r.store_id);
}

/** A subscription-billing webhook's provider reference -> the store that owns the pending refund. */
export async function getBillingRefundStoreId(
  provider: string,
  providerRef: string
): Promise<string | null> {
  if (await onBillingD1()) return refundStoreIdD1(provider, providerRef);
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_billing_refund_store_id(${provider}, ${providerRef}) AS id`;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// VAT gate (ruling TAX-2): the super-admin review queue across every store
// ---------------------------------------------------------------------------

export interface TaxReviewRow {
  storeId: string;
  storeName: string;
  storeSlug: string;
  status: string;
  taxRegistrationNumber: string | null;
  legalName: string | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  documentCount: number;
  /** OTHER stores holding the same TRN in pending/verified — a reviewer signal. */
  duplicateTrnStores: number;
}

/** Tax profiles awaiting / past review. `null` = every non-`none` profile. Super_admin only (the function checks). */
export async function taxProfilesForReview(status: string | null): Promise<TaxReviewRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      store_id: string;
      store_name: string;
      store_slug: string;
      status: string;
      tax_registration_number: string | null;
      legal_name: string | null;
      submitted_at: Date | null;
      reviewed_at: Date | null;
      verified_at: Date | null;
      rejection_reason: string | null;
      document_count: bigint;
      duplicate_trn_stores: bigint;
    }>
  >`SELECT * FROM public.ebda_tax_profiles_for_review(${status})`;
  return rows.map(r => ({
    storeId: r.store_id,
    storeName: r.store_name,
    storeSlug: r.store_slug,
    status: r.status,
    taxRegistrationNumber: r.tax_registration_number,
    legalName: r.legal_name,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    verifiedAt: r.verified_at,
    rejectionReason: r.rejection_reason,
    documentCount: Number(r.document_count),
    duplicateTrnStores: Number(r.duplicate_trn_stores),
  }));
}

// ---------------------------------------------------------------------------
// Pre-scope reads of `stores` (R-EBDA-005, migration 20261008000010_tenant_defence_expand).
// `stores` is under RLS, so a lookup that runs BEFORE a store or user scope exists goes
// through one of these; the full row is then read inside `withStore(id)`.
// ---------------------------------------------------------------------------

export type StoreStatusName = 'active' | 'inactive' | 'suspended';

/**
 * One store by id, slug or VERIFIED custom domain (precedence in that order), among
 * `statuses`, not soft-deleted. Returns `{ id, status }` or null. Never defaults to
 * another store.
 */
export async function lookupStore(
  match: { id?: string | null; slug?: string | null; domain?: string | null },
  statuses: readonly StoreStatusName[] = ['active']
): Promise<{ id: string; status: string } | null> {
  if (!match.id && !match.slug && !match.domain) return null;
  // NEON-ZERO-1: a deployed Worker resolves from D1 only; an unknown store is null (404), never a Postgres fallback.
  const d1 = platformDb();
  if (d1) return d1LookupStore(d1, match, statuses);
  const rows = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status FROM public.ebda_store_lookup(
      ${match.id ?? null}, ${match.slug ?? null}, ${match.domain ?? null}, ${[...statuses]}::text[])`;
  return rows[0] ?? null;
}

/** The id of the store holding `slug` (any status, deleted included: the unique index does). */
export async function storeIdBySlug(slug: string): Promise<string | null> {
  const d1 = platformDb();
  if (d1) return d1StoreIdBySlug(d1, slug);
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_store_id_by_slug(${slug}) AS id`;
  return rows[0]?.id ?? null;
}

/** The id of the store whose VERIFIED domain is `domain` (any status). */
export async function storeIdByDomain(domain: string): Promise<string | null> {
  const d1 = platformDb();
  if (d1) return d1StoreIdByDomain(d1, domain);
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_store_id_by_domain(${domain}) AS id`;
  return rows[0]?.id ?? null;
}

/** The ids of every store with a PENDING claim on `domain`. */
export async function storeIdsClaimingDomain(domain: string): Promise<string[]> {
  const d1 = platformDb();
  if (d1) return d1StoreIdsClaimingDomain(d1, domain);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT ebda_store_ids_claiming_domain AS id FROM public.ebda_store_ids_claiming_domain(${domain})`;
  return rows.map(r => r.id);
}

/**
 * The live stores `ownerId` owns. Guarded in SQL: the acting user (app.current_user_id)
 * must BE `ownerId`, or an active super_admin; wrap the call in `withUser(ownerId, ...)`.
 */
export async function ownedStoreIds(ownerId: string): Promise<string[]> {
  // NEON-ZERO-1 (N-6): D1 `stores` answers once the `access` family is on D1 (same predicate as the SQL function below).
  if (await onAccessD1()) return ownedStoreIdsD1(ownerId);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT ebda_owned_store_ids AS id FROM public.ebda_owned_store_ids(${ownerId})`;
  return rows.map(r => r.id);
}

/**
 * OneSignal player ids of a store's owner (`'store_admin'`, only for the store the
 * transaction is scoped to: wrap in `withStore(storeId, ...)`) or of every active
 * super_admin (`'super_admin'`). Device ids only.
 */
export async function adminPushPlayerIds(
  role: 'store_admin' | 'super_admin',
  storeId: string | null
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT ebda_admin_push_player_ids AS id FROM public.ebda_admin_push_player_ids(${role}, ${storeId})`;
  return rows.map(r => r.id).filter(Boolean);
}

/**
 * One page of the PUBLIC store list (active, not deleted, newest first): ids and the total.
 * The caller reads each store's public fields inside `withStore(id, ...)`.
 */
export async function publicStorePage(
  skip: number,
  take: number
): Promise<{ ids: string[]; total: number }> {
  const d1 = platformDb();
  if (d1) return d1PublicStorePage(d1, skip, take);
  const rows = await prisma.$queryRaw<Array<{ id: string | null; total: bigint }>>`
    SELECT id, total FROM public.ebda_public_store_page(${skip}::int, ${take}::int)`;
  // An empty page still returns one row carrying the total, with id NULL.
  return {
    ids: rows.flatMap(r => (r.id ? [r.id] : [])),
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

// ---------------------------------------------------------------------------
// User-keyed token tables (R-EBDA-005): pre-identity lookups and the retention purge.
// ---------------------------------------------------------------------------

/** The user a stored refresh / reset token (its stored form, e.g. sha256 or `reset:<sha256>`) belongs to. */
export async function refreshTokenUser(storedToken: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_refresh_token_user(${storedToken}) AS id`;
  return rows[0]?.id ?? null;
}

/** The user a stored verification token (its sha256) belongs to. */
export async function verificationTokenUser(storedToken: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_verification_token_user(${storedToken}) AS id`;
  return rows[0]?.id ?? null;
}

/** A stored passkey as the discoverable sign-in needs it BEFORE any user is known (public material only). */
export interface PasskeyLookupRow {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  rpId: string;
}

/**
 * The passkey a presented credential id belongs to (migration 20261029000100, Ruling PASSKEY-1).
 * Unguarded on purpose, like `refreshTokenUser`: sign-in knows only the credential id, and the caller
 * still has to produce a valid signature over a server-issued challenge.
 */
export async function passkeyLookup(credentialId: string): Promise<PasskeyLookupRow | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      user_id: string;
      public_key: string;
      counter: bigint;
      transports: string[] | null;
      rp_id: string;
    }>
  >`SELECT * FROM public.ebda_passkey_lookup(${credentialId})`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    publicKey: r.public_key,
    counter: Number(r.counter),
    transports: r.transports ?? [],
    rpId: r.rp_id,
  };
}

/** Delete every passkey of a user inside the CURRENT transaction (erasure). Guarded in SQL like `deleteUserTokens`. */
export async function deleteUserPasskeys(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT public.ebda_passkeys_delete(${userId}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** Delete refresh tokens that expired before `now` or were revoked before `revokedBefore`. */
export async function purgeRefreshTokens(now: Date, revokedBefore: Date): Promise<number> {
  return withSystemJob('token-retention', async () => {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT public.ebda_refresh_tokens_purge(${now}::timestamp, ${revokedBefore}::timestamp) AS n`;
    return Number(rows[0]?.n ?? 0);
  });
}

/**
 * Delete a user's refresh/reset tokens, verification tokens and OneSignal registrations
 * inside the CURRENT transaction (erasure, store-owner deletion). Guarded in SQL like
 * `deleteUserAddresses`: the user, a super_admin, or the merchant of the user's store.
 */
export async function deleteUserTokens(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT public.ebda_user_tokens_delete(${userId}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Tax archive (ruling MONEYB-4, migration 20261008120000). Super_admin only (the
// functions check): the immutable fiscal documents of a store, including one
// that has been deleted (no store scope can be opened for it any more).
// ---------------------------------------------------------------------------

export interface FiscalArchiveStoreRow {
  storeId: string;
  storeName: string | null;
  documentCount: number;
  lastIssuedAt: Date | null;
  storeExists: boolean;
}

export async function fiscalArchiveStores(): Promise<FiscalArchiveStoreRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      store_id: string;
      store_name: string | null;
      document_count: bigint;
      last_issued_at: Date | null;
      store_exists: boolean;
    }>
  >`SELECT * FROM public.ebda_fiscal_archive_stores()`;
  return rows.map(r => ({
    storeId: r.store_id,
    storeName: r.store_name,
    documentCount: Number(r.document_count),
    lastIssuedAt: r.last_issued_at,
    storeExists: r.store_exists,
  }));
}

export interface FiscalArchiveRow {
  id: string;
  storeId: string;
  orderId: string | null;
  docType: string;
  number: string | null;
  status: string;
  issuedAt: Date;
  cancelledAt: Date | null;
  originalNumber: string | null;
  currency: string;
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  vatRateBps: number | null;
  sellerTrn: string | null;
  payload: unknown;
  retainUntil: Date;
}

export async function fiscalArchive(storeId: string): Promise<FiscalArchiveRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      store_id: string;
      order_id: string | null;
      doc_type: string;
      number: string | null;
      status: string;
      issued_at: Date;
      cancelled_at: Date | null;
      original_number: string | null;
      currency: string;
      net_amount: number;
      vat_amount: number;
      total_amount: number;
      vat_rate_bps: number | null;
      seller_trn: string | null;
      payload: unknown;
      retain_until: Date;
    }>
  >`SELECT * FROM public.ebda_fiscal_archive(${storeId})`;
  return rows.map(r => ({
    id: r.id,
    storeId: r.store_id,
    orderId: r.order_id,
    docType: r.doc_type,
    number: r.number,
    status: r.status,
    issuedAt: r.issued_at,
    cancelledAt: r.cancelled_at,
    originalNumber: r.original_number,
    currency: r.currency,
    netAmount: r.net_amount,
    vatAmount: r.vat_amount,
    totalAmount: r.total_amount,
    vatRateBps: r.vat_rate_bps,
    sellerTrn: r.seller_trn,
    payload: r.payload,
    retainUntil: r.retain_until,
  }));
}

/**
 * Compensate a failed enqueue: delete the caller's own, just-created, still-unacted-on
 * `legal_notice_sends` row (see the migration for the exact guard). Must run as the acting
 * super admin (asPlatformOperator). Returns rows deleted: 1 = withdrawn, 0 = refused (the
 * send may already have started).
 */
export async function withdrawLegalNoticeSend(
  sendId: string,
  operatorId?: string
): Promise<number> {
  if (await onBillingD1('platform')) {
    if (!operatorId) throw new Error('withdrawLegalNoticeSend: operatorId is required on D1');
    return withdrawLegalSendD1(sendId, operatorId, new Date());
  }
  await assertFamilyWritableOnPostgres('platform');
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT public.ebda_withdraw_legal_notice_send(${sendId}) AS n`;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Gold-rate pricing crons (Phase B5 Task 11): cron-facing, UNGUARDED ON PURPOSE (no principal)
// ---------------------------------------------------------------------------

/** Stores that turned the automatic gold rate on, with their premium (bps). Empty on almost every tick. */
export async function goldFeedStores(): Promise<Array<{ storeId: string; premiumBps: number }>> {
  const rows = await prisma.$queryRaw<
    Array<{ store_id: string; feed_premium_bps: number }>
  >`SELECT store_id, feed_premium_bps FROM public.ebda_gold_feed_stores()`;
  return rows.map(r => ({ storeId: r.store_id, premiumBps: r.feed_premium_bps }));
}

/** (store, karat) pairs whose applied gold rate is inside the stale-warning window or past the max age. */
export async function goldRateWatch(): Promise<
  Array<{ storeId: string; karat: number; rateId: string; appliedAt: Date; maxAgeMinutes: number }>
> {
  const rows = await prisma.$queryRaw<
    Array<{
      store_id: string;
      karat: number;
      rate_id: string;
      applied_at: Date;
      max_age_minutes: number;
    }>
  >`SELECT store_id, karat, rate_id, applied_at, max_age_minutes FROM public.ebda_gold_rate_watch()`;
  return rows.map(r => ({
    storeId: r.store_id,
    karat: r.karat,
    rateId: r.rate_id,
    appliedAt: r.applied_at,
    maxAgeMinutes: r.max_age_minutes,
  }));
}
