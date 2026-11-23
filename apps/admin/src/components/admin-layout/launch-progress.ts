import { FIRST_PAID_ORDERS_GOAL, type SetupGuideState } from '@ebda/shared';

/**
 * What the top-bar launch chip shows, derived from the SAME setup-guide state the dashboard checklist renders
 * (no second calculation): while a required step is open it counts steps (same done/total as the card), then it
 * counts paid orders toward the first-5 goal, then it is gone.
 */
export type LaunchProgress =
  | { phase: 'steps'; done: number; total: number }
  | { phase: 'orders'; done: number; total: number }
  | { phase: 'done' };

export function launchProgress(g: SetupGuideState): LaunchProgress {
  if (g.requiredDone < g.requiredTotal) {
    return { phase: 'steps', done: g.doneCount, total: g.totalCount };
  }
  const paid = g.paidOrders ?? 0;
  if (paid < FIRST_PAID_ORDERS_GOAL) {
    return { phase: 'orders', done: paid, total: FIRST_PAID_ORDERS_GOAL };
  }
  return { phase: 'done' };
}
