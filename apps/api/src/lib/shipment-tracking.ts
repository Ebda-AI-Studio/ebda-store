/**
 * Pure tracking logic shared by every carrier path (webhook, poll, merchant), no database (SP7).
 *
 *  - `mergeTracking`: fold carrier events into a shipment's history. A repeat is a no-op; events
 *    are kept in time order and the NEWEST decides the status (a late old event cannot move a
 *    shipment backwards); a finished shipment is never reopened by a stray in-flight event.
 *  - `verifyWebhookToken`: the URL-secret check for carriers that sign nothing (Bosta).
 */
import { safeEqual } from './carrier-http';

export const TERMINAL_SHIPMENT_STATUSES = ['delivered', 'cancelled', 'returned'];

export interface TrackingEvent {
  status: string;
  timestamp: Date;
  location?: string;
  description?: string;
}

export interface HistoryEntry {
  status: string;
  timestamp: string;
  location?: string;
  description?: string;
}

export interface MergeResult {
  history: HistoryEntry[];
  status: string;
  /** Number of events that were new. 0 means the call changed nothing. */
  added: number;
}

const keyOf = (status: string, ts: string | Date) => `${status}|${new Date(ts).toISOString()}`;

export function mergeTracking(input: {
  history: HistoryEntry[];
  currentStatus: string;
  events: TrackingEvent[];
}): MergeResult {
  const known = new Set(input.history.map(h => keyOf(h.status, h.timestamp)));
  const fresh: TrackingEvent[] = [];
  for (const e of input.events) {
    const k = keyOf(e.status, e.timestamp);
    if (known.has(k)) continue;
    known.add(k); // the same event twice in ONE batch counts once
    fresh.push(e);
  }
  if (fresh.length === 0) {
    return { history: input.history, status: input.currentStatus, added: 0 };
  }
  const history = [
    ...input.history,
    ...fresh.map(e => ({
      status: e.status,
      timestamp: e.timestamp.toISOString(),
      location: e.location,
      description: e.description,
    })),
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let status = history[history.length - 1].status;
  if (
    TERMINAL_SHIPMENT_STATUSES.includes(input.currentStatus) &&
    !TERMINAL_SHIPMENT_STATUSES.includes(status)
  ) {
    status = input.currentStatus;
  }
  return { history, status, added: fresh.length };
}

/** Constant-time check of the secret path token; an empty secret never matches anything. */
export function verifyWebhookToken(expectedSecret: string | undefined, presented: string): boolean {
  if (!expectedSecret || !presented) return false;
  return safeEqual(presented, expectedSecret);
}
