import { randomUUID } from 'node:crypto';
import { prisma, withSystemJob, type Prisma } from '@force/database';

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
}): Promise<string | null> {
  if (!ref.transactionId && !ref.invoiceId) return null;
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_webhook_resolve_store(${ref.transactionId ?? null}, ${ref.invoiceId ?? null}) AS id`;
  return rows[0]?.id ?? null;
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

/** An order id -> its store id. */
export async function getOrderStoreId(orderId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_order_store_id(${orderId}) AS id`;
  return rows[0]?.id ?? null;
}

/** A payment id -> its store id (exact primary key). The caller then reads and authorises inside that store. */
export async function getPaymentStoreId(paymentId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_payment_store_id(${paymentId}) AS id`;
  return rows[0]?.id ?? null;
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
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT public.ebda_webhook_inbox_record(
        ${randomUUID()}, ${input.provider}, ${input.idempotencyKey}, ${input.storeId ?? null},
        ${JSON.stringify(input.payload)}::jsonb, ${input.rawBody}, ${input.signature}
      ) AS id`;
    return rows[0].id;
  },

  async get(id: string): Promise<WebhookInboxRow | null> {
    const rows = await asWebhookInbox(
      () => prisma.$queryRaw<InboxDbRow[]>`SELECT * FROM public.ebda_webhook_inbox_get(${id})`
    );
    return rows[0] ? toInboxRow(rows[0]) : null;
  },

  async update(id: string, patch: WebhookInboxPatch): Promise<boolean> {
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
  const rows = await prisma.$queryRaw<Array<{ tv: number | null }>>`
    SELECT public.ebda_user_revoke_sessions(${userId}) AS tv`;
  const tv = rows[0]?.tv;
  if (tv === null || tv === undefined) {
    throw Object.assign(new Error(`User ${userId} not found`), { code: 'P2025' });
  }
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
  const rows = await prisma.$queryRaw<
    Array<{ plan_code: string; n: bigint }>
  >`SELECT plan_code, n FROM public.ebda_plan_subscriber_counts()`;
  return new Map(rows.map(r => [r.plan_code, Number(r.n)]));
}

/** The ids of every store subscribed to `planCode`. Super_admin only (the function checks). */
export async function storeIdsOnPlan(planCode: string): Promise<string[]> {
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
  const rows = await prisma.$queryRaw<Array<{ id: string | null }>>`
    SELECT public.ebda_billing_refund_store_id(${provider}, ${providerRef}) AS id`;
  return rows[0]?.id ?? null;
}
