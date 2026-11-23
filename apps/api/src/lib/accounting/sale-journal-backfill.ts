/**
 * Sale-journal backfill: post the missing GL sale entry for PAID orders that never got one.
 *
 * Why: COD "Mark paid" sent `order/created` with a bare `inngest.send(..)` that a Worker cancelled with the response, so the
 * accounting journal never ran (Amelia, 2026-11-23: ORD-TOXU0G-7LODS, ORD-TOYND8-R19A2). Nothing swept them: the order-created
 * stuck sweep skips orders whose creation fanout already claimed them.
 *
 *  - Posts ONLY the journal: `money.journalSale({orderId})`, never `order/created` (that would re-send the customer email, the
 *    admin push and the WhatsApp notice).
 *  - PARTIAL REFUNDS: a refund booked before the sale existed had its journal skipped (`no-original-entry`, returns.ts), so posting
 *    the full sale alone would overstate revenue by that refund. After the sale, every partial-refund event of the order is replayed
 *    through the same money ops the refund job uses (journalPartialReturn / journalAmountOnlyRefund), each idempotent on its own
 *    refundKey. Only orders whose sale THIS run posts are replayed, so a refund that was journalled (or deliberately not) on an
 *    order that already had its sale is never touched.
 *  - GATES per store, like accounting-post-order-journal: plan feature `accounting.basic` AND the store's accounting setting. A store
 *    failing either is skipped whole and counted by reason.
 *  - IDEMPOTENT: journalSale is keyed on (store_id, source, source_id) and a candidate has NO `order` entry, so a rerun finds nothing.
 *  - DRY-RUN by default: reports counts by reason and lists candidate order ids per store; writes nothing.
 *  - BOUNDED + RESUMABLE: ordered by (store id, order id); `cursor` = the last order handled. The budget (<= 500, default 200) counts
 *    every store visited (1 each) and every order scanned, so a request never runs unbounded even over thousands of idle stores.
 *  - GONE / non-DO stores are skipped and reported; one failing store or order never stops the run.
 */
import { d1All } from '../../services/platform/billing-d1';
import { featureService } from '../../services/feature.service';
import { allStoresDirectory } from '../jobs/store-db';
import { lookupStore } from '../definer';
import logger from '../logger';
import { storeMoney, storeRepo } from '../repo-factory';
import { partialRefunds, pendingPreSaleRefunds, replayRefunds } from './refund-replay';

export interface SaleBackfillStoreReport {
  storeId: string;
  scanned: number;
  /** orders that have no sale entry and would be (dry run) / were posted */
  candidates: number;
  posted: number;
  /** counts by reason: already_journaled, cancelled, fully_refunded, partial_refund_replay_needed, refunds_replayed, ... */
  reasons: Record<string, number>;
  /** candidate order ids (capped) */
  orderIds: string[];
  errors: Array<{ orderId: string; code: string }>;
  /** set when the whole store was skipped: why */
  storeSkipped: 'gone' | 'not_do' | 'error' | 'accounting_off' | 'plan_gate' | null;
  done: boolean;
}
export interface SaleBackfillResult {
  dryRun: boolean;
  stores: SaleBackfillStoreReport[];
  totals: {
    storesVisited: number;
    scanned: number;
    candidates: number;
    posted: number;
    errors: number;
    byReason: Record<string, number>;
  };
  nextCursor: string | null;
}

interface Cursor {
  s: string;
  o: string | null;
}
const PAGE = 200;
export const SALE_BACKFILL_MAX_BUDGET = 500;
const DEFAULT_BUDGET = 200;
const LIST_CAP = 200;
const encodeSaleCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeSaleCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    return typeof c.s === 'string' && (c.o === null || typeof c.o === 'string') ? c : null;
  } catch {
    return null;
  }
}

const codeOf = (err: unknown): string =>
  String((err as { code?: unknown })?.code ?? (err as Error)?.name ?? 'unknown').slice(0, 64);
const bump = (r: Record<string, number>, k: string, n = 1): void => {
  r[k] = (r[k] ?? 0) + n;
};

async function backfillStore(
  storeId: string,
  from: string | null,
  dryRun: boolean,
  budget: number,
  gate: { accountingOn: boolean }
): Promise<{ report: SaleBackfillStoreReport; lastOrder: string | null }> {
  const report: SaleBackfillStoreReport = {
    storeId,
    scanned: 0,
    candidates: 0,
    posted: 0,
    reasons: {},
    orderIds: [],
    errors: [],
    storeSkipped: null,
    done: false,
  };
  const skipStore = (why: NonNullable<SaleBackfillStoreReport['storeSkipped']>) => {
    report.storeSkipped = why;
    report.done = true;
    return { report, lastOrder: from };
  };
  try {
    if (!(await lookupStore({ id: storeId }, ['active', 'inactive', 'suspended'])))
      return skipStore('gone');
    // Same gates as accounting-post-order-journal: the store's accounting setting, then the plan feature.
    if (!gate.accountingOn) return skipStore('accounting_off');
    if (!(await featureService.isFeatureEnabled(storeId, 'accounting.basic')))
      return skipStore('plan_gate');
    const repo = await storeRepo(storeId);
    const money = await storeMoney(storeId);
    if (repo.backend !== 'do' || !money) return skipStore('not_do');
    let after = from;
    while (report.scanned < budget) {
      const take = Math.min(PAGE, budget - report.scanned);
      const rows = await repo.db.order.findMany({
        where: {
          storeId,
          paymentStatus: { in: ['paid', 'refunded'] },
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take,
        select: { id: true, status: true, paymentStatus: true },
      });
      for (const o of rows) {
        report.scanned++;
        after = o.id;
        try {
          if (o.status === 'refunded' || o.paymentStatus === 'refunded') {
            bump(report.reasons, 'fully_refunded');
            continue;
          }
          if (o.status === 'cancelled') {
            bump(report.reasons, 'cancelled');
            continue;
          }
          const has = await repo.db.journalEntry.findFirst({
            where: { storeId, source: 'order', sourceId: o.id },
            select: { id: true, createdAt: true },
          });
          if (has) {
            // RETRY: a run that posted the sale but failed mid-replay leaves refunds without their journal. Only refunds that
            // happened BEFORE the sale existed could have been skipped for want of it; one made after was journalled normally.
            const pending = await pendingPreSaleRefunds(
              repo,
              storeId,
              o.id,
              has.createdAt as string | Date
            );
            if (pending.length === 0) {
              bump(report.reasons, 'already_journaled');
              continue;
            }
            bump(report.reasons, 'refund_replay_needed');
            if (report.orderIds.length < LIST_CAP) report.orderIds.push(o.id);
            if (!dryRun) await replayRefunds(money, o.id, pending, report.reasons);
            continue;
          }
          report.candidates++;
          if (report.orderIds.length < LIST_CAP) report.orderIds.push(o.id);
          const refunds = await partialRefunds(repo, storeId, o.id);
          if (refunds.length > 0) bump(report.reasons, 'partial_refund_replay_needed');
          if (dryRun) continue;
          const r = await money.journalSale({ orderId: o.id });
          if (!r.posted) {
            bump(report.reasons, `sale_skipped_${r.skipped ?? 'not_posted'}`);
            continue;
          }
          report.posted++;
          // The sale now exists: book the refunds that were skipped for want of it, or revenue is overstated.
          await replayRefunds(money, o.id, refunds, report.reasons);
        } catch (err) {
          logger.error(
            { storeId, orderId: o.id, code: codeOf(err) },
            'sale-journal backfill: order failed'
          );
          report.errors.push({ orderId: o.id, code: codeOf(err) });
        }
      }
      if (rows.length < take) {
        report.done = true;
        break;
      }
    }
    return { report, lastOrder: after };
  } catch (err) {
    logger.error({ storeId, code: codeOf(err) }, 'sale-journal backfill: store failed');
    return skipStore('error');
  }
}

export async function runSaleJournalBackfill(opts: {
  dryRun: boolean;
  cursor?: string;
  budget?: number;
  storeId?: string;
}): Promise<SaleBackfillResult> {
  const budget = Math.max(1, Math.min(opts.budget ?? DEFAULT_BUDGET, SALE_BACKFILL_MAX_BUDGET));
  const cur = decodeSaleCursor(opts.cursor);
  const stores = await d1All<{ id: string }>(
    `SELECT id FROM stores WHERE deleted_at IS NULL AND storage_backend = 'do' ${opts.storeId ? 'AND id = ?2' : ''} AND id >= ?1 ORDER BY id`,
    cur?.s ?? '',
    ...(opts.storeId ? [opts.storeId] : [])
  );
  const directory = new Map(
    (await allStoresDirectory(undefined)).map(s => [s.id, s.accountingEnabled === true])
  );
  const reports: SaleBackfillStoreReport[] = [];
  let left = budget;
  let nextCursor: string | null = null;
  for (const { id } of stores) {
    // A visit costs 1 and a store needs at least one order's worth beside it, so an idle fleet cannot run unbounded.
    if (left < 2) {
      nextCursor = encodeSaleCursor({ s: id, o: cur?.s === id ? cur.o : null });
      break;
    }
    left -= 1;
    const { report, lastOrder } = await backfillStore(
      id,
      cur?.s === id ? cur.o : null,
      opts.dryRun,
      left,
      { accountingOn: directory.get(id) === true }
    );
    reports.push(report);
    left -= report.scanned;
    if (!report.done) {
      nextCursor = encodeSaleCursor({ s: id, o: lastOrder });
      break;
    }
  }
  const byReason: Record<string, number> = {};
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.reasons)) bump(byReason, k, v);
    if (r.storeSkipped) bump(byReason, `store_${r.storeSkipped}`);
  }
  const totals = reports.reduce(
    (t, r) => ({
      ...t,
      scanned: t.scanned + r.scanned,
      candidates: t.candidates + r.candidates,
      posted: t.posted + r.posted,
      errors: t.errors + r.errors.length,
    }),
    {
      storesVisited: reports.length,
      scanned: 0,
      candidates: 0,
      posted: 0,
      errors: 0,
      byReason,
    }
  );
  return { dryRun: opts.dryRun, stores: reports, totals, nextCursor };
}
