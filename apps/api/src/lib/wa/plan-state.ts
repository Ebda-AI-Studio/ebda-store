/**
 * `store.plan_changed` (contract section 4): the plan a store is on, whether it includes the Ebda
 * WhatsApp package, and its standing (`status`, `periodEnd`), so a dunning suspension, a cancellation
 * or an expiry reaches Ebda WhatsApp's package gate. Entitlement is a NEVER-stale class: it is
 * sent on EVERY write of a plan or subscription (one observer on the database client, see
 * `installPlanChangeObserver`), with an 12-hourly reconciliation as the backstop.
 */
import {
  prisma,
  runInTenantContext,
  setModelWriteObserver,
  type ModelWriteEvent,
} from '@ebda/database';
import { getEntitlements } from '../../services/plan-entitlements';
import { sendEventAfterCommit } from '../inngest/send-after-commit';
import logger from '../logger';
import type { StoreEventInput } from './events';

export const PLAN_CHANGED_EVENT = 'store/plan-changed';

type PlanStatus = 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';

/** The subscription columns whose change can alter a store's entitlement or standing. */
const RELEVANT_SUBSCRIPTION_KEYS = new Set([
  'planCode',
  'status',
  'currentPeriodStart',
  'currentPeriodEnd',
  'trialEndsAt',
  'cancelAtPeriodEnd',
  'pendingPlanCode',
]);

function keysOf(data: unknown): string[] {
  return data && typeof data === 'object' ? Object.keys(data as Record<string, unknown>) : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/**
 * Which store (if any) a database write changes the PLAN or STANDING of. Pure; the guard test
 * drives it with every write shape the services use.
 */
export function planChangeStoreId(e: ModelWriteEvent): string | null {
  const args = (e.args ?? {}) as {
    where?: Record<string, unknown>;
    data?: unknown;
    create?: unknown;
    update?: unknown;
  };
  const result = (e.result ?? {}) as Record<string, unknown>;
  if (e.model === 'StoreSubscription') {
    if (e.operation === 'create' || e.operation === 'createMany' || e.operation === 'delete') {
      return (
        str((args.data as Record<string, unknown> | undefined)?.storeId) ??
        str(args.where?.storeId) ??
        str(result.storeId)
      );
    }
    if (e.operation === 'update' || e.operation === 'updateMany' || e.operation === 'upsert') {
      const written = e.operation === 'upsert' ? args.update : args.data;
      if (!keysOf(written).some(k => RELEVANT_SUBSCRIPTION_KEYS.has(k))) return null;
      return str(args.where?.storeId) ?? str(result.storeId);
    }
    return null;
  }
  if (e.model === 'Store' && (e.operation === 'update' || e.operation === 'updateMany')) {
    if (!keysOf(args.data).includes('plan')) return null;
    return str(args.where?.id) ?? str(result.id);
  }
  return null;
}

/** Ask the job to re-read this store's plan state and tell Ebda WhatsApp. Never throws. */
export async function notifyPlanChanged(storeId: string): Promise<void> {
  await sendEventAfterCommit(
    'wa-plan-changed',
    { name: PLAN_CHANGED_EVENT, data: { storeId } },
    { ifUnhookable: 'send' }
  );
}

let installed = false;
/** Idempotent: every plan / subscription write anywhere in the API reaches `notifyPlanChanged`. */
export function installPlanChangeObserver(): void {
  if (installed) return;
  installed = true;
  setModelWriteObserver(e => {
    const storeId = planChangeStoreId(e);
    if (storeId) {
      void notifyPlanChanged(storeId).catch(err =>
        logger.warn(
          { err, storeId },
          '[wa] plan change notify failed (12-hourly reconcile covers it)'
        )
      );
    }
  });
}

function toPlanStatus(status: string, periodEnd: Date | null, now: Date): PlanStatus {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return periodEnd && periodEnd.getTime() <= now.getTime() ? 'expired' : 'cancelled';
    default:
      // active, comped, and `none` (no subscription row: the legacy plan decides) are all in force.
      return 'active';
  }
}

/** The envelope input for a store's CURRENT plan state, or null when the store is unknown. */
export async function planChangedInput(
  storeId: string,
  now: Date = new Date()
): Promise<{ input: StoreEventInput; seed: string } | null> {
  const [ent, store] = await Promise.all([
    getEntitlements(storeId),
    runInTenantContext(storeId, () =>
      prisma.store.findUnique({ where: { id: storeId }, select: { ownerId: true } })
    ),
  ]);
  if (!ent || !store) return null;
  const periodEnd = ent.currentPeriodEnd ?? ent.trialEndsAt ?? null;
  const status = toPlanStatus(ent.status, ent.currentPeriodEnd, now);
  const includesWhatsApp = ent.limits.whatsappAutomation === true;
  return {
    // Same state => same envelope id: repeated notifications and the reconcile sweep dedupe.
    seed: `plan:${storeId}:${ent.planCode}:${status}:${periodEnd?.getTime() ?? 'none'}:${includesWhatsApp}`,
    input: {
      type: 'store.plan_changed',
      storeId,
      data: {
        planCode: ent.planCode,
        includesWhatsApp,
        ownerUserId: store.ownerId,
        effectiveAt: now.toISOString(),
        status,
        ...(periodEnd ? { periodEnd: periodEnd.toISOString() } : {}),
      },
    },
  };
}
