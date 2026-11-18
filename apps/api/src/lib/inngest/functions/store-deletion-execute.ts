import type { JobDef } from '../../jobs/types';
import logger from '../../logger';
import { inngest } from '../client';
import { sendAlert } from '../../../services/alerts.service';
import {
  executeStoreDeletion,
  MAX_EXECUTION_RECOVERIES,
  recoverFailedExecution,
  type RecoveryResult,
} from '../../../services/store-deletion.service';
import { productionDeletionDeps } from '../../../services/store-deletion.wiring';

/**
 * Owner store deletion, after the 14-day cooling-off (SELF-SERVICE gap A11, Ruling STORE-LIFECYCLE-1).
 *
 * `store/deletion.scheduled` carries only ids: this job sleeps until `executeAfter`, then asks the SERVICE to execute, which
 * re-reads the request from the store (cancelled / replaced / not due / guard flipped all stop it) and re-checks money in flight
 * and billing before `StoreService.delete`. A blocked store is re-checked daily for up to 30 days, then a P1 alert names it
 * (the request stays pending: the owner sees the named reason in Settings). A lost event only means a deletion never runs (fails
 * safe); the request stays visible and cancellable.
 */
const MAX_BLOCKED_DAYS = 30;

/**
 * The job died for good (retries spent). The request may be left `executing`, which nothing else reads and a cancel refuses: put it
 * back to `pending` with the failure on `lastBlock` (compare-and-set, so a request that moved on is untouched) and raise a P1 alert
 * either way, because an owner-requested deletion is stuck. Exported so a test drives the real recovery.
 */
export async function handleStoreDeletionFailure(
  data: { storeId?: string; requestId?: string },
  reason: string
): Promise<RecoveryResult> {
  const { storeId, requestId } = data;
  const none: RecoveryResult = { recovered: false, retryScheduled: false, exhausted: false };
  if (!storeId || !requestId) return none;
  let r = none;
  try {
    r = await recoverFailedExecution({ storeId, requestId, reason }, productionDeletionDeps());
  } catch (e) {
    reason = `${reason}; recovery failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const outcome = r.exhausted
    ? `NEEDS MANUAL ACTION: ${MAX_EXECUTION_RECOVERIES} automatic retries are spent.`
    : r.retryScheduled
      ? `Request back to pending, retry queued for tomorrow (attempt ${r.attempt}/${MAX_EXECUTION_RECOVERIES}).`
      : r.recovered
        ? 'Request back to pending but the retry could NOT be queued: NEEDS MANUAL ACTION.'
        : 'Request NOT recovered: check settings.deletionRequest by hand.';
  await sendAlert({
    level: 'p1',
    scope: 'store',
    source: 'job.store-deletion-execute',
    title: 'Owner store deletion FAILED',
    body: `Store ${storeId}, request ${requestId}: ${reason}. ${outcome}`,
  } as Parameters<typeof sendAlert>[0]).catch(() => undefined);
  return r;
}

export const storeDeletionExecute: JobDef = inngest.createFunction(
  {
    id: 'store-deletion-execute',
    name: 'Owner store deletion after the cooling-off',
    retries: 3,
    triggers: [{ event: 'store/deletion.scheduled' }],
    onFailure: async ({ event, error }) => {
      const data = (event?.data?.event?.data ?? {}) as { storeId?: string; requestId?: string };
      await handleStoreDeletionFailure(data, error?.message ?? 'job failed');
    },
  },
  async ({ event, step }) => {
    const { storeId, requestId, executeAfter } = event.data as {
      storeId?: string;
      requestId?: string;
      executeAfter?: string;
    };
    if (!storeId || !requestId || !executeAfter) {
      logger.warn({ event: event.name }, 'store/deletion.scheduled without ids - skipping');
      return { outcome: 'bad-event' };
    }
    await step.sleepUntil('cooling-off', executeAfter);
    for (let day = 0; day <= MAX_BLOCKED_DAYS; day++) {
      const result = await step.run(`execute-${day}`, () =>
        executeStoreDeletion({ storeId, requestId }, productionDeletionDeps())
      );
      if (result.outcome !== 'blocked') return result;
      await step.sleep(`blocked-wait-${day}`, '1d');
    }
    await step.run('alert-still-blocked', () =>
      sendAlert({
        level: 'p1',
        scope: 'store',
        source: 'job.store-deletion-execute',
        title: `Owner store deletion blocked for ${MAX_BLOCKED_DAYS} days`,
        body: `Store ${storeId}, request ${requestId}: money in flight or billing still blocks the deletion the owner asked for.`,
      } as Parameters<typeof sendAlert>[0])
    );
    return { outcome: 'blocked-too-long' };
  }
);
