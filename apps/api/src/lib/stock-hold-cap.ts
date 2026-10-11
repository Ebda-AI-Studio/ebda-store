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
 * mechanism: it checks "how many right now" inside the stock-reserving transaction.
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
import { AppError } from '../middleware/error-handler';

/** Payment methods whose order-creation hold has no synchronous capture. */
export const HOLD_CAPPED_PAYMENT_METHODS: ReadonlySet<string> = new Set(['cod', 'instapay']);

const DEFAULT_OPEN_UNPAID_HOLD_CAP = 2;
/**
 * IP gets its OWN, more tolerant cap (default 4x the identity cap). Egyptian
 * mobile carriers heavily share CGNAT IPv4 across unrelated subscribers, so a
 * busy COD store can have several unrelated shoppers legitimately checking
 * out from the same egress IP at once. Blocking on raw IP at the SAME
 * threshold as phone/email would 429 a genuine third shopper the moment two
 * strangers on the same carrier happen to have open orders. IP still bounds a
 * single abuser who varies or omits contact identity. It applies alongside
 * phone/email, at a looser threshold than the identity-based cap.
 */
const DEFAULT_OPEN_UNPAID_HOLD_IP_MULTIPLIER = 4;

/** Configurable without a redeploy — `OPEN_UNPAID_HOLD_CAP` env var, default 2. */
export function openUnpaidHoldCap(): number {
  const raw = Number(process.env.OPEN_UNPAID_HOLD_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_OPEN_UNPAID_HOLD_CAP;
}

/** `OPEN_UNPAID_HOLD_IP_CAP` env var, default `openUnpaidHoldCap() * 4`. */
export function openUnpaidHoldIpCap(): number {
  const raw = Number(process.env.OPEN_UNPAID_HOLD_IP_CAP);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : openUnpaidHoldCap() * DEFAULT_OPEN_UNPAID_HOLD_IP_MULTIPLIER;
}

/**
 * Minimal shape this module needs from a Prisma client/transaction client.
 * Raw SQL, not `tx.order.count({ where: { OR: [...] } })`: Prisma's JSON
 * `path`/`equals` filter on a `Json` field compiles to a `#>` (jsonb)
 * comparison, which a text-expression (`#>>`) index cannot be used to answer
 * — the ORM filter and the partial index it was meant to hit would silently
 * diverge (and re-diverge on any future Prisma query-compilation change).
 * Writing the exact expression here keeps the query provably the one the
 * migration's indexes were built for.
 */
export interface HoldCapTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface OpenHoldCountRow {
  phone_or_email_count: bigint;
  ip_count: bigint;
}

export interface HoldCapIdentity {
  /** Already-normalized phone (same form `normalizePhoneForStorage` writes). */
  phone?: string | null;
  /** Canonicalized with trim/lowercase; legacy stored values are normalized in SQL. */
  email?: string | null;
  /** Server-observed client IP, normalized via `ipKeyGenerator` — never
   *  client-supplied. */
  ip?: string | null;
}

/**
 * Reject a new order (429) once the caller already has too many open holds
 * on this store for a capped payment method: `openUnpaidHoldCap()` matched by
 * phone OR email, or the separately-tolerant `openUnpaidHoldIpCap()` matched
 * by IP, including when contact identity is present. A no-op for
 * every other payment method, and a no-op when the caller supplied NEITHER a
 * phone NOR an email NOR an IP — a false block on an unidentifiable guest is
 * worse than the narrow loophole (same tradeoff the per-user coupon-limit
 * check ahead of it in `OrderService.create` already makes).
 *
 * Call inside the stock-reserving transaction. Transaction-scoped advisory
 * locks serialize overlapping tenant identity signals; the following count
 * sees prior committed admissions under PostgreSQL READ COMMITTED. Keep these
 * locks until the order insert commits or the whole transaction rolls back.
 */
export async function assertStockHoldCapNotExceeded(
  tx: HoldCapTx,
  storeId: string,
  paymentMethod: string,
  identity: HoldCapIdentity
): Promise<void> {
  if (!HOLD_CAPPED_PAYMENT_METHODS.has(paymentMethod)) return;
  if (!identity.phone && !identity.email && !identity.ip) return;

  const phone = identity.phone || null;
  const email = identity.email?.trim().toLowerCase() || null;
  const ip = identity.ip || null;
  // Include the signal kind and tenant in an unambiguous key. Sorting every
  // signal prevents deadlocks when two requests overlap on multiple signals.
  const keys = [
    phone ? JSON.stringify(['stock-hold', storeId, 'phone', phone]) : null,
    email ? JSON.stringify(['stock-hold', storeId, 'email', email]) : null,
    ip ? JSON.stringify(['stock-hold', storeId, 'ip', ip]) : null,
  ]
    .filter((key): key is string => key !== null)
    .sort();
  for (const key of keys) {
    // executeRaw avoids decoding PostgreSQL's void return type.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  // Identity predicates belong in WHERE, so the partial expression indexes
  // can answer the count without scanning every open order in a busy store.
  const rows = await tx.$queryRaw<OpenHoldCountRow[]>`
    SELECT
      (SELECT COUNT(*) FROM "orders"
       WHERE "store_id" = ${storeId}
         AND "status" IN ('pending', 'awaiting_payment_confirmation')
         AND "payment_status" = 'unpaid' AND "deleted_at" IS NULL
         AND ((${phone}::text IS NOT NULL AND "shipping_address" #>> '{phone}' = ${phone})
           OR (${email}::text IS NOT NULL AND lower(btrim("shipping_address" #>> '{email}')) = ${email}))
      ) AS phone_or_email_count,
      (SELECT COUNT(*) FROM "orders"
       WHERE "store_id" = ${storeId}
         AND "status" IN ('pending', 'awaiting_payment_confirmation')
         AND "payment_status" = 'unpaid' AND "deleted_at" IS NULL
         AND ${ip}::text IS NOT NULL AND "checkout_ip" = ${ip}
      ) AS ip_count
  `;
  const { phone_or_email_count, ip_count } = rows[0] ?? {
    phone_or_email_count: 0n,
    ip_count: 0n,
  };

  if (
    Number(phone_or_email_count) >= openUnpaidHoldCap() ||
    Number(ip_count) >= openUnpaidHoldIpCap()
  ) {
    throw new AppError(
      429,
      'TOO_MANY_OPEN_HOLDS',
      'You have too many orders awaiting payment. Please complete or cancel an existing order before placing a new one.'
    );
  }
}
