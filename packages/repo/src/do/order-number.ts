import { MoneyError, type SyncSql } from './sync-sql';

const SUFFIX_SPACE = 36 ** 5; // 5 base36 chars: the barcode scan code (shared/barcode/scan-code.ts) maps back only below this
const TRIES = 8;

/**
 * A fresh `ORD-<base36 seconds>-<5 base36>` order number that is FREE in this store (`orders_order_number_key` is UNIQUE).
 *
 * Issue 459: the suffix alone was random, so two orders in one second could draw the same number and the INSERT died
 * with a raw UNIQUE violation (MONEY_OP_FAILED, a 500 at checkout). workerd freezes `Date.now()` inside a burst, so every
 * order of a busy second shares the prefix. The check-then-insert is safe: it runs inside the DO's single synchronous
 * money section, nothing interleaves before the caller's INSERT.
 */
export function freshOrderNumber(db: SyncSql, now: number): string {
  const secs = Math.floor(now / 1000)
    .toString(36)
    .toUpperCase();
  for (let i = 0; i < TRIES; i++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0]! % SUFFIX_SPACE;
    const num = `ORD-${secs}-${n.toString(36).toUpperCase().padStart(5, '0')}`;
    if (db.all('SELECT 1 FROM orders WHERE order_number = ? LIMIT 1', [num]).length === 0)
      return num;
  }
  // 8 straight hits in a 60M space means a broken random source, not traffic: refuse cleanly, nothing written
  throw new MoneyError('ORDER_NUMBER_UNAVAILABLE', 'could not allocate an order number', 503);
}
