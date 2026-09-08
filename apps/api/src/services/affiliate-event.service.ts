import { prisma } from '@force/database';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import logger from '../lib/logger';

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
 * - Called AFTER the mutation succeeds (fire-and-forget pattern).
 * - Returns the created row on success or null on failure — and null when
 *   the write was deferred to after the request's tenant transaction commits
 *   (see below). Every current caller fire-and-forgets the result.
 */
export function recordAffiliateEvent(
  input: RecordAffiliateEventInput
): Promise<{ id: string } | null> {
  // Callers fire this without awaiting, from affiliate routes that DO run
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

async function recordAffiliateEventNow(
  input: RecordAffiliateEventInput
): Promise<{ id: string } | null> {
  try {
    const event = await prisma.affiliateEvent.create({
      data: {
        affiliateId: input.affiliateId,
        storeId: input.storeId,
        eventType: input.eventType,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        triggeredByUserId: input.triggeredByUserId ?? null,
        details: (input.details ?? {}) as object,
      },
      select: { id: true },
    });

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
  return prisma.affiliateEvent.findMany({
    where: { affiliateId, storeId },
    orderBy: { occurredAt: 'desc' },
    take: 200,
  });
}
