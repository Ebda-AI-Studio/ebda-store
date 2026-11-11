/**
 * Buyer-key backfill (Ruling WA-BRIDGE-BIND-3): stamp `orders.buyer_key` on every order that has a phone but no key, so the Chat bridge's
 * buyer proof (WA_BRIDGE_REQUIRE_BUYER_PROOF=1) can match orders created before keys existed.
 *
 *  - SAME derivation as checkout and the CI planner: `buyerKeyFor(SUITE_BUYER_KEY_SECRET, toE164(shippingAddress.phone))`.
 *  - IDEMPOTENT: the stamp is the fill-only-NULL `ciOrderStamp` DO op (never overwrites a stamped key; a rerun finds nothing to do).
 *  - DRY-RUN counts what it would stamp and writes nothing.
 *  - RESUMABLE: ordered by (store id, order id); the opaque `cursor` is the last order handled, and a call stops after `budget` orders
 *    scanned, so a Worker request never runs unbounded. Orders with no usable phone stay unkeyed and are counted, not retried.
 *  - GONE STORES are skipped and reported (deleted, not on a Durable Object, or its DO refuses): one bad store never stops the run.
 */
import { buyerKeyFor, toE164 } from '@ebda/shared';
import { d1All } from '../../services/platform/billing-d1';
import { lookupStore } from '../definer';
import logger from '../logger';
import { storeMoney, storeRepo } from '../repo-factory';

export interface BackfillStoreReport {
  storeId: string;
  scanned: number;
  /** stamped (apply) or would be stamped (dry run) */
  keyed: number;
  noPhone: number;
  /** UNPAID COD / InstaPay orders (still open) found WITHOUT a buyer key: the ones whose COD outcome / payment proof is lost if the key stays missing */
  openUnkeyed: number;
  /** of those, the ones with no usable phone: this script cannot key them, a human must */
  openUnkeyedNoPhone: number;
  /** set when `skipped === 'error'`: the error's code (or name); the store is NOT done and a rerun with `storeId` retries it */
  errorCode: string | null;
  skipped: 'gone' | 'not_do' | 'error' | null;
  done: boolean;
}
export interface BackfillResult {
  dryRun: boolean;
  stores: BackfillStoreReport[];
  totals: {
    scanned: number;
    keyed: number;
    noPhone: number;
    openUnkeyed: number;
    openUnkeyedNoPhone: number;
    skippedStores: number;
  };
  /** stores whose DO errored in THIS call: rerun with `storeId` to retry them (a resumed run does not revisit a store it already passed) */
  failed: Array<{ storeId: string; code: string }>;
  /** null = the whole fleet is done; pass it back to continue */
  nextCursor: string | null;
}
interface Cursor {
  s: string;
  o: string | null;
}

const PAGE = 200;
export const MAX_BUDGET = 2000;

export const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    return typeof c.s === 'string' && (c.o === null || typeof c.o === 'string') ? c : null;
  } catch {
    return null;
  }
}

export interface BackfillOpts {
  secret: string;
  dryRun: boolean;
  cursor?: string;
  budget?: number;
  /** limit to one store (still resumable by cursor) */
  storeId?: string;
}

async function backfillStore(
  storeId: string,
  from: string | null,
  secret: string,
  dryRun: boolean,
  budget: number
): Promise<{ report: BackfillStoreReport; lastOrder: string | null }> {
  const report: BackfillStoreReport = {
    storeId,
    scanned: 0,
    keyed: 0,
    noPhone: 0,
    openUnkeyed: 0,
    openUnkeyedNoPhone: 0,
    errorCode: null,
    skipped: null,
    done: false,
  };
  try {
    if (!(await lookupStore({ id: storeId }, ['active', 'inactive', 'suspended']))) {
      report.skipped = 'gone';
      report.done = true;
      return { report, lastOrder: from };
    }
    const repo = await storeRepo(storeId);
    const money = await storeMoney(storeId);
    if (repo.backend !== 'do' || !money) {
      report.skipped = 'not_do';
      report.done = true;
      return { report, lastOrder: from };
    }
    let after = from;
    while (report.scanned < budget) {
      const take = Math.min(PAGE, budget - report.scanned);
      const rows = await repo.db.order.findMany({
        where: { storeId, buyerKey: null, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          shippingAddress: true,
          status: true,
          paymentStatus: true,
          payments: { select: { provider: true } },
        },
      });
      for (const o of rows) {
        report.scanned++;
        after = o.id;
        const phone = (o.shippingAddress as { phone?: unknown } | null)?.phone;
        const e164 = typeof phone === 'string' ? toE164(phone) : null;
        const key = e164 ? await buyerKeyFor(secret, e164) : null;
        const open =
          o.paymentStatus === 'unpaid' &&
          ['pending', 'confirmed', 'awaiting_payment_confirmation'].includes(String(o.status)) &&
          (o.payments ?? []).some(p => p.provider === 'cod' || p.provider === 'instapay');
        if (open) report.openUnkeyed++;
        if (!key) {
          report.noPhone++;
          if (open) report.openUnkeyedNoPhone++;
          continue;
        }
        if (dryRun) {
          report.keyed++;
          continue;
        }
        const r = await money.ciOrderStamp({ orderId: o.id, areaKey: null, buyerKey: key });
        if (r.stamped) report.keyed++;
      }
      if (rows.length < take) {
        report.done = true; // a short page: nothing left after `after`
        break;
      }
    }
    return { report, lastOrder: after };
  } catch (err) {
    // Never swallowed: logged with the store id and the error code, and recorded in the result (`failed`), so the operator sees it and a rerun
    // limited to that store (or the resumed run, which restarts at the cursor store) can retry it.
    const code = String(
      (err as { code?: unknown })?.code ?? (err as Error)?.name ?? 'unknown'
    ).slice(0, 64);
    logger.error({ storeId, code }, 'buyer-key backfill: store failed');
    report.skipped = 'error';
    report.errorCode = code;
    report.done = true;
    return { report, lastOrder: from };
  }
}

export async function runBuyerKeyBackfill(opts: BackfillOpts): Promise<BackfillResult> {
  if (opts.secret.length < 32)
    throw new Error('SUITE_BUYER_KEY_SECRET missing or shorter than 32 characters');
  const budget = Math.max(1, Math.min(opts.budget ?? 500, MAX_BUDGET));
  const cur = decodeCursor(opts.cursor);
  const stores = await d1All<{ id: string }>(
    `SELECT id FROM stores WHERE deleted_at IS NULL AND storage_backend = 'do' ${opts.storeId ? 'AND id = ?2' : ''} AND id >= ?1 ORDER BY id`,
    cur?.s ?? '',
    ...(opts.storeId ? [opts.storeId] : [])
  );
  const reports: BackfillStoreReport[] = [];
  let left = budget;
  let nextCursor: string | null = null;
  for (const { id } of stores) {
    if (left <= 0) {
      nextCursor = encodeCursor({ s: id, o: null });
      break;
    }
    const { report, lastOrder } = await backfillStore(
      id,
      cur?.s === id ? cur.o : null,
      opts.secret,
      opts.dryRun,
      left
    );
    reports.push(report);
    left -= report.scanned;
    if (!report.done) {
      nextCursor = encodeCursor({ s: id, o: lastOrder });
      break;
    }
  }
  const totals = reports.reduce(
    (t, r) => ({
      scanned: t.scanned + r.scanned,
      keyed: t.keyed + r.keyed,
      noPhone: t.noPhone + r.noPhone,
      openUnkeyed: t.openUnkeyed + r.openUnkeyed,
      openUnkeyedNoPhone: t.openUnkeyedNoPhone + r.openUnkeyedNoPhone,
      skippedStores: t.skippedStores + (r.skipped ? 1 : 0),
    }),
    { scanned: 0, keyed: 0, noPhone: 0, openUnkeyed: 0, openUnkeyedNoPhone: 0, skippedStores: 0 }
  );
  const failed = reports
    .filter(r => r.skipped === 'error')
    .map(r => ({ storeId: r.storeId, code: r.errorCode ?? 'unknown' }));
  return { dryRun: opts.dryRun, stores: reports, totals, failed, nextCursor };
}
