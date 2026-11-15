/**
 * ONE predicate for "may this store still talk to its customers or move money out?" (Ruling SUSPEND-OUT-1).
 *
 * A store whose status is not `active` (suspended for a missed renewal / AUP, or inactive) must not trigger
 * customer-facing outbound messages (marketing, cart recovery, newsletters, order-status SMS / push / WhatsApp /
 * email) or money-OUT (payouts, affiliate payouts). KEPT ALLOWED on purpose: refunds to customers (and the
 * refund-processed notice), transactional mail to the merchant themself, data export, and the appeal / support routes.
 *
 * The read goes through `lookupStore` (D1 primary / the definer), NEVER the cached directory: a send is a write path,
 * so a just-suspended store must stop on the very next send (staleness class NEVER-stale, see store-directory.ts).
 * The public reads and the jobs already filter on `active` (`store-helpers.ts`, `storeActiveForJob`); this closes the
 * sends that were left open.
 */
import { AppError } from '../middleware/error-handler';
import { storeDirectory } from '@ebda/database';
import { lookupStore } from './definer';
import logger from './logger';

const STORE_NOT_OPERATIONAL = 'STORE_NOT_OPERATIONAL';

const MESSAGE_EN =
  'This store is suspended, so Ebda AI Studio has paused messages to customers and payouts. Contact support to get it reactivated.';

/** Pure: the status a store must have to message customers / pay out. */
export function isStoreOperational(status: string | null | undefined): boolean {
  return status === 'active';
}

/**
 * Ruling SUSPEND-OUT-1b: money was taken for the order, so its RECEIPT (payment-success mail, customer invoice) is still
 * sent for a suspended store. Paid = `completed`, `partially_refunded` or `disputed` (taken, then contested); COD-pending,
 * pending, failed and refunded are not.
 */
export function isPaidForReceipt(paymentStatus: string | null | undefined): boolean {
  return (
    paymentStatus === 'completed' ||
    paymentStatus === 'partially_refunded' ||
    paymentStatus === 'disputed'
  );
}

/** May this store send to customers / pay out right now? Unknown or soft-deleted = no. A lookup failure throws (a retry beats a wrong send). */
export async function storeOperational(storeId: string): Promise<boolean> {
  const hit = await lookupStore({ id: storeId }, ['active']);
  return !!hit && isStoreOperational(hit.status);
}

/** The ids of every operational store, for a sweep that walks all stores (one directory read per run, not one lookup per store). */
export async function activeStoreIds(): Promise<Set<string>> {
  return new Set((await storeDirectory(s => isStoreOperational(s.status))).map(s => s.id));
}

/** For a sender that must SKIP quietly (a job, a dispatcher): false = do not send. Logs once at debug. */
export async function storeMayMessageCustomers(storeId: string, what: string): Promise<boolean> {
  const ok = await storeOperational(storeId);
  if (!ok) logger.debug({ storeId, what }, '[store-operational] store not active; not sending');
  return ok;
}

/** For an admin action that must REFUSE: 423 with a code + EN/AR copy the admin UI shows. */
export async function assertStoreOperational(storeId: string): Promise<void> {
  if (await storeOperational(storeId)) return;
  throw new AppError(423, STORE_NOT_OPERATIONAL, MESSAGE_EN, {
    messageEn: MESSAGE_EN,
    messageAr:
      'المتجر ده موقوف، فـ إبدأ وقفت الرسايل للعملاء والمدفوعات. كلّم الدعم عشان نفعّله تاني.',
  });
}
