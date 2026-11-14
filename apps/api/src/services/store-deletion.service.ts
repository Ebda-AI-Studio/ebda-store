import { randomUUID } from 'node:crypto';
import { withStore } from '@ebda/database';
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
/** The confirm token is bound to the signed-in owner session, not to an API key (the MCP key slot is unused here). */
const KEY_SLOT = 'owner-session';

type DeletionState = 'pending' | 'cancelled' | 'executed';
export interface DeletionRequest {
  id: string;
  requestedBy: string;
  requestedAt: string;
  executeAfter: string;
  state: DeletionState;
  cancelledAt?: string;
  cancelledBy?: string;
  executedAt?: string;
  /** Why the last execution attempt was refused (the request stays pending and is re-checked). */
  lastBlock?: { code: string; at: string };
}
interface DeletionStore {
  id: string;
  name: string;
  slug: string;
  ownerId: string | null;
  deletionRequest: DeletionRequest | null;
}
interface GuardReason {
  code: 'STORE_HAS_MONEY_IN_FLIGHT' | 'STORE_HAS_BILLED_SUBSCRIPTION' | 'STORE_IS_BILLING_PARENT';
  message: string;
  details?: Record<string, number>;
}

export interface DeletionDeps {
  now(): number;
  loadStore(storeId: string): Promise<DeletionStore | null>;
  saveRequest(storeId: string, request: DeletionRequest | null): Promise<void>;
  /** Counts of money in flight, or null when there is none (or it cannot be read before execution, see the ruling). */
  moneyInFlight(storeId: string): Promise<Record<string, number> | null>;
  hasBilledSubscription(storeId: string): Promise<boolean>;
  isBillingParentWithSiblings(store: DeletionStore): Promise<boolean>;
  deleteStore(storeId: string, actorUserId: string): Promise<void>;
  audit(entry: {
    action: string;
    userId: string;
    storeId: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  emit(name: string, data: Record<string, unknown>): Promise<void>;
  notifyOwner(
    kind: 'scheduled' | 'cancelled' | 'executed',
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
};

export async function assertStoreOwner(
  deps: DeletionDeps,
  storeId: string,
  userId: string
): Promise<DeletionStore> {
  const store = await deps.loadStore(storeId);
  if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  // Owner only: staff and store admins who are not the owner are refused (the delete is the owner's decision).
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
  await deps.saveRequest(store.id, request);
  await deps.audit({
    action: 'STORE_DELETION_SCHEDULED',
    userId: input.userId,
    storeId: store.id,
    details: { requestId: request.id, executeAfter: request.executeAfter, slug: store.slug },
  });
  await deps.emit('store/deletion.scheduled', {
    storeId: store.id,
    requestId: request.id,
    executeAfter: request.executeAfter,
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
  input: { storeId: string; userId: string; ownerEmail?: string },
  deps: DeletionDeps
): Promise<DeletionRequest> {
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  const current = store.deletionRequest;
  if (!current || current.state !== 'pending') {
    throw new AppError(409, 'NO_PENDING_DELETION', 'There is no scheduled deletion to cancel');
  }
  const cancelled: DeletionRequest = {
    ...current,
    state: 'cancelled',
    cancelledAt: new Date(deps.now()).toISOString(),
    cancelledBy: input.userId,
  };
  await deps.saveRequest(store.id, cancelled);
  await deps.audit({
    action: 'STORE_DELETION_CANCELLED',
    userId: input.userId,
    storeId: store.id,
    details: { requestId: current.id },
  });
  await deps.notifyOwner('cancelled', {
    to: input.ownerEmail ?? null,
    storeName: store.name,
    slug: store.slug,
  });
  return cancelled;
}

export async function readDeletionStatus(
  input: { storeId: string; userId: string },
  deps: DeletionDeps
): Promise<{ request: DeletionRequest | null }> {
  const store = await assertStoreOwner(deps, input.storeId, input.userId);
  return { request: store.deletionRequest };
}

type ExecuteOutcome =
  | { outcome: 'executed' }
  | { outcome: 'not-due' | 'cancelled' | 'stale' | 'gone' | 'done' }
  | { outcome: 'blocked'; reasons: GuardReason[] };

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
  // The window is 14 days: money or billing may have changed since the schedule. Re-check, never delete blind.
  const reasons = await evaluateGuards(deps, store);
  if (reasons.length > 0) {
    await deps.saveRequest(store.id, {
      ...req,
      lastBlock: { code: reasons[0].code, at: new Date(deps.now()).toISOString() },
    });
    await deps.audit({
      action: 'STORE_DELETION_BLOCKED',
      userId: req.requestedBy,
      storeId: store.id,
      details: { requestId: req.id, reasons: reasons.map(r => r.code) },
    });
    return { outcome: 'blocked', reasons };
  }
  // A throw leaves the request pending so the job's retry converges (StoreService.delete reopens whatever it closed, Ruling NZ-D17).
  await deps.deleteStore(store.id, req.requestedBy);
  await deps.audit({
    action: 'STORE_DELETED_BY_OWNER',
    userId: req.requestedBy,
    storeId: store.id,
    details: { requestId: req.id, slug: store.slug, storeName: store.name },
  });
  // The store row (and its settings) is gone after a successful delete; nothing is left to mark.
  return { outcome: 'executed' };
}
