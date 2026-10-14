import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { ebdaAdsConfigOrLog, type EbdaAdsEventName } from './ebda-ads.service';

const ENQUEUE_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`enqueue timed out after ${ms}ms`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export interface EbdaConversionRequest {
  name: EbdaAdsEventName;
  /** Shared with the browser twin; also the Inngest idempotency id. */
  eventId: string;
  userId: string;
  storeId?: string;
  billingEventId?: string;
}

/**
 * Queue one conversion for Ebda's own Meta pixel. Call it AFTER the business transaction
 * committed. Never throws and never blocks the caller's flow: unconfigured -> a single info
 * log and nothing queued; an enqueue failure is logged with the event id (there is no row to
 * mark, and the Meta side is attribution only, not money).
 */
export async function emitEbdaConversion(req: EbdaConversionRequest): Promise<void> {
  if (!ebdaAdsConfigOrLog()) return;
  try {
    // Bounded: a slow queue must not hold the user's response.
    await withTimeout(
      inngest.send({
        id: req.eventId,
        name: 'ebda-ads/conversion.requested',
        data: {
          name: req.name,
          eventId: req.eventId,
          userId: req.userId,
          ...(req.storeId ? { storeId: req.storeId } : {}),
          ...(req.billingEventId ? { billingEventId: req.billingEventId } : {}),
        },
      }),
      ENQUEUE_TIMEOUT_MS
    );
  } catch (err) {
    logger.error(
      { err, event: req.name, eventId: req.eventId },
      '[ebda-ads] could not queue conversion — not sent'
    );
  }
}
