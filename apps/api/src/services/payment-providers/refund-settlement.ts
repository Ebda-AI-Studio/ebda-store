import logger from '../../lib/logger';
import { resolveRefundSettlement as resolveShared } from '@ebda/shared';

/**
 * The refund-settlement rule lives in `@ebda/shared` (`packages/shared/src/refunds/refund-settlement.ts`): ONE
 * implementation for this Postgres path and the StoreDO (Phase 3.3). This module re-exports it and adds the log line.
 */
export {
  IN_FLIGHT_CLAIM_WINDOW_MS,
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
  appendRefundEventId,
  correlateSettleNotice,
  isRefundEventAlreadySeen,
  readAccountedRefundEventIds,
  readRefundStatusById,
  recordRefundStatus,
  selectInFlightClaims,
  type InFlightClaim,
  type RefundClaimEventRow,
  type RefundSettlement,
} from '@ebda/shared';

export function resolveRefundSettlement(
  input: Parameters<typeof resolveShared>[0]
): ReturnType<typeof resolveShared> {
  const r = resolveShared(input);
  if (r.warnProvenanceHeld) {
    logger.warn(
      {
        reportedEventId: input.reportedEventId,
        accounted: input.alreadyRefunded ?? 0,
        paymentAmount: input.paymentAmount,
      },
      '[refund-settlement] refund amount held: payment predates the per-refund ledger, provenance unknown — reconcile manually'
    );
  }
  return r;
}
