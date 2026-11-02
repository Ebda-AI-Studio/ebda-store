/**
 * Store closure inside the StoreDO (Ruling NZ-D15). Deleting a store NEVER wipes its Durable Object: payments, refunds and fiscal
 * documents there are legal records. A deletion instead
 *   1. refuses while money is in flight, checked AGAINST THE DO (Postgres is stale for a DO store), then
 *   2. CLOSES the DO: a `do_flags.closed = 1` flag that every write entry point refuses (410 STORE_CLOSED). Reads and the export /
 *      backup tooling keep working; nothing is deleted. A physical purge is a separate retention job (plan N-24), not built here.
 */
import type { SyncSql } from './sync-sql';

export interface DoMoneyInFlight {
  paidUndelivered: number;
  awaitingTransferConfirmation: number;
  openReturns: number;
  codOutstanding: number;
  paymentsInDispute: number;
  unsettledPayouts: number;
  walletBalances: number;
}

const n = (db: SyncSql, sql: string): number =>
  Number((db.all(sql, [])[0] as { n?: number } | undefined)?.n ?? 0);

/** Same predicates as the Postgres `moneyInFlight` (services/store-closure.service.ts) plus payouts and wallet balances. */
export function moneyInFlightOnDo(db: SyncSql): DoMoneyInFlight {
  return {
    paidUndelivered: n(
      db,
      `SELECT count(*) AS n FROM orders WHERE payment_status = 'paid' AND status NOT IN ('delivered', 'cancelled', 'refunded')`
    ),
    awaitingTransferConfirmation: n(
      db,
      `SELECT count(*) AS n FROM orders WHERE status = 'awaiting_payment_confirmation'`
    ),
    openReturns: n(
      db,
      `SELECT count(*) AS n FROM returns WHERE status IN ('pending', 'approved', 'shipped', 'received', 'inspecting')`
    ),
    codOutstanding: n(
      db,
      `SELECT count(*) AS n FROM shipments s JOIN orders o ON o.id = s.order_id
        WHERE s.cod_amount > 0
          AND (s.status NOT IN ('delivered', 'cancelled', 'returned') OR (s.status = 'delivered' AND o.payment_status <> 'paid'))`
    ),
    paymentsInDispute: n(
      db,
      `SELECT count(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status IN ('processing', 'disputed')`
    ),
    unsettledPayouts: n(
      db,
      `SELECT count(*) AS n FROM affiliate_payouts WHERE status IN ('pending', 'processing')`
    ),
    walletBalances: n(db, `SELECT count(*) AS n FROM customer_wallets WHERE balance > 0`),
  };
}

export const totalInFlight = (f: DoMoneyInFlight): number =>
  Object.values(f).reduce((a, v) => a + v, 0);

export function isStoreClosed(db: SyncSql): boolean {
  try {
    return db
      .all(`SELECT value FROM do_flags WHERE name = 'closed'`, [])
      .some(r => Number(r.value) === 1);
  } catch {
    return false; // a DO with no do_flags table has never been closed
  }
}

/** Idempotent. Writes ONE flag row; deletes nothing. */
export function closeStore(db: SyncSql): void {
  db.run(
    `INSERT INTO do_flags (name, value) VALUES ('closed', 1) ON CONFLICT (name) DO UPDATE SET value = 1`,
    []
  );
}

export type CloseResult =
  | { closed: true; transitioned: boolean }
  | { refused: true; counts: DoMoneyInFlight };

/**
 * ATOMIC gate + close (Ruling NZ-D17). The check and the flag write are ONE `transactionSync` section of the single-threaded DO, so an
 * order or payment cannot start between them: it lands before (the check sees it and the close is REFUSED) or after (the write sees
 * `closed` and is refused 410), never both. `transitioned` is true only when THIS call moved the store from open to closed, so a
 * compensating `reopenAfterFailedDelete` clears only the flag it set (a store closed earlier stays closed).
 */
export function closeIfNoMoneyInFlight(db: SyncSql): CloseResult {
  return db.transactionSync(() => {
    if (isStoreClosed(db)) return { closed: true as const, transitioned: false };
    const counts = moneyInFlightOnDo(db);
    if (totalInFlight(counts) > 0) return { refused: true as const, counts };
    closeStore(db);
    db.run(
      `INSERT INTO do_flags (name, value) VALUES ('closed_by_delete', 1) ON CONFLICT (name) DO UPDATE SET value = 1`,
      []
    );
    return { closed: true as const, transitioned: true };
  });
}

/** Compensating rollback of `closeIfNoMoneyInFlight`: clears the two flags it set, and ONLY if it set them. */
export function reopenAfterFailedDelete(db: SyncSql): { reopened: boolean } {
  return db.transactionSync(() => {
    const mine = db
      .all(`SELECT value FROM do_flags WHERE name = 'closed_by_delete'`, [])
      .some(r => Number(r.value) === 1);
    if (!mine) return { reopened: false };
    db.run(`DELETE FROM do_flags WHERE name IN ('closed', 'closed_by_delete')`, []);
    return { reopened: true };
  });
}
