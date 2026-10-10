/**
 * Stock-hold abuse fix — caps how many OPEN (pending / awaiting-confirmation,
 * unpaid) orders the same phone, email or IP can accumulate for a payment
 * method that never captures payment synchronously at creation.
 *
 * THE GAP THIS CLOSES
 * --------------------
 * `OrderService.create` reserves stock atomically for EVERY payment method,
 * including guest checkout (no signup-abuse checks apply to shoppers, only to
 * merchant signup). A real-time gateway (Kashier/Paymob) redirects straight to
 * capture and, if abandoned, is swept up by the 2-day `order-auto-cancel-unpaid`
 * cron like any other stale pending order. Two methods are NOT bounded that way:
 *
 *   - COD is deliberately EXCLUDED from that cron (ruling MONEYB-7 — a COD
 *     order isn't "unpaid" the same way a gateway order is, the shopper pays
 *     the courier). That means a COD hold can sit open indefinitely with zero
 *     payment and zero verification.
 *   - InstaPay sets its own confirmation window (`INSTAPAY_DEFAULT_EXPIRY_HOURS`)
 *     with no check against the caller's OTHER open holds before accepting a
 *     new one.
 *
 * Neither path has ever capped the COUNT of concurrent open holds — only how
 * long one lives. This module adds that cap without touching either expiry
 * mechanism: it is a pure "how many right now", checked once up front.
 *
 * SCOPE
 * -----
 * Only `cod` and `instapay` are capped. A captured payment (Kashier/Paymob
 * success, or an order already `paid` via wallet) is excluded on purpose —
 * the customer has already paid, so there is no abuse vector to bound.
 *
 * `storeId`/`paymentStatus`/`status` use the SAME "open hold" definition the
 * auto-cancel cron uses for its own query — status `pending` (COD, and
 * InstaPay before `initiate`) or `awaiting_payment_confirmation` (InstaPay
 * after `initiate`), `paymentStatus: 'unpaid'`, not soft-deleted.
 */
import type { Prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

/** Payment methods whose order-creation hold has no synchronous capture. */
export const HOLD_CAPPED_PAYMENT_METHODS: ReadonlySet<string> = new Set(['cod', 'instapay']);

const DEFAULT_OPEN_UNPAID_HOLD_CAP = 2;

/** Configurable without a redeploy — `OPEN_UNPAID_HOLD_CAP` env var, default 2. */
export function openUnpaidHoldCap(): number {
  const raw = Number(process.env.OPEN_UNPAID_HOLD_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_OPEN_UNPAID_HOLD_CAP;
}

/** Minimal shape this module needs from a Prisma client/transaction client. */
export interface HoldCapTx {
  order: {
    count(args: { where: Prisma.OrderWhereInput }): Promise<number>;
  };
}

export interface HoldCapIdentity {
  /** Already-normalized phone (same form `normalizePhoneForStorage` writes). */
  phone?: string | null;
  /** Lowercased or as-typed — matched verbatim against the stored JSON value,
   *  same convention as the existing per-user coupon-limit check. */
  email?: string | null;
  /** Server-observed client IP, normalized via `ipKeyGenerator` — never
   *  client-supplied. */
  ip?: string | null;
}

/**
 * Reject a new order (429) once the caller already has `openUnpaidHoldCap()`
 * open holds on this store for a capped payment method. A no-op for every
 * other payment method, and a no-op when the caller supplied NEITHER a phone
 * NOR an email NOR an IP — a false block on an unidentifiable guest is worse
 * than the narrow loophole (same tradeoff the per-user coupon-limit check
 * ahead of it in `OrderService.create` already makes).
 *
 * Call BEFORE the stock-reserving transaction: this is an anti-abuse gate,
 * not a money invariant, so it deliberately does not need the same
 * transactional atomicity as the inventory decrement — a rare race between
 * two concurrent requests from the same abuser is an acceptable residual.
 */
export async function assertStockHoldCapNotExceeded(
  tx: HoldCapTx,
  storeId: string,
  paymentMethod: string,
  identity: HoldCapIdentity
): Promise<void> {
  if (!HOLD_CAPPED_PAYMENT_METHODS.has(paymentMethod)) return;

  const or: Prisma.OrderWhereInput[] = [];
  if (identity.phone) {
    or.push({ shippingAddress: { path: ['phone'], equals: identity.phone } });
  }
  if (identity.email) {
    or.push({ shippingAddress: { path: ['email'], equals: identity.email } });
  }
  if (identity.ip) {
    or.push({ checkoutIp: identity.ip });
  }
  if (or.length === 0) return;

  const openCount = await tx.order.count({
    where: {
      storeId,
      status: { in: ['pending', 'awaiting_payment_confirmation'] },
      paymentStatus: 'unpaid',
      deletedAt: null,
      OR: or,
    },
  });

  if (openCount >= openUnpaidHoldCap()) {
    throw new AppError(
      429,
      'TOO_MANY_OPEN_HOLDS',
      'You have too many orders awaiting payment. Please complete or cancel an existing order before placing a new one.'
    );
  }
}
