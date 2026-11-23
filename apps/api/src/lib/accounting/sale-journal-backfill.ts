/**
 * Sale-journal backfill: post the missing GL sale entry for PAID orders that never got one.
 *
 * Why: COD "Mark paid" sent `order/created` with a bare `inngest.send(..)` that a Worker cancelled with the response, so the
 * accounting journal never ran (Amelia, 2026-11-23: ORD-TOXU0G-7LODS, ORD-TOYND8-R19A2). Nothing swept them: the order-created
 * stuck sweep skips orders whose creation fanout already claimed them.
 *
 *  - Posts ONLY the journal: `money.journalSale({orderId})`, never `order/created` (that would re-send the customer email, the
 *    admin push and the WhatsApp notice).
 *  - IDEMPOTENT: journalSale is keyed on (store_id, source, source_id), and a candidate is an order with NO `order` journal entry
 *    for it, so a rerun finds nothing. `accounting disabled`, a cancelled/refunded order and a zero order are skipped by journalSale
 *    itself and reported by reason, never forced.
 *  - DRY-RUN by default: lists the candidates per store and writes nothing.
 *  - RESUMABLE: ordered by (store id, order id); `cursor` = the last order handled; a call stops after `budget` orders scanned.
 *  - GONE / non-DO stores are skipped and reported; one failing store or order never stops the run.
 */
import { d1All } from '../../services/platform/billing-d1';
import { lookupStore } from '../definer';
import logger from '../logger';
import { storeMoney, storeRepo } from '../repo-factory';

export interface SaleBackfillStoreReport {
  storeId: string;
  scanned: number;
  /** paid, not cancelled/refunded, no sale entry: would be posted (dry run) */
  candidates: number;
  posted: number;
  /** journalSale declined, by its own reason (accounting_disabled, ...) */
  skipped: Record<string, number>;
  orderIds: string[];
  errors: Array<{ orderId: string; code: string }>;
  storeSkipped: 'gone' | 'not_do' | 'error' | null;
  done: boolean;
}
export interface SaleBackfillResult {
  dryRun: boolean;
  stores: SaleBackfillStoreReport[];
  totals: { scanned: number; candidates: number; posted: number; errors: number };
  nextCursor: string | null;
}

interface Cursor {
  s: string;
  o: string | null;
}
const PAGE = 200;
export const SALE_BACKFILL_MAX_BUDGET = 2000;
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

async function backfillStore(
  storeId: string,
  from: string | null,
  dryRun: boolean,
  budget: number
): Promise<{ report: SaleBackfillStoreReport; lastOrder: string | null }> {
  const report: SaleBackfillStoreReport = {
    storeId,
    scanned: 0,
    candidates: 0,
    posted: 0,
    skipped: {},
    orderIds: [],
    errors: [],
    storeSkipped: null,
    done: false,
  };
  try {
    if (!(await lookupStore({ id: storeId }, ['active', 'inactive', 'suspended']))) {
      report.storeSkipped = 'gone';
      report.done = true;
      return { report, lastOrder: from };
    }
    const repo = await storeRepo(storeId);
    const money = await storeMoney(storeId);
    if (repo.backend !== 'do' || !money) {
      report.storeSkipped = 'not_do';
      report.done = true;
      return { report, lastOrder: from };
    }
    let after = from;
    while (report.scanned < budget) {
      const take = Math.min(PAGE, budget - report.scanned);
      const rows = await repo.db.order.findMany({
        where: {
          storeId,
          paymentStatus: 'paid',
          status: { notIn: ['cancelled', 'refunded'] },
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: 'asc' },
        take,
        select: { id: true },
      });
      for (const o of rows) {
        report.scanned++;
        after = o.id;
        try {
          const has = await repo.db.journalEntry.findFirst({
            where: { storeId, source: 'order', sourceId: o.id },
            select: { id: true },
          });
          if (has) continue;
          report.candidates++;
          if (report.orderIds.length < LIST_CAP) report.orderIds.push(o.id);
          if (dryRun) continue;
          const r = await money.journalSale({ orderId: o.id });
          if (r.posted) report.posted++;
          else {
            const why = r.skipped ?? 'not_posted';
            report.skipped[why] = (report.skipped[why] ?? 0) + 1;
          }
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
    report.storeSkipped = 'error';
    report.done = true;
    return { report, lastOrder: from };
  }
}

export async function runSaleJournalBackfill(opts: {
  dryRun: boolean;
  cursor?: string;
  budget?: number;
  storeId?: string;
}): Promise<SaleBackfillResult> {
  const budget = Math.max(1, Math.min(opts.budget ?? 500, SALE_BACKFILL_MAX_BUDGET));
  const cur = decodeSaleCursor(opts.cursor);
  const stores = await d1All<{ id: string }>(
    `SELECT id FROM stores WHERE deleted_at IS NULL AND storage_backend = 'do' ${opts.storeId ? 'AND id = ?2' : ''} AND id >= ?1 ORDER BY id`,
    cur?.s ?? '',
    ...(opts.storeId ? [opts.storeId] : [])
  );
  const reports: SaleBackfillStoreReport[] = [];
  let left = budget;
  let nextCursor: string | null = null;
  for (const { id } of stores) {
    if (left <= 0) {
      nextCursor = encodeSaleCursor({ s: id, o: null });
      break;
    }
    const { report, lastOrder } = await backfillStore(
      id,
      cur?.s === id ? cur.o : null,
      opts.dryRun,
      left
    );
    reports.push(report);
    left -= report.scanned;
    if (!report.done) {
      nextCursor = encodeSaleCursor({ s: id, o: lastOrder });
      break;
    }
  }
  const totals = reports.reduce(
    (t, r) => ({
      scanned: t.scanned + r.scanned,
      candidates: t.candidates + r.candidates,
      posted: t.posted + r.posted,
      errors: t.errors + r.errors.length,
    }),
    { scanned: 0, candidates: 0, posted: 0, errors: 0 }
  );
  return { dryRun: opts.dryRun, stores: reports, totals, nextCursor };
}
