/**
 * Owner-assistant RPC for Ebda Chat's Smart Layer: two methods on `WhatsAppBridge` (not shopper-facing, unlike the commerce RPC beside them).
 *   - `getTopProducts`  READ, owner or ACTIVE staff: best sellers of a period from the same analytics the admin dashboard uses (AnalyticsService.getTopProducts).
 *   - `createCoupon`    WRITE, OWNER ONLY: creates a percentage / fixed coupon through CouponService.create (no coupon logic is duplicated here beyond the guard rails).
 *   - `getOrdersSummary` READ, OWNER ONLY: order count, collected sales, refunds and average order value for today / yesterday / this week / last 7 days / this month
 *     (Ruling CHAT-ASSIST-ORDERS-1). Same revenue population as the dashboard (lib/revenue-sql.ts); "collected" = payment paid OR a delivered cash-on-delivery order (CHIP-COD-DELIVERED-1).
 * Authorised by the CALLING USER against the LIVE membership (never a token claim), like listStoreMembers; the tenant is `storeId` only, resolved and linked
 * BEFORE anything is read. Expected failures are data (`{ ok: false, reason, code }`), the envelope ebda-whatsapp's `bridgeResultSchema` parses; an unexpected
 * error rethrows and the caller turns it into `unavailable`. Pure over `OwnerToolsPorts`, so tests run the same logic against fakes.
 *
 * Rulings: CHAT-ASSIST-TOP-1 (rolling windows, "today" = since Cairo midnight, numbers only from analytics), CHAT-ASSIST-COUPON-1 (percent 1-90, fixed <= MAX_FIXED_MINOR,
 * window <= 90 days, usage limit <= 100000, replay-safe on code + recency; the Chat tool ALWAYS shows the merchant a preview and waits for the press before this runs).
 * STALENESS: top products and coupons are live reads / writes, nothing is cached; the orders summary is BOUNDED-stale: cached per store + period for 60 s per isolate (the residual window is
 * that minute; the role and the link are re-checked on every call, only the figures are reused); the per-store token bucket below is BOUNDED-stale (per isolate) and only sheds a runaway caller.
 */
import { z } from 'zod/v3';
import { args as bridgeArgs } from './schemas';
import {
  NON_REVENUE_ORDER_STATUSES,
  NON_REVENUE_PAYMENT_STATUSES,
  netOrderRevenueMinor,
} from '../../revenue-sql';

/** Pinned against ebda-whatsapp's COUPON_LIMITS (src/core/store-bridge.ts) by a test in each repo: change both together. */
// pq-allow(unused-export): contract pin, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const MAX_PERCENT = 90;
// pq-allow(unused-export): contract pin, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const MAX_FIXED_MINOR = 5_000_000; // 50,000 EGP
// pq-allow(unused-export): contract pin, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const MAX_WINDOW_DAYS = 90;
// pq-allow(unused-export): contract pin, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const MAX_USAGE_LIMIT = 100_000;
const REPLAY_WINDOW_MS = 15 * 60_000;

type OwnerFailure = 'not_found' | 'not_linked' | 'invalid' | 'unavailable';
type OwnerResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: OwnerFailure; code?: string; message?: string };
const fail = (reason: OwnerFailure, code?: string, message?: string): OwnerResult<never> => ({
  ok: false,
  reason,
  ...(code ? { code } : {}),
  ...(message ? { message } : {}),
});

const topProductsArgs = z.object({
  period: z.enum(['today', '7d', '30d']),
  limit: z.number().int().min(1).max(10),
});
type TopProductsArgs = z.infer<typeof topProductsArgs>;
// pq-allow(unused-export): named by the emitted declarations of ownerTools (index.ts) and the worker RPC getTopProducts (TS4023/TS4053 without it)
export interface TopProductsValue {
  currency: string;
  period: 'today' | '7d' | '30d';
  fromMs: number;
  toMs: number;
  items: Array<{ name: string; nameAr: string | null; units: number; revenueMinor: number }>;
}

const ordersSummaryArgs = z.object({
  period: z.enum(['today', 'yesterday', 'this_week', 'last_7_days', 'this_month']),
});
type OrdersPeriod = z.infer<typeof ordersSummaryArgs>['period'];
// pq-allow(unused-export): named by the emitted declarations of ownerTools (index.ts) and the worker RPC getOrdersSummary (TS4023/TS4053 without it)
export interface OrdersSummaryValue {
  currency: string;
  period: OrdersPeriod;
  fromMs: number;
  toMs: number;
  /** Orders placed in the window that count as sales (the dashboard's revenue population). */
  orderCount: number;
  /** Of those, the orders whose money is collected: payment paid, or a delivered cash-on-delivery order. */
  collectedOrders: number;
  /** Net of refunds, minor units, over the collected orders. */
  salesMinor: number;
  /** Refunded minor units on the window's orders (the order page's `refundedTotal`: payment refunds + merchant partial refunds not on a payment row + completed non-gateway non-exchange returns, each once; capped at each order's total). */
  refundsMinor: number;
  /** salesMinor / collectedOrders, rounded; 0 when none. */
  avgOrderMinor: number;
}
/** One order as the summary needs it; the port derives `online` / `cod` from the payment rows and `refundedMinor` from returns + payments. */
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export interface OrderRowLite {
  total: number;
  status: string;
  paymentStatus: string;
  online: boolean;
  cod: boolean;
  refundedMinor: number;
}
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const MAX_SUMMARY_ORDERS = 20_000;
const SUMMARY_TTL_MS = 60_000;

const code = z
  .string()
  .trim()
  .min(3)
  .max(24)
  .regex(/^[A-Za-z0-9_-]+$/);
const createCouponArgs = z
  .object({
    code,
    type: z.enum(['percentage', 'fixed']),
    /** percentage: whole 1-90; fixed: piasters (integer, > 0, <= MAX_FIXED_MINOR). */
    value: z.number().int().min(1),
    /** Absolute window, or `durationDays` from creation time (exactly one end form). */
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    durationDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional(),
    usageLimit: z.number().int().min(1).max(MAX_USAGE_LIMIT).optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .refine(v => (v.endsAt !== undefined) !== (v.durationDays !== undefined), {
    message: 'exactly one of endsAt / durationDays',
  });
type CreateCouponArgs = z.infer<typeof createCouponArgs>;
// pq-allow(unused-export): named by the emitted declarations of ownerTools (index.ts) and the worker RPC createCoupon (TS4023/TS4053 without it)
export interface CreatedCoupon {
  couponId: string;
  code: string;
  type: 'percentage' | 'fixed';
  value: number;
  startsAt: string | null;
  expiresAt: string;
  usageLimit: number | null;
  replayed: boolean;
}

interface CouponRowLite {
  id: string;
  code: string;
  type: string;
  value: number;
  usageLimit: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export interface OwnerToolsPorts {
  /** The live role of the user on the store; null = not (or no longer) a member. Throws when it cannot be read. */
  memberRole(storeId: string, userId: string): Promise<'owner' | 'staff' | null>;
  /** null = the store does not resolve. */
  currency(storeId: string): Promise<string | null>;
  isLinked(storeId: string): Promise<boolean>;
  featureEnabled(storeId: string, feature: 'coupons'): Promise<boolean>;
  topProducts(
    storeId: string,
    range: { startDate: Date; endDate: Date },
    limit: number
  ): Promise<Array<{ name: string; nameAr: string | null; quantity: number; revenue: number }>>;
  /** Every non-deleted order created in the window (any status), at most `cap + 1` rows so the caller can tell it was cut. */
  ordersInWindow(
    storeId: string,
    range: { startDate: Date; endDate: Date },
    cap: number
  ): Promise<OrderRowLite[]>;
  findCoupon(storeId: string, code: string): Promise<CouponRowLite | null>;
  /** CouponService.create. Throws `{ code: 'DUPLICATE_CODE' }` when the code exists (a race the find above did not see). */
  createCoupon(
    storeId: string,
    data: {
      code: string;
      name: string;
      nameAr: string;
      type: 'percentage' | 'fixed';
      value: number;
      startsAt: Date | null;
      expiresAt: Date;
      usageLimit: number | null;
    }
  ): Promise<CouponRowLite>;
  audit(entry: {
    action: string;
    userId: string;
    storeId: string;
    resourceId: string;
    details: Record<string, unknown>;
  }): Promise<void>;
  now(): number;
}

/** Start of the current Cairo calendar day, as epoch ms. */
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export function cairoStartOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const localNowAsUtc = Date.UTC(
    g('year'),
    g('month') - 1,
    g('day'),
    g('hour'),
    g('minute'),
    g('second')
  );
  const offset = localNowAsUtc - Math.floor(ms / 1000) * 1000; // Cairo minus UTC
  return Date.UTC(g('year'), g('month') - 1, g('day')) - offset;
}

/** A tiny per-isolate token bucket per store+method (BOUNDED-stale: sheds a runaway caller, guards no money). */
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(key: string, now: number, perMin = 30): boolean {
  const b = buckets.get(key) ?? { tokens: perMin, at: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.at) / 60_000) * perMin);
  b.at = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return ok;
}
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const resetOwnerToolBuckets = () => buckets.clear();

const HOUR = 3_600_000;
const SAT_FIRST = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
/** The Cairo calendar day before the one that starts at `dayStart`. */
const dayBefore = (dayStart: number): number => cairoStartOfDay(dayStart - HOUR);
/**
 * Cairo calendar windows. The week starts on Saturday (the Egyptian week), the month on the 1st; "today", "this week" and "this month" end now,
 * "yesterday" ends at today's midnight, "last 7 days" is rolling.
 */
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export function periodWindow(period: OrdersPeriod, now: number): { fromMs: number; toMs: number } {
  const today = cairoStartOfDay(now);
  const mid = new Date(today + 12 * HOUR); // noon of the Cairo day: safe from any midnight offset edge
  const part = (opt: Intl.DateTimeFormatOptions, t: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', ...opt })
      .formatToParts(mid)
      .find(x => x.type === t)!.value;
  switch (period) {
    case 'today':
      return { fromMs: today, toMs: now };
    case 'yesterday':
      return { fromMs: dayBefore(today), toMs: today - 1 };
    case 'last_7_days':
      return { fromMs: now - 7 * 24 * HOUR, toMs: now };
    case 'this_week': {
      let from = today;
      for (let i = SAT_FIRST.indexOf(part({ weekday: 'short' }, 'weekday')); i > 0; i--)
        from = dayBefore(from);
      return { fromMs: from, toMs: now };
    }
    case 'this_month': {
      let from = today;
      for (let i = Number(part({ day: 'numeric' }, 'day')) - 1; i > 0; i--) from = dayBefore(from);
      return { fromMs: from, toMs: now };
    }
  }
}

/** The dashboard's revenue population (revenue-sql.ts) split into counted / collected, plus refunds. Pure over the rows. */
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export function summariseOrders(
  rows: readonly OrderRowLite[]
): Pick<
  OrdersSummaryValue,
  'orderCount' | 'collectedOrders' | 'salesMinor' | 'refundsMinor' | 'avgOrderMinor'
> {
  let orderCount = 0;
  let collectedOrders = 0;
  let salesMinor = 0;
  let refundsMinor = 0;
  for (const o of rows) {
    refundsMinor += Math.min(o.total, Math.max(0, o.refundedMinor));
    const net = netOrderRevenueMinor({
      total: o.total,
      status: o.status,
      paymentStatus: o.paymentStatus,
      refundedMinor: o.refundedMinor,
      hasOnlinePayment: o.online,
    });
    const counts =
      !(NON_REVENUE_ORDER_STATUSES as readonly string[]).includes(o.status) &&
      !(NON_REVENUE_PAYMENT_STATUSES as readonly string[]).includes(o.paymentStatus) &&
      !(o.paymentStatus === 'unpaid' && o.online);
    if (!counts) continue;
    orderCount += 1;
    if (o.paymentStatus === 'paid' || (o.status === 'delivered' && o.cod)) {
      collectedOrders += 1;
      salesMinor += net;
    }
  }
  return {
    orderCount,
    collectedOrders,
    salesMinor,
    refundsMinor,
    avgOrderMinor: collectedOrders > 0 ? Math.round(salesMinor / collectedOrders) : 0,
  };
}

const summaryCache = new Map<string, { at: number; value: OrdersSummaryValue }>();
// pq-allow(unused-export): test seam, imported by tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts
export const resetOrdersSummaryCache = () => summaryCache.clear();

export function createOwnerTools(ports: OwnerToolsPorts) {
  /** Store resolves + linked + the caller is a live member (roles: who may pass). Same order for both methods. */
  async function gate(
    method: string,
    storeId: unknown,
    userId: unknown,
    roles: ReadonlyArray<'owner' | 'staff'>
  ): Promise<OwnerResult<{ storeId: string; userId: string; currency: string }>> {
    const s = bridgeArgs.storeId.safeParse(storeId);
    const u = bridgeArgs.storeId.safeParse(userId); // a user id is a UUID too
    if (!s.success || !u.success) return fail('invalid', 'INVALID_ID');
    const currency = await ports.currency(s.data);
    if (currency === null) return fail('not_found');
    if (!(await ports.isLinked(s.data))) return fail('not_linked');
    const role = await ports.memberRole(s.data, u.data);
    if (!role || !roles.includes(role)) return fail('invalid', 'FORBIDDEN');
    if (!takeToken(`${method}:${s.data}`, ports.now())) return fail('unavailable', 'RATE_LIMITED');
    return { ok: true, value: { storeId: s.data, userId: u.data, currency } };
  }

  return {
    async getTopProducts(
      storeId: string,
      asUserId: string,
      raw: unknown
    ): Promise<OwnerResult<TopProductsValue>> {
      const a = topProductsArgs.safeParse(raw);
      if (!a.success) return fail('invalid', 'INVALID_ARGS', a.error.issues[0]?.path.join('.'));
      const g = await gate('getTopProducts', storeId, asUserId, ['owner', 'staff']);
      if (!g.ok) return g;
      const to = ports.now();
      const from =
        a.data.period === 'today'
          ? cairoStartOfDay(to)
          : to - (a.data.period === '7d' ? 7 : 30) * 86_400_000;
      const rows = await ports.topProducts(
        g.value.storeId,
        { startDate: new Date(from), endDate: new Date(to) },
        a.data.limit
      );
      return {
        ok: true,
        value: {
          currency: g.value.currency,
          period: a.data.period,
          fromMs: from,
          toMs: to,
          items: rows.slice(0, a.data.limit).map(r => ({
            name: r.name,
            nameAr: r.nameAr,
            units: r.quantity,
            revenueMinor: r.revenue,
          })),
        },
      };
    },

    async getOrdersSummary(
      storeId: string,
      asUserId: string,
      raw: unknown
    ): Promise<OwnerResult<OrdersSummaryValue>> {
      const a = ordersSummaryArgs.safeParse(raw);
      if (!a.success) return fail('invalid', 'INVALID_ARGS', a.error.issues[0]?.path.join('.'));
      const g = await gate('getOrdersSummary', storeId, asUserId, ['owner']);
      if (!g.ok) return g;
      const now = ports.now();
      const key = `${g.value.storeId}:${a.data.period}`;
      const hit = summaryCache.get(key);
      if (hit && now - hit.at < SUMMARY_TTL_MS && now >= hit.at)
        return { ok: true, value: hit.value };
      const w = periodWindow(a.data.period, now);
      const rows = await ports.ordersInWindow(
        g.value.storeId,
        { startDate: new Date(w.fromMs), endDate: new Date(w.toMs) },
        MAX_SUMMARY_ORDERS
      );
      // Never a partial figure: a window we could not read in full is refused, not summed.
      if (rows.length > MAX_SUMMARY_ORDERS) return fail('unavailable', 'RANGE_TOO_LARGE');
      const value: OrdersSummaryValue = {
        currency: g.value.currency,
        period: a.data.period,
        ...w,
        ...summariseOrders(rows),
      };
      if (summaryCache.size > 2000) summaryCache.clear();
      summaryCache.set(key, { at: now, value });
      return { ok: true, value };
    },

    async createCoupon(
      storeId: string,
      asUserId: string,
      raw: unknown
    ): Promise<OwnerResult<CreatedCoupon>> {
      const a = createCouponArgs.safeParse(raw);
      if (!a.success) return fail('invalid', 'INVALID_ARGS', a.error.issues[0]?.path.join('.'));
      const v = a.data;
      // Guard rails run BEFORE the member read so a bad request never costs a lookup.
      if (v.type === 'percentage' && v.value > MAX_PERCENT) return fail('invalid', 'PERCENT_RANGE');
      if (v.type === 'fixed' && v.value > MAX_FIXED_MINOR)
        return fail('invalid', 'FIXED_TOO_LARGE');
      const g = await gate('createCoupon', storeId, asUserId, ['owner']);
      if (!g.ok) return g;
      if (!(await ports.featureEnabled(g.value.storeId, 'coupons')))
        return fail('invalid', 'FEATURE_DISABLED');

      const now = ports.now();
      const start = v.startsAt ? Date.parse(v.startsAt) : null;
      const begins = start ?? now;
      const end = v.endsAt ? Date.parse(v.endsAt) : begins + v.durationDays! * 86_400_000;
      if (!(end > begins)) return fail('invalid', 'WINDOW_ORDER');
      if (end - begins > MAX_WINDOW_DAYS * 86_400_000) return fail('invalid', 'WINDOW_TOO_LONG');
      if (end <= now) return fail('invalid', 'WINDOW_PAST');

      // Same terms INCLUDING the window: an explicit start / end must match to the millisecond; a duration is judged from the existing coupon's own creation time (a retry computes
      // its end from a later "now"), within a minute. A different window under the same code is a duplicate, never a replay of the earlier window.
      const sameWindow = (c: CouponRowLite) => {
        if ((c.startsAt ? c.startsAt.getTime() : null) !== start) return false;
        if (!c.expiresAt) return false;
        return v.endsAt !== undefined
          ? c.expiresAt.getTime() === end
          : Math.abs(
              c.expiresAt.getTime() - (c.createdAt.getTime() + v.durationDays! * 86_400_000)
            ) <= 60_000;
      };
      const same = (c: CouponRowLite) =>
        c.type === v.type &&
        c.value === v.value &&
        (c.usageLimit ?? null) === (v.usageLimit ?? null) &&
        sameWindow(c);
      const view = (c: CouponRowLite, replayed: boolean): CreatedCoupon => ({
        couponId: c.id,
        code: c.code,
        type: v.type,
        value: v.value,
        startsAt: c.startsAt ? c.startsAt.toISOString() : null,
        expiresAt: (c.expiresAt ?? new Date(end)).toISOString(),
        usageLimit: c.usageLimit ?? null,
        replayed,
      });
      // Replay: the same preview retried after a crash finds its own coupon (same code, same terms, just created) and answers with it instead of a duplicate-code error.
      const existing = await ports.findCoupon(g.value.storeId, v.code);
      if (existing) {
        return same(existing) &&
          now - existing.createdAt.getTime() < REPLAY_WINDOW_MS &&
          now >= existing.createdAt.getTime()
          ? { ok: true, value: view(existing, true) }
          : fail('invalid', 'DUPLICATE_CODE');
      }
      let made: CouponRowLite;
      try {
        made = await ports.createCoupon(g.value.storeId, {
          code: v.code.toUpperCase(),
          name: v.type === 'percentage' ? `${v.value}%` : `${v.value / 100} ${g.value.currency}`,
          nameAr:
            v.type === 'percentage'
              ? `خصم ${v.value}%`
              : `خصم ${v.value / 100} ${g.value.currency}`,
          type: v.type,
          value: v.value,
          startsAt: start === null ? null : new Date(start),
          expiresAt: new Date(end),
          usageLimit: v.usageLimit ?? null,
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'DUPLICATE_CODE')
          return fail('invalid', 'DUPLICATE_CODE');
        throw e;
      }
      await ports
        .audit({
          action: 'coupon.created',
          userId: g.value.userId,
          storeId: g.value.storeId,
          resourceId: made.id,
          details: {
            via: 'ebda-chat-assistant',
            idempotencyKey: v.idempotencyKey,
            before: null,
            after: {
              code: made.code,
              type: v.type,
              value: v.value,
              startsAt: view(made, false).startsAt,
              expiresAt: view(made, false).expiresAt,
              usageLimit: v.usageLimit ?? null,
            },
          },
        })
        .catch(() => undefined); // a missing trail must not undo a coupon the merchant just approved (the Store's own coupon route behaves the same)
      return { ok: true, value: view(made, false) };
    },
  };
}
