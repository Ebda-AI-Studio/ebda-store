import { Inngest, type EventPayload } from 'inngest';
import { config } from '../../config';

/**
 * Event registry — every event the API can fan out lives here so
 * publisher and consumer share a single source of truth. Adding a
 * new background job is a two-step process:
 *
 *   1. Add the event shape below
 *   2. Register a function in `./functions/index.ts` that listens for it
 *
 * Names follow the `domain/action.tense` convention so they read
 * naturally in the Inngest UI: `order/created`, `bulk-import/started`.
 */
type OrderCreatedEvent = EventPayload & {
  name: 'order/created';
  data: {
    orderId: string;
    storeId: string;
    paymentMethod: string;
  };
};

type BulkImportStartedEvent = EventPayload & {
  name: 'bulk-import/started';
  data: {
    jobId: string;
    storeId: string;
  };
};

export type AppEvent = OrderCreatedEvent | BulkImportStartedEvent;

export const inngest = new Inngest({
  id: 'force-api',
  // Inngest's SDK auto-detects dev mode from the absence of an event
  // key, but on Railway we always have NODE_ENV=production set even
  // for staging — be explicit so dev mode is never accidentally on
  // in a deployed environment.
  isDev: config.nodeEnv !== 'production',
  eventKey: config.inngestEventKey || undefined,
  signingKey: config.inngestSigningKey || undefined,
});
