import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/error-handler';
import {
  consumeConfirmToken,
  hashConfirmArgs,
  signConfirmToken,
  verifyConfirmToken,
} from '../mcp/merchant-confirm-token';

/**
 * Owner-initiated store deletion (SELF-SERVICE gap A11, Ruling STORE-LIFECYCLE-1).
 *
 * preview  -> guards (named reasons) + a server-issued single-use confirm token bound to (store, user, slug).
 * schedule -> token verified AND consumed, typed slug must match, guards re-checked, a `pending` request 14 days out.
 * cancel   -> owner, any time while pending.
 * execute  -> run by the `store-deletion-execute` job after the window: guards re-checked, then `StoreService.delete`
 *             (which itself refuses on money in flight, archives the fiscal records and anonymises the personal data).
 *
 * Owner = `store.ownerId === userId`. Staff, store admins who are not the owner and every other store get 403 / 404.
 * `DELETE /stores/:id` (super_admin: support / test stores) is untouched and has no cooling-off.
 */
const COOLING_OFF_MS = 14 * 86_400_000;
const DELETION_TOOL = 'store.delete';
const EXPORT_TOOL = 'store.export';
/** The confirm token is bound to the signed-in owner session, not to an API key (the MCP key slot is unused here). */
const KEY_SLOT = 'owner-session';

type DeletionState = 'pending' | 'executing' | 'cancelled' | 'executed';
export interface DeletionRequest {
  id: string;
  requestedBy: string;
  requestedAt: string;
  executeAfter: string;
  state: DeletionState;
  cancelledAt?: string;
  cancelledBy?: string;
  /** Set when the system (not a person) cancelled it, e.g. the store changed owner during the window. */
  voidedReason?: 'owner_changed';
  executedAt?: string;
  /** Why the last execution attempt was refused or failed (the request stays pending and is re-checked). */
  lastBlock?: { code: string; at: string; reason?: string };
}
interface DeletionStore {
  id: string;
  name: string;
  slug: string;
  ownerId: string | null;
  deletionRequest: DeletionRequest | null;
}
interface GuardReason {
  code:
    | 'STORE_HAS_MONEY_IN_FLIGHT'
    | 'STORE_HAS_BILLED_SUBSCRIPTION'
    | 'STORE_IS_BILLING_PARENT'
    | 'ERASURE_NOT_ENABLED'
    | 'FISCAL_ARCHIVE_FAILED';
  message: string;
  details?: Record<string, number>;
}

export interface DeletionDeps {
  now(): number;
  loadStore(storeId: string): Promise<DeletionStore | null>;
  /** First write of a request (nothing pending exists, so nothing to race). */
  saveRequest(storeId: string, request: DeletionRequest | null): Promise<void>;
  /**
   * Compare-and-set of an EXISTING request: writes `to` only while the stored request still has `from.id` and `from.state`.
   * False = somebody else moved it first (a cancel, an execution claim). Atomic on Postgres (one conditional UPDATE) and on a
   * Durable Object store (the precondition is checked inside the StoreDO's own transaction, see the ruling).
   */
  transition(
    storeId: string,
    from: { id: string; state: DeletionState },
    to: DeletionRequest
  ): Promise<boolean>;
  /** Counts of money in flight, or null when there is none (or it cannot be read before execution, see the ruling). */
  moneyInFlight(storeId: string): Promise<Record<string, number> | null>;
  hasBilledSubscription(storeId: string): Promise<boolean>;
  isBillingParentWithSiblings(store: DeletionStore): Promise<boolean>;
  /** The OWNER's request runs the delete (not a super_admin): `requestId` names the request in the delete's own audit trail. */
  deleteStore(storeId: string, actorUserId: string, requestId: string): Promise<void>;
  /**
   * True when this store's deletion would need the PDPL erasure step (a Durable Object store: its people are anonymised after the
   * delete) and `PDPL_CF_ERASURE_ENABLED` is not "true". Ruling DEL-FLAG-1: such a deletion is refused, never run without erasure.
   */
  erasureBlocked(storeId: string): Promise<boolean>;
  /** The owner's current address (identity service), or null. The request never stores an address. */
  ownerEmail(userId: string): Promise<string | null>;
  audit(entry: {
    action: string;
    userId: string;
    storeId: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  emit(name: string, data: Record<string, unknown>): Promise<void>;
  notifyOwner(
    kind: 'scheduled' | 'cancelled' | 'executed' | 'voided' | 'exported',
    info: { to: string | null; storeName: string; slug: string; executeAfter?: string }
  ): Promise<void>;
}

const REASON_MESSAGES: Record<GuardReason['code'], string> = {
  STORE_HAS_MONEY_IN_FLIGHT:
    'المتجر لسه عليه فلوس في الطريق (طلبات مدفوعة ما اتسلمتش، تحويلات مستنية تأكيد، مرتجعات مفتوحة، دفع عند الاستلام ما اتسواش أو نزاع على دفع). خلّصها الأول وبعدين جرّب تاني.',
  STORE_HAS_BILLED_SUBSCRIPTION:
    'اشتراك المتجر لسه شغال ومتحاسب عليه. الغي الاشتراك من صفحة الفوترة الأول وبعدين جرّب تاني.',
  STORE_IS_BILLING_PARENT:
    'ده المتجر الرئيسي اللي بيتحاسب عليه وعندك متاجر تانية. انقل الفوترة لمتجر تاني الأول.',
  ERASURE_NOT_ENABLED:
    'حذف المتجر لسه ماتفعّلش على المنصة، فمحدش اتمسحله حاجة. هنكمّل طلبك مع الدعم أول ما يتفعّل.',
  FISCAL_ARCHIVE_FAILED:
    'مقدرناش نحفظ السجلات الضريبية للمتجر قبل الحذف، فالحذف اتأجل. هنحاول تاني أوتوماتيك.',
};

export async function assertStoreOwner(
  deps: DeletionDeps,
  storeId: string,
  userId: string,
  /** `super_admin` passes only where the caller allows it (read + cancel): the platform override, annotated at each call. */
  allowSuperAdmin?: { role?: string }
): Promise<DeletionStore> {
  const store = await deps.loadStore(storeId);
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  // Owner only: staff and store admins who are not the owner are refused (the delete is the owner's decision).
  if (allowSuperAdmin?.role === 'super_admin') return store;
  if (!store.ownerId || store.ownerId !== userId) {
    throw new AppError(403, 'OWNER_ONLY', 'Only the store owner can do this');
  }
  return store;
}

async function evaluateGuards(deps: DeletionDeps, store: DeletionStore): Promise<GuardReason[]> {
  const reasons: GuardReason[] = [];
  const flight = await deps.moneyInFlight(store.id);
  if (flight && Object.values(flight).reduce((n, v) => n + v, 0) > 0) {
    reasons.push({
      code: 'STORE_HAS_MONEY_IN_FLIGHT',
      message: REASON_MESSAGES.STORE_HAS_MONEY_IN_FLIGHT,
      details: flight,
    });
  }
  if (await deps.hasBilledSubscription(store.id)) {
    reasons.push({
      code: 'STORE_HAS_BILLED_SUBSCRIPTION',
      message: REASON_MESSAGES.STORE_HAS_BILLED_SUBSCRIPTION,
    });
  }
  if (await deps.erasureBlocked(store.id)) {
    reasons.push({
      code: 'ERASURE_NOT_ENABLED',
      message: REASON_MESSAGES.ERASURE_NOT_ENABLED,
    });
  }
  if (await deps.isBillingParentWithSiblings(store)) {
    reasons.push({
      code: 'STORE_IS_BILLING_PARENT',
      message: REASON_MESSAGES.STORE_IS_BILLING_PARENT,
    });
  }
  return reasons;
}

function tokenSubject(store: DeletionStore, userId: string) {
  return {
    tool: DELETION_TOOL,
    storeId: store.id,
    keyId: KEY_SLOT,
    userId,
    argsHash: hashConfirmArgs({ storeId: store.id, slug: store.slug }),
  };
}

type PreviewResult =
  | {
      ok: true;
      slug: string;
      storeName: string;
      coolingOffDays: number;
      confirmToken: string;
      reasons: [];
    }
  | { ok: false; reasons: GuardReason[] };

export async function previewStoreDeletion(
  input: { storeId: string; userId: string },
  deps: DeletionDeps
): Promise<PreviewResult> {
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  const reasons = await evaluateGuards(deps, store);
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    slug: store.slug,
    storeName: store.name,
    coolingOffDays: COOLING_OFF_MS / 86_400_000,
    confirmToken: signConfirmToken(tokenSubject(store, input.userId)),
    reasons: [],
  };
}

export async function scheduleStoreDeletion(
  input: {
    storeId: string;
    userId: string;
    confirmToken: string;
    typedSlug: string;
    ownerEmail?: string;
  },
  deps: DeletionDeps
): Promise<DeletionRequest> {
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  if (store.deletionRequest?.state === 'pending') {
    throw new AppError(
      409,
      'DELETION_ALREADY_SCHEDULED',
      'A deletion is already scheduled for this store'
    );
  }
  // Typed slug first: a typo must not burn the single-use token.
  if (input.typedSlug !== store.slug) {
    throw new AppError(400, 'SLUG_MISMATCH', 'The typed store address does not match');
  }
  if (!verifyConfirmToken(input.confirmToken, tokenSubject(store, input.userId))) {
    throw new AppError(
      400,
      'CONFIRM_TOKEN_INVALID',
      'The confirmation expired or is invalid. Review and confirm again.'
    );
  }
  const reasons = await evaluateGuards(deps, store);
  if (reasons.length > 0) {
    throw new AppError(409, reasons[0].code, reasons[0].message, { reasons } as never);
  }
  // Single use: a replay (or a second tab) is refused. Fails closed when the claim store is down.
  if (!(await consumeConfirmToken(input.confirmToken))) {
    throw new AppError(
      400,
      'CONFIRM_TOKEN_INVALID',
      'The confirmation expired or is invalid. Review and confirm again.'
    );
  }
  const now = deps.now();
  const request: DeletionRequest = {
    id: randomUUID(),
    requestedBy: input.userId,
    requestedAt: new Date(now).toISOString(),
    executeAfter: new Date(now + COOLING_OFF_MS).toISOString(),
    state: 'pending',
  };
  // EMIT FIRST, then save: if the send throws nothing is saved, so the owner's retry is not met with a 409 for a request that has
  // no job. If the save throws after a successful send, the job wakes up, finds no request with that id ('stale') and ends: the
  // request id is random, so a retry's own event is independent (idempotent by id, never a double execution).
  await deps.emit('store/deletion.scheduled', {
    storeId: store.id,
    requestId: request.id,
    executeAfter: request.executeAfter,
  });
  await deps.saveRequest(store.id, request);
  await deps.audit({
    action: 'STORE_DELETION_SCHEDULED',
    userId: input.userId,
    storeId: store.id,
    details: { requestId: request.id, executeAfter: request.executeAfter, slug: store.slug },
  });
  await deps.notifyOwner('scheduled', {
    to: input.ownerEmail ?? null,
    storeName: store.name,
    slug: store.slug,
    executeAfter: request.executeAfter,
  });
  return request;
}

export async function cancelStoreDeletion(
  input: { storeId: string; userId: string; role?: string; ownerEmail?: string },
  deps: DeletionDeps
): Promise<DeletionRequest> {
  // Super-admin override: the platform may cancel a pending deletion (support, a mistaken request); audited with the role.
  const store = await assertStoreOwner(deps, input.storeId, input.userId, { role: input.role });
  const current = store.deletionRequest;
  if (current?.state === 'executing') {
    throw new AppError(
      409,
      'DELETION_IN_PROGRESS',
      'The deletion is already running and can no longer be cancelled'
    );
  }
  if (!current || current.state !== 'pending') {
    throw new AppError(409, 'NO_PENDING_DELETION', 'There is no scheduled deletion to cancel');
  }
  const cancelled: DeletionRequest = {
    ...current,
    state: 'cancelled',
    cancelledAt: new Date(deps.now()).toISOString(),
    cancelledBy: input.userId,
  };
  // Compare-and-set: if the executor claimed the request between our read and this write, the cancel loses and says so.
  if (!(await deps.transition(store.id, { id: current.id, state: 'pending' }, cancelled))) {
    throw new AppError(
      409,
      'DELETION_IN_PROGRESS',
      'The deletion is already running and can no longer be cancelled'
    );
  }
  await deps.audit({
    action: 'STORE_DELETION_CANCELLED',
    userId: input.userId,
    storeId: store.id,
    details: {
      requestId: current.id,
      byRole: input.role === 'super_admin' ? 'super_admin' : 'owner',
    },
  });
  await deps.notifyOwner('cancelled', {
    to: input.ownerEmail ?? null,
    storeName: store.name,
    slug: store.slug,
  });
  return cancelled;
}

export async function readDeletionStatus(
  input: { storeId: string; userId: string; role?: string },
  deps: DeletionDeps
): Promise<{ request: DeletionRequest | null; isOwner: boolean }> {
  // Super-admin override: may read an owner's pending deletion (support). `isOwner` tells the UI which controls to show.
  const store = await assertStoreOwner(deps, input.storeId, input.userId, { role: input.role });
  return {
    request: store.deletionRequest,
    isOwner: !!store.ownerId && store.ownerId === input.userId,
  };
}

type ExecuteOutcome =
  | { outcome: 'executed' }
  | { outcome: 'not-due' | 'cancelled' | 'stale' | 'gone' | 'done' | 'voided' }
  | { outcome: 'blocked'; reasons: GuardReason[] };

/**
 * Refusals `StoreService.delete` raises that BLOCK (request back to pending, re-checked daily) instead of failing the job:
 * code -> HTTP status. FISCAL_ARCHIVE_FAILED (503) means the 6-year fiscal archive could not be written: nothing was deleted.
 */
const BLOCKING_DELETE_CODES = new Map<string, number>([
  ['STORE_HAS_MONEY_IN_FLIGHT', 409],
  ['STORE_IS_BILLING_PARENT', 409],
  ['FISCAL_ARCHIVE_FAILED', 503],
]);

export async function executeStoreDeletion(
  input: { storeId: string; requestId: string },
  deps: DeletionDeps
): Promise<ExecuteOutcome> {
  const store = await deps.loadStore(input.storeId);
  if (!store) return { outcome: 'gone' };
  const req = store.deletionRequest;
  if (!req || req.id !== input.requestId) return { outcome: 'stale' };
  if (req.state === 'cancelled') return { outcome: 'cancelled' };
  if (req.state === 'executed') return { outcome: 'done' };
  if (deps.now() < Date.parse(req.executeAfter)) return { outcome: 'not-due' };
  const nowIso = () => new Date(deps.now()).toISOString();
  // The requester must still own the store: a transfer during the 14 days means the new owner never asked for this.
  if (store.ownerId !== req.requestedBy) {
    const voided: DeletionRequest = {
      ...req,
      state: 'cancelled',
      cancelledAt: nowIso(),
      cancelledBy: 'system',
      voidedReason: 'owner_changed',
    };
    if (await deps.transition(store.id, { id: req.id, state: req.state }, voided)) {
      await deps.audit({
        action: 'STORE_DELETION_VOIDED_OWNER_CHANGED',
        userId: req.requestedBy,
        storeId: store.id,
        details: { requestId: req.id, newOwnerId: store.ownerId },
      });
      // No address is stored on the request: the requester's current address is read now. The audit row is the record either way.
      await deps
        .notifyOwner('voided', {
          to: await deps.ownerEmail(req.requestedBy).catch(() => null),
          storeName: store.name,
          slug: store.slug,
        })
        .catch(() => undefined);
    }
    return { outcome: 'voided' };
  }
  const block = async (reasons: GuardReason[], from: DeletionState): Promise<ExecuteOutcome> => {
    // Visible state (the owner and super admin read `lastBlock`), an audit row per attempt, back to pending for the daily re-check.
    await deps.transition(
      store.id,
      { id: req.id, state: from },
      {
        ...req,
        state: 'pending',
        lastBlock: { code: reasons[0].code, at: nowIso() },
      }
    );
    await deps.audit({
      action: 'STORE_DELETION_BLOCKED',
      userId: req.requestedBy,
      storeId: store.id,
      details: { requestId: req.id, reasons: reasons.map(r => r.code) },
    });
    return { outcome: 'blocked', reasons };
  };
  // The window is 14 days: money or billing may have changed since the schedule. Re-check, never delete blind.
  const reasons = await evaluateGuards(deps, store);
  if (reasons.length > 0) return block(reasons, req.state);
  // Claim: pending -> executing is a compare-and-set, so a cancel that landed first wins and a cancel after it is refused.
  // `executing` already (a crashed earlier attempt) resumes: the delete is idempotent and converges.
  if (req.state === 'pending') {
    if (
      !(await deps.transition(
        store.id,
        { id: req.id, state: 'pending' },
        { ...req, state: 'executing' }
      ))
    ) {
      return { outcome: 'cancelled' };
    }
  }
  // The requester's address, read before the delete (the identity service stays reachable afterwards, but one read is enough).
  const ownerAddress = await deps.ownerEmail(req.requestedBy).catch(() => null);
  try {
    await deps.deleteStore(store.id, req.requestedBy, req.id);
  } catch (err) {
    // A Durable Object store checks its money inside the delete (it cannot be read before): that 409 is a BLOCK, not a failure.
    if (err instanceof AppError && BLOCKING_DELETE_CODES.get(err.code) === err.statusCode) {
      return block(
        [
          {
            code: err.code as GuardReason['code'],
            message: err.message,
            details: err.details as never,
          },
        ],
        'executing'
      );
    }
    throw err; // the job retries; the request stays `executing` and resumes
  }
  await deps.audit({
    action: 'STORE_DELETED_BY_OWNER',
    userId: req.requestedBy,
    storeId: store.id,
    details: { requestId: req.id, slug: store.slug, storeName: store.name },
  });
  // The store row (and its settings) is gone after a successful delete; nothing is left to mark. The notice is best effort:
  // the store is already deleted, so a mail failure must not fail (and retry) the job.
  await deps
    .notifyOwner('executed', {
      to: ownerAddress,
      storeName: store.name,
      slug: store.slug,
    })
    .catch(() => undefined);
  return { outcome: 'executed' };
}

/**
 * The job died for good (retries spent) while the request was `executing`: nothing else ever looks at `executing` again and a
 * cancel is refused 409, so the owner would be stuck. Put it back to `pending` (compare-and-set, so a request that moved on is left
 * alone) with the failure on `lastBlock`, and say so (the caller raises the P1 alert). Returns whether it was recovered.
 */
export async function recoverFailedExecution(
  input: { storeId: string; requestId: string; reason: string },
  deps: DeletionDeps
): Promise<boolean> {
  const store = await deps.loadStore(input.storeId);
  const req = store?.deletionRequest;
  if (!store || !req || req.id !== input.requestId || req.state !== 'executing') return false;
  const ok = await deps.transition(
    store.id,
    { id: req.id, state: 'executing' },
    {
      ...req,
      state: 'pending',
      lastBlock: {
        code: 'EXECUTION_FAILED',
        at: new Date(deps.now()).toISOString(),
        reason: input.reason.slice(0, 300),
      },
    }
  );
  if (ok)
    await deps.audit({
      action: 'STORE_DELETION_EXECUTION_FAILED',
      userId: req.requestedBy,
      storeId: store.id,
      details: { requestId: req.id, reason: input.reason.slice(0, 300) },
    });
  return ok;
}

/** Step-up for the whole-store export (M2): a single-use token bound to (store, owner), issued to the owner only. */
function exportSubject(storeId: string, userId: string) {
  return {
    tool: EXPORT_TOOL,
    storeId,
    keyId: KEY_SLOT,
    userId,
    argsHash: hashConfirmArgs({ storeId }),
  };
}
export async function issueStoreExportToken(
  input: { storeId: string; userId: string },
  deps: DeletionDeps
): Promise<{ confirmToken: string }> {
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  return { confirmToken: signConfirmToken(exportSubject(store.id, input.userId)) };
}
/** Verifies (does not consume) an export token; `consumeExportToken` spends it once the bundle is ready. */
export function verifyStoreExportToken(input: {
  storeId: string;
  userId: string;
  confirmToken: string;
}): boolean {
  return verifyConfirmToken(input.confirmToken, exportSubject(input.storeId, input.userId));
}
export const consumeStoreExportToken = consumeConfirmToken;
