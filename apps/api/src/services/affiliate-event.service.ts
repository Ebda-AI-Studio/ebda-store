import { prisma } from '@force/database';
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
 * - Returns the created row on success or null on failure.
 */
export async function recordAffiliateEvent(
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
