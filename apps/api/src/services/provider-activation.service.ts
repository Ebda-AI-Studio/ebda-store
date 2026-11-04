/**
 * Provider activation on request (ruling PROVIDERS-ACTIVATION).
 *
 * A merchant saves their OWN credentials for a payment gateway / shipping carrier the catalog does
 * not list as verified, runs Test connection, and asks Ebda to activate it. Ebda re-runs the test
 * with the stored credentials, fixes whatever is wrong, and activates the provider for THAT store.
 * `status = 'activated'` is the per-store override every enable gate accepts (catalog-verified OR
 * store-activated, see `provider-gate.ts`); only the super-admin functions below write it.
 *
 * The credentials never leave the server: every result here is a status, a code and a time.
 */
import {
  acrossStoresFlat,
  prisma,
  Prisma,
  runInStoreScope,
  storeDirectory,
  withStore,
} from '@ebda/database';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { asOperator, platformHubOnD1 } from '../lib/platform-scope';
import { listDirectoryStores } from './platform/directory-d1';
import { gateRead } from './platform/access-d1';
import { getAccountsBrief } from '../lib/identity-client';
import { BRAND, getProviderEntry, isActivationRequestable, ACTIVATION_HOURS } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { emailQueue } from './email-queue.service';
import { PaymentService } from './payment.service';
import { shippingCarrierService } from './shipping-carrier.service';
import {
  carrierTestIsCurrent,
  carrierTestLooksCurrent,
  type ConnectableCarrierRow,
} from './carriers/carrier-connection.service';
import {
  connectionTestIsCurrent,
  connectionTestLooksCurrent,
  runConnectionTest,
  type ConnectableRow,
} from './payment-providers/provider-connection.service';

export const ACTIVATION_STATUSES = ['requested', 'activated', 'rejected'] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export interface ActivationActor {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** What a merchant sees of their own request. */
export interface PublicActivationRequest {
  id: string;
  provider: string;
  status: ActivationStatus;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface LastTest {
  ok: boolean;
  code: string;
  mode: string;
  at: string;
  /** The test covers exactly the credentials stored now (an edit since then makes it stale). */
  current: boolean;
}

export interface AdminActivationRequest extends PublicActivationRequest {
  storeId: string;
  storeName: string;
  storeSlug: string;
  kind: 'payments' | 'shipping';
  lastTest: LastTest | null;
}

type RequestRow = Prisma.ProviderActivationRequestGetPayload<object>;

function toPublic(r: RequestRow): PublicActivationRequest {
  return {
    id: r.id,
    provider: r.provider,
    status: r.status as ActivationStatus,
    note: r.note,
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A catalog provider that can be activated on request, or the error the route returns. */
function requestableEntry(provider: string) {
  const entry = getProviderEntry(provider);
  if (!entry) throw new AppError(404, 'UNKNOWN_PROVIDER', `Unknown provider "${provider}"`);
  if (entry.manual) {
    throw new AppError(422, 'NO_CREDENTIALS', `${provider} needs no activation`);
  }
  if (!isActivationRequestable(entry)) {
    throw new AppError(409, 'ALREADY_AVAILABLE', `${provider} is already available to every store`);
  }
  return entry;
}

/** The stored connection row (credentials ciphertext included) of a store's provider, or null. */
async function loadConnection(storeId: string, provider: string, kind: 'payments' | 'shipping') {
  // the store's own backend (NEON-ZERO, Ruling NZ-C-8): its Durable Object for a DO store, `prisma` otherwise
  const db = await storeDb(storeId);
  if (kind === 'payments') {
    const row = await db.paymentConfig.findFirst({ where: { provider, storeId } });
    if (!row) return null;
    return { kind, row, test: row.connectionTest };
  }
  const row = await db.shippingCarrierConfig.findUnique({
    where: { storeId_carrier: { storeId, carrier: provider } },
  });
  if (!row) return null;
  return { kind, row, test: row.connectionTest };
}

function lastTestOf(
  conn: NonNullable<Awaited<ReturnType<typeof loadConnection>>>
): LastTest | null {
  const t = conn.test;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const s = t as { ok?: boolean; code?: string; mode?: string; at?: string };
  if (typeof s.ok !== 'boolean' || !s.at) return null;
  const current =
    conn.kind === 'payments'
      ? connectionTestLooksCurrent(conn.row as unknown as ConnectableRow)
      : carrierTestLooksCurrent(conn.row as unknown as ConnectableCarrierRow);
  return {
    ok: s.ok,
    code: String(s.code ?? 'unknown'),
    mode: String(s.mode ?? ''),
    at: s.at,
    current,
  };
}

// ---------------------------------------------------------------------------
// Merchant side
// ---------------------------------------------------------------------------

/** This store's requests, newest first, one (the latest) per provider. */
export async function listStoreRequests(storeId: string): Promise<PublicActivationRequest[]> {
  const rows = await prisma.providerActivationRequest.findMany({
    where: { storeId },
    orderBy: { requestedAt: 'desc' },
  });
  const seen = new Set<string>();
  const latest: PublicActivationRequest[] = [];
  for (const r of rows) {
    if (seen.has(r.provider)) continue;
    seen.add(r.provider);
    latest.push(toPublic(r));
  }
  return latest;
}

/**
 * Record the request (idempotent while one is open). Runs inside the caller's tenant scope. The
 * notifications are sent by `notifyOpsOfRequest` AFTER the caller's transaction committed.
 */
export async function requestActivation(
  storeId: string,
  provider: string,
  actor: ActivationActor
): Promise<{ request: PublicActivationRequest; created: boolean }> {
  const entry = requestableEntry(provider);
  const conn = await loadConnection(storeId, provider, entry.kind);
  if (!conn || !(conn.row as { credentials?: string | null }).credentials) {
    throw new AppError(
      422,
      'CREDENTIALS_REQUIRED',
      'Save your credentials for this provider before requesting activation'
    );
  }
  const open = await prisma.providerActivationRequest.findFirst({
    where: { storeId, provider, status: { in: ['requested', 'activated'] } },
  });
  if (open) {
    if (open.status === 'activated') {
      throw new AppError(
        409,
        'ALREADY_ACTIVATED',
        `${provider} is already activated for this store`
      );
    }
    return { request: toPublic(open), created: false };
  }
  const row = await prisma.providerActivationRequest.create({
    data: { storeId, provider, status: 'requested', requestedById: actor.userId },
  });
  await auditLog({
    action: 'provider_activation.requested',
    storeId,
    userId: actor.userId,
    resourceType: 'provider_activation_request',
    resourceId: row.id,
    details: { storeId, provider, kind: entry.kind },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { request: toPublic(row), created: true };
}

/**
 * Tell Ebda a request arrived: email to the support address through the existing email queue,
 * plus the Telegram ops alert. Best effort by design: the request row is the record (it shows in
 * the super-admin list), so a failed notification is logged and alerted, never a failed request.
 */
export async function notifyOpsOfRequest(args: {
  storeId: string;
  storeName: string;
  provider: string;
  requestedAt: string;
  requesterEmail?: string;
}): Promise<{ emailQueued: boolean }> {
  const { storeId, storeName, provider, requestedAt, requesterEmail } = args;
  const entry = getProviderEntry(provider);
  const label = entry?.name.en ?? provider;
  const subject = `Activation request: ${label} for ${storeName}`;
  const lines = [
    `Store: ${storeName} (${storeId})`,
    `Provider: ${label} (${provider}, ${entry?.kind ?? 'unknown'})`,
    `Requested at: ${requestedAt}`,
    requesterEmail ? `Requested by: ${requesterEmail}` : '',
    `Promised: about ${ACTIVATION_HOURS} hours. Open Activation requests in the super-admin area, run the test, fix, activate.`,
  ].filter(Boolean);
  let emailQueued = false;
  try {
    await emailQueue.enqueue(null, {
      to: BRAND.supportEmail,
      subject,
      text: lines.join('\n'),
      html: `<p>${lines.map(l => escapeHtml(l)).join('<br>')}</p>`,
      ...(requesterEmail ? { replyTo: requesterEmail } : {}),
    });
    emailQueued = true;
  } catch (err) {
    logger.error({ err, storeId, provider }, '[ACTIVATION] could not queue the ops email');
  }
  void sendAlert({
    level: 'p1',
    scope: 'store',
    store: { id: storeId, name: storeName },
    source: 'provider-activation.requested',
    title: `Activation request: ${label}`,
    body: lines.join('\n'),
  }).catch(() => undefined);
  return { emailQueued };
}

// ---------------------------------------------------------------------------
// Super-admin side
// ---------------------------------------------------------------------------

/** Every store's requests (newest first), each with the store's last Test connection result. */
export async function listAllRequests(
  status?: ActivationStatus
): Promise<AdminActivationRequest[]> {
  const onD1 = await platformHubOnD1();
  const directory = onD1 ? await listDirectoryStores() : await storeDirectory();
  const stores = new Map(directory.map(s => [s.id, s]));
  const forStore = async (storeId: string) => {
    const found = await prisma.providerActivationRequest.findMany({
      where: { storeId, ...(status ? { status } : {}) },
    });
    const out: AdminActivationRequest[] = [];
    for (const r of found) {
      const entry = getProviderEntry(r.provider);
      if (!entry) continue;
      const conn = await loadConnection(storeId, r.provider, entry.kind);
      out.push({
        ...toPublic(r),
        storeId,
        storeName: stores.get(storeId)?.name ?? storeId,
        storeSlug: stores.get(storeId)?.slug ?? '',
        kind: entry.kind,
        lastTest: conn ? lastTestOf(conn) : null,
      });
    }
    return out;
  };
  // With the hub on D1 the requests are D1 rows and each store's connection is read from its own backend: no cross-store
  // Postgres transaction (the explicit id list also keeps `acrossStores` off the Postgres directory definer).
  let rows: AdminActivationRequest[] = [];
  if (onD1) {
    for (let i = 0; i < directory.length; i += 8) {
      const batch = directory.slice(i, i + 8);
      rows = rows.concat(
        (await Promise.all(batch.map(s => withStore(s.id, () => forStore(s.id))))).flat()
      );
    }
  } else rows = await acrossStoresFlat(forStore);
  return rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

function clearProviderCaches(storeId: string): void {
  PaymentService.clearCache(storeId);
  void shippingCarrierService.invalidateCarrierConfigCache(storeId).catch(() => undefined);
}

/** Re-run Test connection with the store's stored credentials. Returns status only, never keys. */
export async function runTestForStore(
  storeId: string,
  provider: string,
  actor: ActivationActor
): Promise<LastTest> {
  const entry = getProviderEntry(provider);
  if (!entry || entry.manual)
    throw new AppError(404, 'UNKNOWN_PROVIDER', `Unknown provider "${provider}"`);
  if (entry.kind === 'payments') {
    // the store's own backend (its Durable Object or Postgres): the result is recorded where the config row lives
    const row = await (
      await storeDb(storeId)
    ).paymentConfig.findFirst({ where: { provider, storeId } });
    if (!row)
      throw new AppError(404, 'NOT_FOUND', 'The store has not saved credentials for this provider');
    // The gateway call holds no transaction: read, call, then a short write.
    const { result, stored } = await runConnectionTest(row);
    await (
      await storeWriter(storeId)
    ).paymentConfig.update({
      where: { id: row.id, storeId },
      data: {
        connectionTest: stored as unknown as Prisma.InputJsonValue,
        healthStatus: result.ok ? 'healthy' : result.code === 'unreachable' ? 'degraded' : 'down',
        lastHealthCheck: new Date(stored.at),
        updatedBy: actor.userId,
      },
    });
    clearProviderCaches(storeId);
  } else {
    await runInStoreScope(storeId, () =>
      shippingCarrierService.testConnection(storeId, provider as never)
    );
  }
  await auditLog({
    action: 'provider_activation.test_run',
    storeId,
    userId: actor.userId,
    resourceType: 'provider_activation_request',
    resourceId: provider,
    details: { storeId, provider },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  const conn = await withStore(storeId, () => loadConnection(storeId, provider, entry.kind));
  const last = conn ? lastTestOf(conn) : null;
  if (!last) throw new AppError(500, 'TEST_NOT_RECORDED', 'The connection test left no result');
  return last;
}

/** The store's open request for a provider, or a 404/409 the route can return. */
async function openRequest(storeId: string, provider: string): Promise<RequestRow> {
  const row = await prisma.providerActivationRequest.findFirst({
    where: { storeId, provider, status: { in: ['requested', 'activated'] } },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'No open activation request for this provider');
  return row;
}

/**
 * Activate for this store: allowed only when the store's LATEST test passed for exactly the
 * credentials stored now. The check and the write share one transaction.
 */
export async function activateForStore(
  storeId: string,
  provider: string,
  actor: ActivationActor
): Promise<PublicActivationRequest> {
  const entry = requestableEntry(provider);
  const updated = await withStore(storeId, async () => {
    const req = await openRequest(storeId, provider);
    if (req.status === 'activated') return req;
    const conn = await loadConnection(storeId, provider, entry.kind);
    const passed =
      conn !== null &&
      (conn.kind === 'payments'
        ? connectionTestIsCurrent(conn.row as unknown as ConnectableRow)
        : carrierTestIsCurrent(conn.row as unknown as ConnectableCarrierRow));
    if (!passed) {
      throw new AppError(
        409,
        'CONNECTION_NOT_TESTED',
        'Run the test: the latest Test connection must pass with the credentials stored now'
      );
    }
    return prisma.providerActivationRequest.update({
      where: { id: req.id, storeId },
      data: { status: 'activated', decidedById: actor.userId, decidedAt: new Date(), note: null },
    });
  });
  clearProviderCaches(storeId);
  await auditLog({
    action: 'provider_activation.activated',
    storeId,
    userId: actor.userId,
    resourceType: 'provider_activation_request',
    resourceId: updated.id,
    details: { storeId, provider },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await notifyMerchant(storeId, provider, 'activated', undefined, actor);
  return toPublic(updated);
}

/** Reject with a note the merchant is shown; the provider stays disabled. */
export async function rejectForStore(
  storeId: string,
  provider: string,
  note: string,
  actor: ActivationActor
): Promise<PublicActivationRequest> {
  requestableEntry(provider);
  const updated = await withStore(storeId, async () => {
    const req = await openRequest(storeId, provider);
    if (req.status !== 'requested') {
      throw new AppError(409, 'ALREADY_DECIDED', 'This request is already activated');
    }
    return prisma.providerActivationRequest.update({
      where: { id: req.id, storeId },
      data: { status: 'rejected', note, decidedById: actor.userId, decidedAt: new Date() },
    });
  });
  clearProviderCaches(storeId);
  await auditLog({
    action: 'provider_activation.rejected',
    storeId,
    userId: actor.userId,
    resourceType: 'provider_activation_request',
    resourceId: updated.id,
    details: { storeId, provider, note },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await notifyMerchant(storeId, provider, 'rejected', note, actor);
  return toPublic(updated);
}

/** Email the store owner the decision (platform sender, bilingual). Best effort, never throws. */
async function notifyMerchant(
  storeId: string,
  provider: string,
  decision: 'activated' | 'rejected',
  note: string | undefined,
  actor: ActivationActor
): Promise<void> {
  try {
    const store = await asOperator(actor.userId, async () => {
      if (await platformHubOnD1()) {
        // directory facts from D1, the owner's address from the identity service
        const g = await gateRead(storeId, null);
        if (!g) return null;
        const [owner] = await getAccountsBrief([g.store.ownerId]);
        return { name: g.store.name, owner: owner ? { email: owner.email } : null };
      }
      return prisma.store.findUnique({
        where: { id: storeId },
        select: { name: true, owner: { select: { email: true } } },
      });
    });
    const to = store?.owner?.email;
    if (!to) return;
    const label = getProviderEntry(provider)?.name;
    const en = label?.en ?? provider;
    const ar = label?.ar ?? provider;
    const subject =
      decision === 'activated'
        ? `${en} is active on your store / ${ar} اتفعّلت على متجرك`
        : `About your ${en} request / بخصوص طلب تفعيل ${ar}`;
    const bodyEn =
      decision === 'activated'
        ? `${en} is now active for ${store?.name}. You can switch it on from your payment / shipping settings.`
        : `We could not activate ${en} yet. ${note ?? ''}`;
    const bodyAr =
      decision === 'activated'
        ? `${ar} اتفعّلت على ${store?.name}. تقدر تشغّلها من إعدادات الدفع / الشحن.`
        : `لسه مقدرناش نفعّل ${ar}. ${note ?? ''}`;
    await emailQueue.enqueue(null, {
      to,
      subject,
      text: `${bodyAr}\n\n${bodyEn}`,
      html: `<p dir="rtl">${escapeHtml(bodyAr)}</p><p>${escapeHtml(bodyEn)}</p>`,
    });
  } catch (err) {
    logger.error({ err, storeId, provider, decision }, '[ACTIVATION] could not email the merchant');
  }
}
