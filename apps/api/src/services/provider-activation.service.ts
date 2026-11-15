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
 *
 * SELF-SERVICE (gap A7, task 12): since PROVIDERS-3 nothing REQUIRES a super admin any more (the enable gate is a
 * passing test of the stored credentials). The merchant's own "Test and turn on" is the activation:
 * `previewSelfActivation` runs the check on the SERVER (the result can never come from a request body), and only a
 * pass mints a single-use confirm token bound to a hash of {provider, mode, that exact test run};
 * `confirmSelfActivation` verifies + consumes it, re-checks the gate, enables the provider for checkout, appends a
 * ledger row and pages ops (P1). The super admin keeps `activate` (the dormant request queue) and `deactivate`.
 */
import { isDemoStore } from '../lib/demo-store';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { onD1 } from './platform/billing-d1';
import {
  acrossStoresFlat,
  prisma,
  Prisma,
  runInStoreScope,
  storeDirectory,
  withStore,
} from '@ebda/database';
import { storeRepo } from '../lib/repo-factory';
import { asOperator, platformHubOnD1 } from '../lib/platform-scope';
import { listDirectoryStores } from './platform/directory-d1';
import { gateRead } from './platform/access-d1';
import { getAccountsBrief } from '../lib/identity-client';
import {
  BRAND,
  getProviderEntry,
  isActivationRequestable,
  describeConnectionCheck,
  type ConnectionCheckView,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { AIService } from './ai.service';
import { isProviderVerified, reportConnectionCheck } from './provider-verification.service';
import {
  consumeConfirmToken,
  hashConfirmArgs,
  signConfirmToken,
  verifyConfirmToken,
  CONFIRM_TOKEN_TTL_MS,
} from '../mcp/merchant-confirm-token';
import { withIdempotencyKey } from '../lib/money-idempotency';
import { withClaimLock } from '../lib/claim-lock';
import { emailQueue } from './email-queue.service';
import { PaymentService } from './payment.service';
import { shippingCarrierService } from './shipping-carrier.service';
import {
  assertCarrierEnableAllowed,
  carrierTestIsCurrent,
  carrierTestLooksCurrent,
  type ConnectableCarrierRow,
} from './carriers/carrier-connection.service';
import {
  assertEnableAllowed,
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

// One site per operation on the request table (the prisma-sites ratchet, tests/unit/no-prisma-in-routes.test.ts).
/** The store's live (requested | activated) request for a provider, or null. */
function findOpenRequest(storeId: string, provider: string): Promise<RequestRow | null> {
  return prisma.providerActivationRequest.findFirst({
    where: { storeId, provider, status: { in: ['requested', 'activated'] } },
  });
}
function createRequest(
  storeId: string,
  data: Omit<Prisma.ProviderActivationRequestUncheckedCreateInput, 'storeId'>
): Promise<RequestRow> {
  return prisma.providerActivationRequest.create({ data: { storeId, ...data } });
}
function decideRequest(
  id: string,
  storeId: string,
  data: Prisma.ProviderActivationRequestUncheckedUpdateInput
): Promise<RequestRow> {
  return prisma.providerActivationRequest.update({ where: { id, storeId }, data });
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
    const row = await (
      await storeDb(storeId)
    ).paymentConfig.findFirst({ where: { provider, storeId } });
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
  const open = await findOpenRequest(storeId, provider);
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
  const row = await createRequest(storeId, {
    provider,
    status: 'requested',
    requestedById: actor.userId,
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
    'Merchants can turn a provider on themselves once their own test passes; this request is optional. Open Activation requests in the super-admin area to run the test or activate.',
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
  } else rows = await acrossStoresFlat(forStore, { abortOnError: true });
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
    const row = await (
      await storeDb(storeId)
    ).paymentConfig.findFirst({ where: { provider, storeId } });
    if (!row)
      throw new AppError(404, 'NOT_FOUND', 'The store has not saved credentials for this provider');
    // The gateway call holds no transaction: read, call, then a short write.
    const { result, stored } = await runConnectionTest(row);
    await withStore(storeId, async () =>
      (await storeWriter(storeId)).paymentConfig.update({
        where: { id: row.id, storeId },
        data: {
          connectionTest: stored as unknown as Prisma.InputJsonValue,
          healthStatus: result.ok ? 'healthy' : result.code === 'unreachable' ? 'degraded' : 'down',
          lastHealthCheck: new Date(stored.at),
          updatedBy: actor.userId,
        },
      })
    );
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
  const row = await findOpenRequest(storeId, provider);
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
  let testedMode = 'sandbox';
  const updated = await withStore(storeId, async () => {
    const req = await openRequest(storeId, provider);
    if (req.status === 'activated') return req;
    const conn = await loadConnection(storeId, provider, entry.kind);
    if (conn) testedMode = lastTestOf(conn)?.mode ?? testedMode;
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
    return decideRequest(req.id, storeId, {
      status: 'activated',
      decidedById: actor.userId,
      decidedAt: new Date(),
      note: null,
    });
  });
  clearProviderCaches(storeId);
  // Super-admin OVERRIDE (kept on purpose: goodwill / a merchant who cannot self-serve). Still needs the store's own
  // passing test (no force past the money gate), and now leaves the same ledger row as a self-activation.
  await appendActivationLedger({
    storeId,
    provider,
    action: 'activated_admin',
    mode: testedMode,
    ref: updated.id,
  }).catch(err => logger.error({ err, storeId, provider }, '[ACTIVATION] ledger row not written'));
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

// ---------------------------------------------------------------------------
// Self-service activation (A7)
// ---------------------------------------------------------------------------

/** The activation ledger lives in `provider_verification_events` (append-only for these ops: migration 20261114000100). */
const ACTIVATION_LEDGER_PREFIX = 'activation.';
type ActivationLedgerAction = 'activated_self' | 'activated_admin' | 'deactivated' | 'unblocked';
const ACTIVATE_TOOL = 'provider.activate';
/** The confirm token is bound to the signed-in merchant session, not to an API key (the MCP binds a key id here). */
const CONFIRM_KEY_ID = 'merchant-session';

/** A catalog provider a merchant may connect and turn on (any non-manual one, verified or not: PROVIDERS-3). */
function activatableEntry(provider: string) {
  const entry = getProviderEntry(provider);
  if (!entry) throw new AppError(404, 'UNKNOWN_PROVIDER', `Unknown provider "${provider}"`);
  if (entry.manual) throw new AppError(422, 'NO_CREDENTIALS', `${provider} needs no activation`);
  return entry;
}

function rowEnabled(conn: NonNullable<Awaited<ReturnType<typeof loadConnection>>>): boolean {
  return conn.kind === 'payments'
    ? Boolean((conn.row as { isEnabled?: boolean }).isEnabled)
    : Boolean((conn.row as { enabled?: boolean }).enabled);
}

/** Append one row to the activation ledger. Throws: the caller decides whether the action may stand without it. */
async function appendActivationLedger(e: {
  storeId: string;
  provider: string;
  action: ActivationLedgerAction;
  mode: string;
  ref: string | null;
}): Promise<void> {
  await prisma.providerVerificationEvent.create({
    data: {
      provider: e.provider,
      sourceStoreId: e.storeId,
      op: `${ACTIVATION_LEDGER_PREFIX}${e.action}`,
      ok: true,
      mode: e.mode === 'live' ? 'live' : 'sandbox',
      counted: false,
      ref: e.ref,
    },
  });
}

/** Newest-first activation ledger rows (one read site: the prisma-sites ratchet). */
function readLedger(where: Prisma.ProviderVerificationEventWhereInput, take: number) {
  return prisma.providerVerificationEvent.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: { op: true },
  });
}

/**
 * "Blocked by admin": a super-admin deactivate sticks. The flag IS the newest ledger row of this store + provider
 * (`activation.deactivated` until a later activated_admin / unblocked row), so it needs no schema change and cannot
 * be edited (the ledger is append-only on Postgres and D1).
 */
async function assertNotBlocked(storeId: string, provider: string): Promise<void> {
  const [last] = await readLedger(
    {
      provider,
      sourceStoreId: storeId,
      op: {
        in: ['activated_self', 'activated_admin', 'deactivated', 'unblocked'].map(
          a => `${ACTIVATION_LEDGER_PREFIX}${a}`
        ),
      },
    },
    1
  );
  if (last?.op === `${ACTIVATION_LEDGER_PREFIX}deactivated`) {
    throw new AppError(
      409,
      'PROVIDER_BLOCKED',
      `${provider} was turned off for this store by the Ebda Store team. Contact support to have it unblocked.`
    );
  }
}

/**
 * The super-admin OVERRIDE on the legacy enable routes (`/toggle`, the carrier PUT) leaves the same append-only ledger row as
 * every other activation (`activation.activated_admin`, which also lifts a "blocked by admin" flag). Call it AFTER the enable
 * write: if the row cannot be written, `revert` switches the provider off again and the error propagates, so "enabled"
 * never exists without its ledger row.
 */
export async function recordAdminEnable(args: {
  storeId: string;
  provider: string;
  mode: string;
  revert: () => Promise<void>;
}): Promise<void> {
  try {
    await appendActivationLedger({
      storeId: args.storeId,
      provider: args.provider,
      action: 'activated_admin',
      mode: args.mode,
      ref: null,
    });
  } catch (err) {
    await args
      .revert()
      .catch(e =>
        logger.error(
          { e, storeId: args.storeId, provider: args.provider },
          '[ACTIVATION] could not switch off after a failed ledger write'
        )
      );
    throw err;
  }
}

/** Switch the provider on/off FOR CHECKOUT. Enabling goes through the exact gate of the settings routes. */
async function setProviderEnabled(
  storeId: string,
  provider: string,
  kind: 'payments' | 'shipping',
  enabled: boolean,
  actor: ActivationActor
): Promise<void> {
  await withStore(storeId, async () => {
    if (kind === 'payments') {
      const row = await (
        await storeDb(storeId)
      ).paymentConfig.findFirst({ where: { provider, storeId } });
      if (!row) throw new AppError(404, 'NOT_FOUND', 'The store has not saved credentials');
      if (enabled) assertEnableAllowed(row as unknown as ConnectableRow);
      await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: row.id, storeId },
        data: { isEnabled: enabled, updatedBy: actor.userId },
      });
    } else {
      await shippingCarrierService.upsertCarrierConfig(storeId, provider as never, { enabled });
    }
  });
  clearProviderCaches(storeId);
}

/** A plain bilingual sentence for a failed check. AI only explains the measured code; the fixed sentence is the fallback. */
async function triageFailure(
  storeId: string,
  provider: string,
  test: LastTest
): Promise<{ en: string; ar: string; source: 'ai' | 'fixed' }> {
  const view = describeConnectionCheck({ ok: false, code: test.code });
  // Nothing to fix on the merchant side when the provider is simply unreachable: the fixed sentence says so.
  if (test.code !== 'unreachable') {
    try {
      const ai = await AIService.triageProviderCheck({
        storeId,
        provider,
        mode: test.mode,
        code: test.code,
        reasonEn: view.messageEn,
      });
      return { ...ai, source: 'ai' };
    } catch (err) {
      logger.warn({ err, storeId, provider }, '[ACTIVATION] AI triage unavailable, fixed sentence');
    }
  }
  return { en: view.messageEn, ar: view.messageAr, source: 'fixed' };
}

type ActivationPreview =
  | {
      outcome: 'ready';
      provider: string;
      mode: string;
      testAt: string;
      /** The check passed but the provider has no safe test call: usable, not proven. */
      unverifiedConnection: boolean;
      confirmToken: string;
      expiresInSeconds: number;
    }
  | {
      outcome: 'failed';
      provider: string;
      code: string;
      check: ConnectionCheckView;
      triage: { en: string; ar: string; source: 'ai' | 'fixed' };
    };

function confirmSubject(storeId: string, provider: string, userId: string, test: LastTest) {
  return {
    tool: ACTIVATE_TOOL,
    storeId,
    keyId: CONFIRM_KEY_ID,
    userId,
    // The previewed payload: this provider, in this mode, proven by exactly this test run.
    argsHash: hashConfirmArgs({ provider, mode: test.mode, testAt: test.at }),
  };
}

/**
 * Step 1 of "Test and turn on". The SERVER runs the check with the stored credentials (nothing in a request
 * body can make a test pass). A pass returns a single-use confirm token; a failure returns a plain sentence
 * and no token, so a failing provider can never be turned on from here.
 */
export async function previewSelfActivation(
  storeId: string,
  provider: string,
  actor: ActivationActor
): Promise<ActivationPreview> {
  const entry = activatableEntry(provider);
  const conn = await withStore(storeId, () => loadConnection(storeId, provider, entry.kind));
  if (!conn || !(conn.row as { credentials?: string | null }).credentials) {
    throw new AppError(
      422,
      'CREDENTIALS_REQUIRED',
      'Save your credentials for this provider before turning it on'
    );
  }
  if (rowEnabled(conn)) {
    throw new AppError(409, 'ALREADY_ACTIVE', `${provider} is already turned on for this store`);
  }
  await assertNotBlocked(storeId, provider);
  const test = await runTestForStore(storeId, provider, actor);
  if (!test.ok) {
    await reportConnectionCheck({ storeId, provider, mode: test.mode, code: test.code });
    return {
      outcome: 'failed',
      provider,
      code: test.code,
      check: describeConnectionCheck({ ok: false, code: test.code }),
      triage: await triageFailure(storeId, provider, test),
    };
  }
  return {
    outcome: 'ready',
    provider,
    mode: test.mode,
    testAt: test.at,
    unverifiedConnection: test.code === 'no_check',
    confirmToken: signConfirmToken(confirmSubject(storeId, provider, actor.userId, test)),
    expiresInSeconds: Math.floor(CONFIRM_TOKEN_TTL_MS / 1000),
  };
}

/**
 * Step 2: verify + consume the token, re-check the gate against the CURRENT stored test, enable the provider for
 * checkout, then append the ledger row. A failure after the enable switches it off again (compensating rollback),
 * so "enabled" never exists without its ledger row. Requires an Idempotency-Key (same key = the first answer).
 */
export async function confirmSelfActivation(
  store: { id: string; name: string },
  provider: string,
  input: { confirmToken: string; idempotencyKey: string | undefined },
  actor: ActivationActor
): Promise<{ replayed: boolean; activated: true; provider: string; mode: string }> {
  const storeId = store.id;
  const entry = activatableEntry(provider);
  let compensationFailed = false;
  const { replayed, value } = await withIdempotencyKey(
    `provider-activate:${storeId}:${provider}`,
    input.idempotencyKey,
    async () => {
      const conn = await withStore(storeId, () => loadConnection(storeId, provider, entry.kind));
      if (!conn) throw new AppError(404, 'NOT_FOUND', 'The store has not saved credentials');
      if (rowEnabled(conn)) {
        throw new AppError(
          409,
          'ALREADY_ACTIVE',
          `${provider} is already turned on for this store`
        );
      }
      // Before the token is looked at, so a blocked store never burns (or learns anything from) a token.
      await assertNotBlocked(storeId, provider);
      const last = lastTestOf(conn);
      if (!last || !last.ok || !last.current) {
        throw new AppError(
          409,
          'CONNECTION_NOT_TESTED',
          'Test the connection again: the latest test must pass with the credentials stored now'
        );
      }
      if (
        !verifyConfirmToken(
          input.confirmToken,
          confirmSubject(storeId, provider, actor.userId, last)
        )
      ) {
        throw new AppError(
          409,
          'CONFIRMATION_INVALID',
          'Confirm again: this confirmation is expired or does not match what is being turned on'
        );
      }
      // One consume -> enable -> ledger sequence per store + provider at a time (cheap checks above stay outside the claim, so
      // a stale or junk confirm never blocks a valid one). Re-check "already on" inside it: two confirms whose test runs
      // share a timestamp hold two valid tokens, and the loser's compensation would switch the provider off after the
      // winner enabled it.
      const locked = await withClaimLock(
        `provider-activate:${storeId}:${provider}`,
        60,
        async () => {
          const again = await withStore(storeId, () =>
            loadConnection(storeId, provider, entry.kind)
          );
          if (again && rowEnabled(again)) {
            throw new AppError(
              409,
              'ALREADY_ACTIVE',
              `${provider} is already turned on for this store`
            );
          }
          let first: boolean;
          try {
            first = await consumeConfirmToken(input.confirmToken);
          } catch {
            throw new AppError(
              503,
              'CONFIRMATION_UNAVAILABLE',
              'Try again shortly; nothing was changed'
            );
          }
          if (!first) {
            throw new AppError(409, 'CONFIRMATION_USED', 'This confirmation was already used');
          }
          const everBefore = (
            await readLedger(
              {
                provider,
                op: {
                  in: [
                    `${ACTIVATION_LEDGER_PREFIX}activated_self`,
                    `${ACTIVATION_LEDGER_PREFIX}activated_admin`,
                  ],
                },
              },
              1
            )
          ).length;
          let enabled = false;
          let requestId: string | null = null;
          try {
            await setProviderEnabled(storeId, provider, entry.kind, true, actor);
            enabled = true;
            requestId = await withStore(storeId, async () => {
              const open = await findOpenRequest(storeId, provider);
              const data = {
                status: 'activated',
                decidedById: actor.userId,
                decidedAt: new Date(),
                note: null,
              };
              if (open) {
                await decideRequest(open.id, storeId, data);
                return open.id;
              }
              const row = await createRequest(storeId, {
                provider,
                requestedById: actor.userId,
                ...data,
              });
              return row.id;
            });
            await appendActivationLedger({
              storeId,
              provider,
              action: 'activated_self',
              mode: last.mode,
              ref: requestId,
            });
          } catch (err) {
            // The request must not stay `activated` without its ledger row: mark it failed (status `rejected` + note,
            // the table's check constraint has no `failed`), whatever step threw.
            if (requestId) {
              const failedId = requestId;
              await withStore(storeId, () =>
                decideRequest(failedId, storeId, {
                  status: 'rejected',
                  note: 'activation failed before it was recorded',
                  decidedAt: new Date(),
                })
              ).catch(e =>
                logger.error(
                  { e, storeId, provider },
                  '[ACTIVATION] could not mark the request failed'
                )
              );
            }
            if (enabled) {
              try {
                await setProviderEnabled(storeId, provider, entry.kind, false, actor);
              } catch (undoErr) {
                compensationFailed = true;
                logger.error(
                  { undoErr, storeId, provider },
                  '[ACTIVATION] could not switch off after a failed ledger write'
                );
              }
            }
            throw err;
          }
          await auditLog({
            action: 'provider_activation.self_activated',
            storeId,
            userId: actor.userId,
            resourceType: 'provider_activation_request',
            resourceId: requestId ?? provider,
            details: { storeId, provider, mode: last.mode, testAt: last.at },
            ip: actor.ip,
            userAgent: actor.userAgent,
          });
          // Decision PROVIDERS-3: the first connection of a provider nobody has verified yet pages ops (P1).
          void (async () => {
            if (await isProviderVerified(provider)) return;
            await sendAlert({
              level: 'p1',
              scope: 'store',
              store,
              source: 'provider.activation.first_connection',
              title:
                everBefore === 0
                  ? `First connection of ${provider}`
                  : `Unverified provider turned on: ${provider}`,
              body: `${store.name} turned on ${provider} (${last.mode}) after its own passing connection test. ${everBefore === 0 ? 'No store had connected this provider before. ' : ''}Watch its first real order.`,
              context: { provider, mode: last.mode, storeId, first: everBefore === 0 },
            });
          })().catch(() => undefined);
          return { activated: true as const, provider, mode: last.mode };
        }
      );
      if (!locked.acquired) {
        throw new AppError(
          409,
          'ACTIVATION_IN_PROGRESS',
          `${provider} is being turned on for this store right now; check the settings before trying again`
        );
      }
      return locked.value;
    },
    () => compensationFailed,
    { required: true }
  );
  return { replayed, ...value };
}

/**
 * Super-admin OVERRIDE (kept on purpose, annotated): turn a provider off for one store and close any activated
 * request, with a note the merchant is shown. Appends a ledger row.
 */
export async function deactivateForStore(
  storeId: string,
  provider: string,
  note: string,
  actor: ActivationActor
): Promise<{ provider: string; wasEnabled: boolean }> {
  const entry = activatableEntry(provider);
  const conn = await withStore(storeId, () => loadConnection(storeId, provider, entry.kind));
  const wasEnabled = conn !== null && rowEnabled(conn);
  const open = await withStore(storeId, async () => {
    const row = await findOpenRequest(storeId, provider);
    if (row?.status !== 'activated') return null;
    await decideRequest(row.id, storeId, {
      status: 'rejected',
      note,
      decidedById: actor.userId,
      decidedAt: new Date(),
    });
    return row;
  });
  if (!wasEnabled && !open) {
    throw new AppError(409, 'NOT_ACTIVE', `${provider} is not turned on for this store`);
  }
  // The block (ledger row) first: if switching off then fails, the flag already stops any re-enable.
  await appendActivationLedger({
    storeId,
    provider,
    action: 'deactivated',
    mode: conn ? (lastTestOf(conn)?.mode ?? 'sandbox') : 'sandbox',
    ref: null,
  });
  if (wasEnabled) await setProviderEnabled(storeId, provider, entry.kind, false, actor);
  await auditLog({
    action: 'provider_activation.deactivated',
    storeId,
    userId: actor.userId,
    resourceType: 'provider_activation_request',
    resourceId: provider,
    details: { storeId, provider, note, wasEnabled },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  await notifyMerchant(storeId, provider, 'deactivated', note, actor);
  return { provider, wasEnabled };
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
    return decideRequest(req.id, storeId, {
      status: 'rejected',
      note,
      decidedById: actor.userId,
      decidedAt: new Date(),
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

/** Super-admin: lift a "blocked by admin" flag (the merchant can then run Test and turn on again). */
export async function unblockForStore(
  storeId: string,
  provider: string,
  actor: ActivationActor
): Promise<{ provider: string }> {
  activatableEntry(provider);
  try {
    await assertNotBlocked(storeId, provider);
    throw new AppError(409, 'NOT_BLOCKED', `${provider} is not blocked for this store`);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'PROVIDER_BLOCKED') throw err;
  }
  await appendActivationLedger({
    storeId,
    provider,
    action: 'unblocked',
    mode: 'sandbox',
    ref: null,
  });
  await auditLog({
    action: 'provider_activation.unblocked',
    storeId,
    userId: actor.userId,
    resourceType: 'provider_activation_request',
    resourceId: provider,
    details: { storeId, provider },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return { provider };
}

/** Email the store owner the decision (platform sender, bilingual). Best effort, never throws. */
async function notifyMerchant(
  storeId: string,
  provider: string,
  decision: 'activated' | 'rejected' | 'deactivated',
  note: string | undefined,
  actor: ActivationActor
): Promise<void> {
  try {
    if (await isDemoStore(storeId)) return; // a showroom has no merchant to tell
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
        : decision === 'deactivated'
          ? `${en} was turned off on your store / ${ar} اتقفلت على متجرك`
          : `About your ${en} request / بخصوص طلب تفعيل ${ar}`;
    const bodyEn =
      decision === 'activated'
        ? `${en} is now active for ${store?.name}. You can switch it on from your payment / shipping settings.`
        : decision === 'deactivated'
          ? `${en} was turned off on ${store?.name} by the Ebda Store team. ${note ?? ''}`
          : `We could not activate ${en} yet. ${note ?? ''}`;
    const bodyAr =
      decision === 'activated'
        ? `${ar} اتفعّلت على ${store?.name}. تقدر تشغّلها من إعدادات الدفع / الشحن.`
        : decision === 'deactivated'
          ? `فريق Ebda Store قفل ${ar} على ${store?.name}. ${note ?? ''}`
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
