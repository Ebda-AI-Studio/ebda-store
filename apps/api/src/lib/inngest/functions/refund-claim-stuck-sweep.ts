import { acrossStoresDb } from '../../jobs/store-db';
import logger from '../../logger';
import { sendAlert } from '../../../services/alerts.service';
import { redis } from '../../../services/redis.service';
import { stepRunUnlessEmpty } from '../empty-exit';
import {
  REFUND_CLAIM_EVENT,
  REFUND_EXECUTED_EVENT,
  REFUND_RELEASED_EVENT,
  REFUND_RECONCILED_EVENT,
} from '../../../services/payment-providers/refund-outcome';

/**
 * Stuck refund-claim check (#1317) — runs on the refund-reversal sweep's tick,
 * not a cron of its own (a new cadence would keep the Neon compute awake; see
 * the CADENCE NOTE in refund-reversal-stuck-sweep.ts).
 *
 * PaymentService.refund commits its claim — `refundedAmount` raised, a
 * `refund_initiated` payment event written — BEFORE it calls the provider, and
 * resolves it afterwards with `refund_completed` (money sent) or
 * `refund_failed` (nothing sent, balance put back). A claim with neither is a
 * refund whose outcome nobody knows:
 *
 *   - the process died between the claim and the provider's answer, or
 *   - the provider never gave a clear answer (`refund_indeterminate`).
 *
 * Either way the payment's balance counts money that may never have left, and
 * nothing in the product can tell it apart from a real refund. It cannot be
 * resolved automatically — without a provider refund id there is nothing to
 * ask the provider about — so this raises it for a human, who checks the
 * provider dashboard. The claim and its outcome show on the order page's
 * payment-events timeline.
 *
 * A human CAN resolve it (issue 2002): completing the return with a
 * non-gateway method ("Already refunded — record only") writes
 * `refund_reconciled` for the claim, which this sweep treats as an outcome.
 *
 * Alerted once per ESCALATION stage, not every tick (issue 2027): at
 * STUCK_AFTER_MINUTES, again at 24h and at 72h, tracked per claim by a Redis
 * sentinel. The every-15-minutes cadence used to page a P1 ~670 times per
 * claim over its week, which is how a real P0 gets scrolled past.
 *
 * Bounded read (issue 2028): claims are read oldest-first in pages of
 * CLAIM_PAGE_SIZE, each page followed by the resolutions for only that page's
 * payments — never an unbounded cross-tenant fetch of every refund event.
 *
 * The bound is on UNRESOLVED claims, not raw rows (issue 2296): every
 * successful refund writes a claim too, so a single 500-row read was spent
 * almost entirely on resolved claims once refund volume passed ~500/week, and
 * a genuinely stuck claim newer than the 500th never surfaced. Paging
 * continues until CLAIM_SCAN_LIMIT unresolved claims are found, the window is
 * exhausted, CLAIM_MAX_PAGES pages were read, or the CLAIM_SCAN_BUDGET_MS
 * wall-clock budget is spent (issue 2347) — the last three can defer one to a
 * later tick, which is logged at warn, never silent. Each page's resolution
 * read is cursor-paged too.
 */

/** Old enough that the request that made the claim is certainly over. */
const STUCK_AFTER_MINUTES = Number(process.env.REFUND_CLAIM_STUCK_MINUTES) || 15;
/**
 * Stop reporting after a week: by then it has been alerted on ~670 ticks and
 * is either reconciled by hand or not going to be because of this alert.
 */
const MAX_AGE_MINUTES = Number(process.env.REFUND_CLAIM_MAX_AGE_MINUTES) || 7 * 24 * 60;
/** Unresolved claims collected per tick, oldest first. A truncated read is logged, never silent. */
const CLAIM_SCAN_LIMIT = 500;
/** Claim rows (resolved or not) read per page. */
const CLAIM_PAGE_SIZE = 500;
/** Hard ceiling on pages per tick (CLAIM_PAGE_SIZE × this raw rows). */
const CLAIM_MAX_PAGES = 20;
/**
 * Wall-clock budget for the claim scan (issue 2347). The whole scan is ONE
 * `step.run`, i.e. one HTTP request from Inngest through Cloudflare, whose edge
 * answers 524 at 100s — and a failed step here also fails the reversal sweep
 * that shares the tick. Paging stops once this is spent, logged like the page
 * ceiling; the rest is read on later ticks.
 */
export const CLAIM_SCAN_BUDGET_MS = 45_000;
/** Resolution rows read per page (cursor-paged, never unbounded). */
const RESOLUTION_PAGE_SIZE = 1000;
/** Ages (minutes) at which one claim is alerted — once each. */
const ESCALATION_STAGES_MINUTES = [STUCK_AFTER_MINUTES, 24 * 60, 72 * 60];
/** Resolution events: the claim's outcome is known. */
const RESOLVING_EVENTS = [REFUND_EXECUTED_EVENT, REFUND_RELEASED_EVENT, REFUND_RECONCILED_EVENT];

interface SweepStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

interface StuckClaim {
  claimId: string;
  paymentId: string;
  storeId: string;
  orderId: string;
  amount: number | null;
  claimedAt: string;
}

export async function handleStuckRefundClaimSweep(
  step: SweepStep,
  event?: { data?: unknown }
): Promise<{ stuck: number }> {
  const cutoff = Date.now() - STUCK_AFTER_MINUTES * 60_000;
  const floor = new Date(Date.now() - MAX_AGE_MINUTES * 60_000);

  const stuck: StuckClaim[] = await stepRunUnlessEmpty(
    step,
    'find-stuck-refund-claims',
    async () => {
      const claims: StuckClaim[] = [];
      let windowExhausted = true;
      let budgetSpent = false;
      const startedAt = Date.now();
      // Pages read so far, across stores: the first page is always read, so a tick makes progress.
      let pagesRead = 0;
      // `payment_events` is store-scoped: the claim scan runs store by store (one
      // at a time, so the page/limit/budget ceilings stay GLOBAL), each store's
      // paging inside its own tenant scope. A cursor id only exists in one store,
      // so cursors never cross stores.
      // PORTED (Ruling CF-JOBS-4): a DO store's alarm scans its own Durable Object's payment timeline.
      await acrossStoresDb(
        event,
        async (storeId, db) => {
          let cursorId: string | null = null;
          let storeWindowExhausted = false;
          for (let page = 0; page < CLAIM_MAX_PAGES && claims.length < CLAIM_SCAN_LIMIT; page++) {
            if (pagesRead > 0 && Date.now() - startedAt > CLAIM_SCAN_BUDGET_MS) {
              budgetSpent = true;
              break;
            }
            pagesRead++;
            const claimRows: Array<{
              id: string;
              paymentId: string;
              storeId: string;
              orderId: string;
              details: unknown;
              occurredAt: Date;
            }> = await db.paymentEvent.findMany({
              where: {
                storeId,
                eventType: REFUND_CLAIM_EVENT,
                occurredAt: { gt: floor, lt: new Date(cutoff) },
              },
              select: {
                id: true,
                paymentId: true,
                storeId: true,
                orderId: true,
                details: true,
                occurredAt: true,
              },
              // `id` breaks occurredAt ties so the cursor is total.
              orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
              take: CLAIM_PAGE_SIZE,
              ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
            });
            if (claimRows.length < CLAIM_PAGE_SIZE) storeWindowExhausted = true;
            if (claimRows.length === 0) break;
            cursorId = claimRows[claimRows.length - 1].id;

            // This page's payments' resolutions, cursor-paged (issue 2347: the read
            // had no `take`, the shape issue 2028 removed from the claim read).
            const paymentIds = [...new Set(claimRows.map(c => c.paymentId))];
            const resolved = new Set<string>();
            let resCursor: string | null = null;
            for (;;) {
              const resolutionRows: Array<{ id: string; details: unknown }> =
                await db.paymentEvent.findMany({
                  where: {
                    storeId,
                    eventType: { in: RESOLVING_EVENTS },
                    paymentId: { in: paymentIds },
                  },
                  select: { id: true, details: true },
                  orderBy: { id: 'asc' },
                  take: RESOLUTION_PAGE_SIZE,
                  ...(resCursor ? { cursor: { id: resCursor }, skip: 1 } : {}),
                });
              for (const e of resolutionRows) {
                const claimId = ((e.details ?? {}) as Record<string, unknown>).claimId;
                if (typeof claimId === 'string') resolved.add(claimId);
              }
              if (resolutionRows.length < RESOLUTION_PAGE_SIZE) break;
              resCursor = resolutionRows[resolutionRows.length - 1].id;
            }
            for (const e of claimRows) {
              const details = (e.details ?? {}) as Record<string, unknown>;
              const claimId = typeof details.claimId === 'string' ? details.claimId : null;
              if (!claimId || resolved.has(claimId)) continue;
              claims.push({
                claimId,
                paymentId: e.paymentId,
                storeId: e.storeId,
                orderId: e.orderId,
                amount: typeof details.amount === 'number' ? details.amount : null,
                claimedAt: e.occurredAt.toISOString(),
              });
              if (claims.length >= CLAIM_SCAN_LIMIT) break;
            }
            if (storeWindowExhausted) break;
          }
          // This store's window was cut short (page ceiling, budget or the global
          // limit) unless it ran dry: the sweep as a whole then did not see the end.
          if (!storeWindowExhausted) windowExhausted = false;
        },
        { concurrency: 1 }
      );
      if (!windowExhausted) {
        logger.warn(
          {
            unresolvedLimit: CLAIM_SCAN_LIMIT,
            maxPages: CLAIM_MAX_PAGES,
            budgetMs: CLAIM_SCAN_BUDGET_MS,
            budgetSpent,
            found: claims.length,
          },
          '[refund-claim-stuck-sweep] claim scan stopped before the window ended — newer unresolved claims are read on later ticks'
        );
      }
      return claims;
    }
  );

  if (stuck.length === 0) return { stuck: 0 };

  // Which claims enter a NEW escalation stage on this tick? One Redis sentinel
  // per (claim, stage); fails open (alerts) when Redis is down.
  const toAlert = await step.run('pick-claims-to-alert', async () => {
    const now = Date.now();
    const picked: Array<StuckClaim & { stageMinutes: number }> = [];
    for (const c of stuck) {
      const ageMin = (now - new Date(c.claimedAt).getTime()) / 60_000;
      const stage = [...ESCALATION_STAGES_MINUTES].reverse().find(m => ageMin >= m);
      if (stage === undefined) continue;
      const fresh = await redis
        .acquireLock(`refund-claim-alerted:${c.claimId}:${stage}`, (MAX_AGE_MINUTES + 60) * 60)
        .catch(() => true);
      if (fresh) picked.push({ ...c, stageMinutes: stage });
    }
    return picked;
  });

  logger.error(
    { count: stuck.length, newlyEscalated: toAlert.length, claims: stuck.slice(0, 20) },
    '[refund-claim-stuck-sweep] refund claims with no outcome — balances may count money that never left'
  );
  if (toAlert.length === 0) return { stuck: stuck.length };

  await step.run('alert-stuck-refund-claims', async () => {
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'payment.refund.claim_stuck',
      // Stable title: the alerts throttle keys on it.
      title: 'Refund(s) with no known outcome',
      body:
        `${toAlert.length} refund claim(s) reached a new age (15m / 24h / 72h) with no outcome ` +
        `(${stuck.length} open in total). Each payment's refunded total already counts the ` +
        `amount. Check each one in the provider dashboard; if the money went out, complete the ` +
        `return with "Already refunded — record only" to settle the claim. The claim is on the ` +
        `order page's payment timeline.`,
      context: {
        totalOpen: stuck.length,
        claims: toAlert.slice(0, 20).map(c => ({
          orderId: c.orderId,
          paymentId: c.paymentId,
          storeId: c.storeId,
          amount: c.amount,
          claimedAt: c.claimedAt,
          stageMinutes: c.stageMinutes,
        })),
      },
    }).catch(() => undefined);
  });
  return { stuck: stuck.length };
}
