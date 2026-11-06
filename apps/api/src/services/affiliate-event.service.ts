import { prisma, Prisma } from '@ebda/database';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { withSavepoint } from '../lib/savepoint';
import logger from '../lib/logger';
import { storeDb, storeWriter } from '../lib/repo-factory';

// ==========================================
// Types
// ==========================================

interface RecordAffiliateEventInput {
  affiliateId: string;
  storeId: string;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  triggeredByUserId?: string | null;
  details?: Record<string, unknown>;
}

// ==========================================
// Service
// ==========================================

/**
 * Append-only affiliate audit log helper.
 *
 * Design rules (mirrors payment-event.service.ts):
 * - NEVER throws — any DB failure is logged and swallowed so the caller's
 *   main transaction is not affected.
 * - Called AFTER the mutation succeeds, and awaited (see the return note).
 * - Returns the created row on success or null on failure — and null when
 *   the write was deferred to after the request's tenant transaction commits
 *   (see below). Every caller awaits it and ignores the result: awaiting
 *   costs nothing when deferred, and is what makes the inline (Inngest)
 *   insert land before the caller's transaction commits (#1589).
 */
export function recordAffiliateEvent(
  input: RecordAffiliateEventInput
): Promise<{ id: string } | null> {
  // Callers await this (#1589 — the un-awaited `void` form raced the COMMIT of
  // the Inngest money paths, where there is no deferral scope and the insert
  // runs inline). Historically they fired it without awaiting, from affiliate
  // routes that DO run
  // under `tenantContext` (affiliate.routes.ts registers
  // `router.param('storeId', tenantContext)`). The single
  // `affiliateEvent.create` below therefore raced the request's transaction
  // commit and lost whenever the handler responded promptly — P2028,
  // swallowed by the `catch` below as "[AffiliateEventService] Failed to
  // record event", so the append-only audit trail silently lost rows.
  // Deferring runs it in a fresh tenant transaction after the commit (which
  // is also when the affiliate row it references is durable); outside a
  // request it still runs inline and returns the created row, unchanged.
  return deferAfterTenantCommit('affiliate-event.record', () => recordAffiliateEventNow(input));
}

/**
 * The audit row for a MONEY movement, written on the SAME transaction client
 * that moves the money (#1590).
 *
 * The deferred `recordAffiliateEvent` above runs after the request commits and
 * is DROPPED when the request rolls back. That is right for work that reacts to
 * the request's own writes, but not for the audit row of a balance change: a
 * 5xx must not leave a durable commission/payout with no audit row, nor an
 * audit row for money that never moved. Written through `db` — the transaction
 * the balance write runs on (the ambient tenant transaction, or the caller's
 * own `withMoneyTx`, see `inAffiliateMoneyTx` in affiliate.service.ts) — the
 * row commits, or rolls back, with the balance change it describes. Not
 * savepointed on purpose: a failed audit insert rolls the money back with it.
 */
export function affiliateEventCreate(
  input: RecordAffiliateEventInput,
  db: Pick<
    Prisma.TransactionClient,
    'affiliateEvent'
  > = prisma as unknown as Prisma.TransactionClient
) {
  return db.affiliateEvent.create({
    data: affiliateEventData(input),
    select: { id: true },
  });
}

function affiliateEventData(input: RecordAffiliateEventInput) {
  return {
    affiliateId: input.affiliateId,
    storeId: input.storeId,
    eventType: input.eventType,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    triggeredByUserId: input.triggeredByUserId ?? null,
    details: (input.details ?? {}) as object,
  };
}

async function recordAffiliateEventNow(
  input: RecordAffiliateEventInput
): Promise<{ id: string } | null> {
  try {
    // Savepoint: with no deferral scope (the Inngest money paths) this runs
    // INLINE on the caller's tenant transaction, which the callers now await
    // (#1589). A failed insert would otherwise abort that transaction and
    // take the caller's writes down with it — "never throws" has to mean
    // "never poisons the caller's transaction" too.
    // The store's own backend: the Durable Object for a DO store, the `prisma` proxy for a Postgres one.
    const w = await storeWriter(input.storeId);
    const event = await withSavepoint(() =>
      w.affiliateEvent.create({
        data: affiliateEventData(input),
        select: { id: true },
      })
    );

    logger.info(
      {
        eventId: event.id,
        affiliateId: input.affiliateId,
        storeId: input.storeId,
        eventType: input.eventType,
      },
      '[AffiliateEventService] Event recorded'
    );

    return event;
  } catch (error) {
    // Never throw — audit log failure must not break the mutation path.
    logger.error(
      { error, affiliateId: input.affiliateId, eventType: input.eventType },
      '[AffiliateEventService] Failed to record event'
    );
    return null;
  }
}

/**
 * Fetch the event timeline for a single affiliate.
 * Returns up to 200 events, newest-first.
 */
export async function listAffiliateEvents(affiliateId: string, storeId: string): Promise<object[]> {
  return (await storeDb(storeId)).affiliateEvent.findMany({
    where: { affiliateId, storeId },
    orderBy: { occurredAt: 'desc' },
    take: 200,
  });
}
