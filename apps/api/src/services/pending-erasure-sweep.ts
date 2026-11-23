import { sendAlert } from './alerts.service';
import logger from '../lib/logger';

/** Sweep tries after which a stuck closure pages a human (one P1 per user per try beyond this, throttled by title). */
export const PENDING_ERASURE_ALERT_AFTER = 3;

export interface PendingErasureDeps {
  storeIds: () => Promise<string[]>;
  list: (storeId: string) => Promise<Array<{ userId: string; tries: number }>>;
  /** Re-run the full shopper erasure (idempotent: saved ledger scope, idempotent steps). Throws on failure. */
  erase: (storeId: string, userId: string) => Promise<unknown>;
  note: (storeId: string, userId: string, ok: boolean) => Promise<{ tries: number }>;
  alert?: typeof sendAlert;
}

/**
 * Finish shopper closures that stopped after the store half (PDPL: the sign-in record must not outlive the request). Per user:
 * retry; success clears the retry row; failure counts a try (the DO doubles the wait, 1h..24h) and, from the
 * `PENDING_ERASURE_ALERT_AFTER`th failure on, raises a P1 naming the store id and user id only. One failing user or store never
 * stops the rest.
 */
export async function sweepPendingErasures(deps: PendingErasureDeps) {
  const alert = deps.alert ?? sendAlert;
  const out = { found: 0, erased: 0, failed: 0, alerted: 0 };
  for (const storeId of await deps.storeIds()) {
    let rows: Array<{ userId: string; tries: number }>;
    try {
      rows = await deps.list(storeId);
    } catch (err) {
      logger.error({ err, storeId }, '[pending-erasure] listing failed');
      continue;
    }
    for (const { userId } of rows) {
      out.found += 1;
      try {
        await deps.erase(storeId, userId);
        await deps.note(storeId, userId, true);
        out.erased += 1;
      } catch (err) {
        out.failed += 1;
        logger.error({ err, storeId, userId }, '[pending-erasure] retry failed');
        const { tries } = await deps.note(storeId, userId, false).catch(() => ({ tries: 0 }));
        if (tries >= PENDING_ERASURE_ALERT_AFTER) {
          out.alerted += 1;
          void alert({
            level: 'p1',
            source: 'cron.pending-erasure-sweep',
            scope: 'store',
            store: { id: storeId, name: storeId },
            title: `Shopper account closure is stuck (${userId})`,
            body: `A shopper closure has failed ${tries} sweeps. The sign-in record is still present. Finish it from the merchant erase route.`,
            context: { storeId, userId, tries },
          }).catch(() => undefined);
        }
      }
    }
  }
  return out;
}
