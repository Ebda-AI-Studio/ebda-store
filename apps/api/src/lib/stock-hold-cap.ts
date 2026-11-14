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
 * after `initiate`), `paymentStatus` unpaid or failed, not soft-deleted.
 */
import { AppError } from '../middleware/error-handler';

/**
 * Order payment states that still HOLD stock: `unpaid`, and `failed` (a declined payment keeps its units and stays
 * payable for a retry, so nothing else releases it; Ruling INV-AUDIT-2). The auto-cancel sweep selects these and the
 * cap's raw SQL below counts them; the Durable Object's checkout `OPEN` predicate is the same list.
 */
export const OPEN_HOLD_PAYMENT_STATUSES = ['unpaid', 'failed'] as const;

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

/**
 * Looser identity cap for every OTHER method label (gateway checkouts, or any
 * string a client invents: `paymentMethod` is a free string at order creation).
 * Orders carry no persisted payment method, so before this cap existed an
 * attacker declared `paymentMethod: "card"`, skipped the COD/InstaPay cap, never
 * opened the gateway, and pinned stock for the whole AUTO_CANCEL_UNPAID_DAYS
 * window (ruling S4-1). It is looser than the manual cap because a shopper
 * whose card fails legitimately retries with a fresh order (ruling
 * PR65-MANUAL-CONVERSION). `OPEN_UNPAID_GATEWAY_HOLD_CAP`, default 5.
 */
const DEFAULT_OPEN_UNPAID_GATEWAY_HOLD_CAP = 5;
export function openUnpaidGatewayHoldCap(): number {
  const raw = Number(process.env.OPEN_UNPAID_GATEWAY_HOLD_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_OPEN_UNPAID_GATEWAY_HOLD_CAP;
}

/**
 * QA-HOLDS-1 (2026-11-03). The IP ceiling was identity cap x 4 = 8 forever: a QA run of ~8 COD orders from one egress IP
 * was refused with TOO_MANY_OPEN_HOLDS, and a real office or an Egyptian mobile carrier (CGNAT shares ONE IPv4 across
 * thousands of subscribers) would hit the same wall. The identity cap (per phone/email) is what bounds one buyer pinning
 * stock; the IP signal only has to bound ONE ABUSER who rotates phone/email, so it is now
 *   - much higher: `DEFAULT_MANUAL_IP_CAP` = 40 for COD/InstaPay, and
 *   - rate-shaped: only holds created inside the last `openUnpaidHoldIpWindowHours()` (default 24 h) count, so a merchant
 *     who has not yet confirmed yesterday's COD orders never blocks today's honest buyers on the same NAT. (A COD hold
 *     counts only while it is `pending`; the moment the merchant confirms it, it stops counting at all.)
 * Per store both caps can be tuned in `Store.settings.stockHoldCaps` (`resolveStoreHoldCaps`), bounded so a merchant
 * cannot switch the protection off.
 */
const DEFAULT_MANUAL_IP_CAP = 40;
const DEFAULT_IP_WINDOW_HOURS = 24;
const MAX_IP_WINDOW_HOURS = 24 * 7;

/** `OPEN_UNPAID_HOLD_IP_CAP` env var, default 40 (COD/InstaPay). */
export function openUnpaidHoldIpCap(): number {
  const raw = Number(process.env.OPEN_UNPAID_HOLD_IP_CAP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MANUAL_IP_CAP;
}

/** `OPEN_UNPAID_HOLD_IP_WINDOW_HOURS` env var, default 24: how far back an unpaid hold still counts toward the IP cap. */
export function openUnpaidHoldIpWindowHours(): number {
  const raw = Number(process.env.OPEN_UNPAID_HOLD_IP_WINDOW_HOURS);
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_IP_WINDOW_HOURS
    ? raw
    : DEFAULT_IP_WINDOW_HOURS;
}

export interface ResolvedHoldCaps {
  /** per phone/email, COD + InstaPay */
  manual: number;
  /** per phone/email, any other payment label */
  gateway: number;
  /** per checkout IP, COD + InstaPay (gateway labels use identity cap x 4) */
  ip: number;
  /** hours an unpaid hold keeps counting toward the IP cap */
  ipWindowHours: number;
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

/**
 * The effective caps for one store: `Store.settings.stockHoldCaps` (`{ manual?, gateway?, ip?, ipWindowHours? }`) over the
 * env/default values. Every value is range-checked; anything outside its range is ignored (the safe default stands), so
 * the protection cannot be configured away: identity 1..10, gateway 1..20, ip 5..500, window 1..168 hours.
 * Reads the store row the checkout already loads, so it costs no query.
 */
export function resolveStoreHoldCaps(settings: unknown): ResolvedHoldCaps {
  const raw =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).stockHoldCaps as Record<string, unknown> | undefined)
      : undefined;
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    manual: intIn(o.manual, 1, 10) ?? openUnpaidHoldCap(),
    gateway: intIn(o.gateway, 1, 20) ?? openUnpaidGatewayHoldCap(),
    ip: intIn(o.ip, 5, 500) ?? openUnpaidHoldIpCap(),
    ipWindowHours: intIn(o.ipWindowHours, 1, MAX_IP_WINDOW_HOURS) ?? openUnpaidHoldIpWindowHours(),
  };
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
 * on this store: `openUnpaidHoldCap()` (COD/InstaPay) or
 * `openUnpaidGatewayHoldCap()` (any other method label) matched by phone OR
 * email, or the separately-tolerant IP cap (4x) matched by IP, including when
 * contact identity is present. A no-op when the caller supplied NEITHER a
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
  identity: HoldCapIdentity,
  caps: ResolvedHoldCaps = resolveStoreHoldCaps(null)
): Promise<void> {
  // Every method is counted (ruling S4-1); the manual methods get the tight cap,
  // everything else the looser gateway cap. Full-wallet orders never get here.
  const manual = HOLD_CAPPED_PAYMENT_METHODS.has(paymentMethod);
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
         AND "payment_status" IN ('unpaid', 'failed') AND "deleted_at" IS NULL
         AND ((${phone}::text IS NOT NULL AND "shipping_address" #>> '{phone}' = ${phone})
           OR (${email}::text IS NOT NULL AND lower(btrim("shipping_address" #>> '{email}')) = ${email}))
      ) AS phone_or_email_count,
      (SELECT COUNT(*) FROM "orders"
       WHERE "store_id" = ${storeId}
         AND "status" IN ('pending', 'awaiting_payment_confirmation')
         AND "payment_status" IN ('unpaid', 'failed') AND "deleted_at" IS NULL
         AND ${ip}::text IS NOT NULL AND "checkout_ip" = ${ip}
         AND "created_at" >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${caps.ipWindowHours}::int)
      ) AS ip_count
  `;
  const { phone_or_email_count, ip_count } = rows[0] ?? {
    phone_or_email_count: 0n,
    ip_count: 0n,
  };

  const identityCap = manual ? caps.manual : caps.gateway;
  const ipCap = manual ? caps.ip : identityCap * DEFAULT_OPEN_UNPAID_HOLD_IP_MULTIPLIER;
  const identityHit = Number(phone_or_email_count) >= identityCap;
  if (identityHit || Number(ip_count) >= ipCap) {
    // Two different refusals: this BUYER has open orders (finish or cancel one), or this NETWORK has placed many in the
    // last day (an office / carrier NAT). Both stay 429 TOO_MANY_OPEN_HOLDS; the Arabic text in details says which.
    throw new AppError(
      429,
      'TOO_MANY_OPEN_HOLDS',
      identityHit
        ? 'You have too many orders awaiting payment. Please complete or cancel an existing order before placing a new one.'
        : 'Too many orders were placed from your network recently. Please try again later, or contact the store to confirm your order.',
      identityHit
        ? {
            messageAr:
              'عندك طلبات كتير لسه مستنية. كمّل طلب منهم أو الغي واحد قبل ما تعمل طلب جديد.',
          }
        : {
            messageAr:
              'اتعمل طلبات كتير من نفس الشبكة في آخر فترة. جرّب كمان شوية، أو كلّم المتجر عشان يأكد طلبك.',
          }
    );
  }
}
