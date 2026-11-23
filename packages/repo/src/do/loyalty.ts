import { MoneyError, type SyncSql } from './sync-sql';

/**
 * Loyalty on the StoreDO (port of apps/api/src/services/loyalty.service.ts as it touches an ORDER). Pure synchronous
 * functions over `SyncSql`; run them inside the caller's `transactionSync` (each also opens its own, which nests as a
 * savepoint). Every query names `store_id`. Money is integer piastres; points are integers.
 *
 * Idempotency, all enforced IN the data (single-threaded DO + the migration's partial unique indexes):
 *   earn      one `earn_purchase` row per (store, order)  [loyalty_transactions_earn_purchase_unique]
 *   redeem    one `redeem_discount` row per (store, order) (pre-checked: the migration has no index for it)
 *   reversals one tagged `adjust` row per original row    [loyalty_transactions_reversal_tag_unique]
 * The balance can never go negative: a debit is ONE conditional UPDATE (`points >= ?`).
 *
 * NOT ported (documented): the platform `loyalty` feature flag is resolved by the caller and passed as
 * `featureEnabled` (fail closed: only `true` enables); signup/referral/review/birthday/manual bonus awards, tier
 * recalculation outside an order, point expiry jobs (none of them touch an order).
 */

export interface LoyaltySettings {
  pointsPerMajorUnit: number;
  signupBonus: number;
  referralBonus: number;
  reviewBonus: number;
  birthdayBonus: number;
  tiers: {
    bronze: { minPoints: number; multiplier: number };
    silver: { minPoints: number; multiplier: number };
    gold: { minPoints: number; multiplier: number };
    platinum: { minPoints: number; multiplier: number };
  };
  pointsValue: number;
  minRedeemPoints: number;
  maxRedeemPercentage: number;
  expirationMonths: number;
}

/** Copied from the original. */
export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  pointsPerMajorUnit: 1,
  signupBonus: 100,
  referralBonus: 200,
  reviewBonus: 50,
  birthdayBonus: 500,
  tiers: {
    bronze: { minPoints: 0, multiplier: 1.0 },
    silver: { minPoints: 1000, multiplier: 1.25 },
    gold: { minPoints: 5000, multiplier: 1.5 },
    platinum: { minPoints: 15000, multiplier: 2.0 },
  },
  pointsValue: 1,
  minRedeemPoints: 500,
  maxRedeemPercentage: 50,
  expirationMonths: 12,
};

const TIERS = ['bronze', 'silver', 'gold', 'platinum'] as const;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_POINTS = 100_000_000;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * `{...DEFAULT, ...stored}` exactly like the original (a shallow merge), then HARDENED: a stored value that is not a
 * finite number (or a tier ladder that is incomplete) falls back to the default instead of poisoning the maths with NaN.
 * For valid settings the result is identical to the original.
 */
export function mergeSettings(stored: unknown): LoyaltySettings {
  const s: Record<string, unknown> =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const out: LoyaltySettings = { ...DEFAULT_LOYALTY_SETTINGS, ...(s as Partial<LoyaltySettings>) };
  for (const k of [
    'pointsPerMajorUnit',
    'signupBonus',
    'referralBonus',
    'reviewBonus',
    'birthdayBonus',
    'pointsValue',
    'minRedeemPoints',
    'maxRedeemPercentage',
    'expirationMonths',
  ] as const) {
    if (!finite(out[k])) out[k] = DEFAULT_LOYALTY_SETTINGS[k];
  }
  const t = (s.tiers ?? null) as Record<
    string,
    { minPoints?: unknown; multiplier?: unknown }
  > | null;
  const tiersOk =
    t !== null &&
    typeof t === 'object' &&
    TIERS.every(
      n => finite(t[n]?.minPoints) && finite(t[n]?.multiplier) && (t[n].multiplier as number) >= 0
    );
  if (!tiersOk) out.tiers = DEFAULT_LOYALTY_SETTINGS.tiers;
  return out;
}

/** Highest tier whose minPoints <= totalEarned (the original `calculateTier`). */
export function calculateTier(totalEarned: number, settings: LoyaltySettings): string {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (totalEarned >= settings.tiers[TIERS[i]].minPoints) return TIERS[i];
  }
  return 'bronze';
}

/** The original `getTierInfo` multiplier lookup (tier by totalEarned). */
export function tierMultiplier(totalEarned: number, settings: LoyaltySettings): number {
  return settings.tiers[calculateTier(totalEarned, settings) as (typeof TIERS)[number]].multiplier;
}

/**
 * Points for an order: `floor(floor(total/100 * pointsPerMajorUnit) * tierMultiplier)`. Float arithmetic in the same
 * order as the original (`fromMinor` = minor / 100, EGP), so the rounding is byte-identical.
 */
export function computeEarnPoints(
  orderTotalPiastres: number,
  settings: LoyaltySettings,
  totalEarnedBefore: number
): number {
  const multiplier = tierMultiplier(totalEarnedBefore, settings);
  const basePoints = Math.floor((orderTotalPiastres / 100) * settings.pointsPerMajorUnit);
  return Math.floor(basePoints * multiplier);
}

export interface RedemptionQuote {
  pointsToRedeem: number;
  discountFils: number;
  applied: boolean;
}

/** Pure redemption maths, copied verbatim from the original `computeRedemption`. */
export function computeRedemption(
  settings: LoyaltySettings,
  requestedPoints: number,
  subtotalFils: number,
  availablePoints: number
): RedemptionQuote {
  const none: RedemptionQuote = { pointsToRedeem: 0, discountFils: 0, applied: false };

  if (!Number.isFinite(requestedPoints) || requestedPoints <= 0) return none;
  if (subtotalFils <= 0) return none;

  const pointsValue = Math.max(1, Math.floor(settings.pointsValue || 1));

  let points = Math.min(Math.floor(requestedPoints), Math.max(0, Math.floor(availablePoints)));

  if (points < settings.minRedeemPoints) return none;

  const pct = Math.min(100, Math.max(0, settings.maxRedeemPercentage ?? 100));
  const pctCapFils = Math.floor((subtotalFils * pct) / 100);
  const maxDiscountFils = Math.min(subtotalFils, pctCapFils);

  let discountFils = points * pointsValue;
  if (discountFils > maxDiscountFils) {
    points = Math.floor(maxDiscountFils / pointsValue);
    discountFils = points * pointsValue;
  }

  if (points < settings.minRedeemPoints || points <= 0 || discountFils <= 0) return none;

  return { pointsToRedeem: points, discountFils, applied: true };
}

// ---------------------------------------------------------------- reads

function requireId(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200)
    throw new MoneyError('BAD_ID', `${name} is required`, 400);
  return v;
}

function requireOrder(db: SyncSql, storeId: string, orderId: string) {
  const o = db.all(
    'SELECT id, customer_id, subtotal, total FROM orders WHERE id = ?1 AND store_id = ?2',
    [orderId, storeId]
  )[0];
  if (!o) throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);
  return o as { id: string; customer_id: string | null; subtotal: number; total: number };
}

/** Store loyalty switches. `null` when the store has no config row. */
export function loadLoyaltyConfig(
  db: SyncSql,
  storeId: string
): { enabled: boolean; settings: LoyaltySettings } | null {
  requireId(storeId, 'storeId');
  const r = db.all(
    'SELECT loyalty_enabled, loyalty_settings FROM store_config WHERE store_id = ?',
    [storeId]
  )[0];
  if (!r) return null;
  let parsed: unknown = {};
  try {
    parsed = JSON.parse((r.loyalty_settings as string) ?? '{}');
  } catch {
    parsed = {};
  }
  return { enabled: r.loyalty_enabled === 1, settings: mergeSettings(parsed) };
}

/**
 * Original `getRedeemableContext`: `null` when loyalty is off (store switch or platform feature) or the customer has
 * no points row.
 */
export function getRedeemableContext(
  db: SyncSql,
  a: { storeId: string; customerId: string; featureEnabled: boolean }
): { settings: LoyaltySettings; availablePoints: number } | null {
  requireId(a.customerId, 'customerId');
  const cfg = loadLoyaltyConfig(db, a.storeId);
  if (!cfg || !cfg.enabled || a.featureEnabled !== true) return null;
  const row = db.all('SELECT points FROM loyalty_points WHERE store_id = ? AND customer_id = ?', [
    a.storeId,
    a.customerId,
  ])[0];
  if (!row) return null;
  return { settings: cfg.settings, availablePoints: row.points as number };
}

/** Server-side quote: the client sends only a REQUESTED point count; this decides what is redeemable. */
export function quoteRedemption(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    requestedPoints: number;
    subtotal: number;
    featureEnabled: boolean;
  }
): RedemptionQuote {
  const ctx = getRedeemableContext(db, a);
  if (!ctx) return { pointsToRedeem: 0, discountFils: 0, applied: false };
  return computeRedemption(ctx.settings, a.requestedPoints, a.subtotal, ctx.availablePoints);
}

// ---------------------------------------------------------------- redeem

export interface RedeemResult {
  pointsRedeemed: number;
  discountFils: number;
  newBalance: number;
  replayed: boolean;
}

/**
 * Burn `points` for the order's loyalty discount. The order is read from its row (subtotal is never client-sent) and
 * must belong to this store AND this customer. `points` must be exactly what the server-side quote allows (so a
 * caller cannot over-redeem past the cap); the debit is ONE conditional UPDATE so the balance cannot go negative.
 * Records `orders.loyalty_points_redeemed` / `loyalty_discount` (the checkout recomputes the order total from them).
 * A second call for the same order is a replay: no second debit.
 */
export function redeemPoints(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    orderId: string;
    points: number;
    featureEnabled: boolean;
    now?: number;
  }
): RedeemResult {
  requireId(a.storeId, 'storeId');
  requireId(a.customerId, 'customerId');
  requireId(a.orderId, 'orderId');
  if (!Number.isInteger(a.points) || a.points < 1 || a.points > MAX_POINTS)
    throw new MoneyError('BAD_POINTS', 'points must be a positive integer', 400);
  const now = a.now ?? Date.now();

  return db.transactionSync(() => {
    const order = requireOrder(db, a.storeId, a.orderId);
    if (order.customer_id !== a.customerId)
      throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);

    const prior = db.all(
      `SELECT points FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'redeem_discount'`,
      [a.storeId, a.orderId]
    )[0];
    if (prior) {
      const bal = db.all(
        'SELECT points FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
        [a.storeId, a.customerId]
      )[0];
      const p = Math.abs(prior.points as number);
      const cfg = loadLoyaltyConfig(db, a.storeId);
      const pv = Math.max(1, Math.floor(cfg?.settings.pointsValue || 1));
      return {
        pointsRedeemed: p,
        discountFils: p * pv,
        newBalance: (bal?.points as number | undefined) ?? 0,
        replayed: true,
      };
    }

    const cfg = loadLoyaltyConfig(db, a.storeId);
    if (!cfg || !cfg.enabled || a.featureEnabled !== true)
      throw new MoneyError('LOYALTY_DISABLED', 'Loyalty program is not enabled', 400);
    const exists = db.all(
      'SELECT points FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, a.customerId]
    )[0];
    if (!exists) throw new MoneyError('NO_POINTS', 'Customer has no loyalty points', 400);

    if (a.points < cfg.settings.minRedeemPoints)
      throw new MoneyError(
        'MIN_POINTS_NOT_MET',
        `Minimum ${cfg.settings.minRedeemPoints} points required to redeem`,
        400
      );
    if ((exists.points as number) < a.points)
      throw new MoneyError('INSUFFICIENT_POINTS', 'Insufficient points balance', 400);
    const q = computeRedemption(cfg.settings, a.points, order.subtotal, exists.points as number);
    if (!q.applied || q.pointsToRedeem !== a.points)
      throw new MoneyError(
        'REDEMPTION_EXCEEDS_CAP',
        'points exceed what this order may redeem',
        400,
        { allowedPoints: q.pointsToRedeem }
      );

    // the original's race-safe gate: ONE statement checks AND debits
    const burned = db.all(
      `UPDATE loyalty_points SET points = points - ?1, total_redeemed = total_redeemed + ?1, updated_at = ?4
       WHERE store_id = ?2 AND customer_id = ?3 AND points >= ?1 RETURNING points`,
      [a.points, a.storeId, a.customerId, now]
    );
    if (burned.length !== 1)
      throw new MoneyError('INSUFFICIENT_POINTS', 'Insufficient points balance', 400);

    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
       VALUES (?, ?, ?, ?, 'redeem_discount', ?, ?, ?)`,
      [
        crypto.randomUUID(),
        a.storeId,
        a.customerId,
        a.orderId,
        -a.points,
        `Redeemed ${a.points} points for ${(q.discountFils / 100).toFixed(2)} EGP discount`,
        now,
      ]
    );
    db.run(
      'UPDATE orders SET loyalty_points_redeemed = ?1, loyalty_discount = ?2, updated_at = ?5 WHERE id = ?3 AND store_id = ?4',
      [a.points, q.discountFils, a.orderId, a.storeId, now]
    );
    return {
      pointsRedeemed: a.points,
      discountFils: q.discountFils,
      newBalance: burned[0].points as number,
      replayed: false,
    };
  });
}

// ---------------------------------------------------------------- earn

export interface EarnResult {
  pointsEarned: number;
  newBalance: number;
  replayed: boolean;
}

/**
 * Award points for a purchase, at most once per order (unique `earn_purchase` ledger row). The order total is read
 * from the order row (never client-sent) and the order must belong to this store and customer. Auto-creates the
 * customer's points row like the original, writes a `tier_changed` audit row on a tier flip.
 */
export function earnPointsFromPurchase(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    orderId: string;
    featureEnabled: boolean;
    now?: number;
  }
): EarnResult {
  requireId(a.storeId, 'storeId');
  requireId(a.customerId, 'customerId');
  requireId(a.orderId, 'orderId');
  const now = a.now ?? Date.now();

  return db.transactionSync(() => {
    const order = requireOrder(db, a.storeId, a.orderId);
    if (order.customer_id !== a.customerId)
      throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);

    const cfg = loadLoyaltyConfig(db, a.storeId);
    if (!cfg || a.featureEnabled !== true)
      return { pointsEarned: 0, newBalance: 0, replayed: false };
    const settings = cfg.settings;

    db.run(
      `INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned, total_redeemed, tier, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, 'bronze', ?, ?) ON CONFLICT (store_id, customer_id) DO NOTHING`,
      [crypto.randomUUID(), a.storeId, a.customerId, now, now]
    );
    const lp = db.all(
      'SELECT points, total_earned, tier FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, a.customerId]
    )[0];
    const points = lp.points as number;
    const totalEarned = lp.total_earned as number;

    const already = db.all(
      `SELECT id FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'earn_purchase'`,
      [a.storeId, a.orderId]
    )[0];
    if (already) return { pointsEarned: 0, newBalance: points, replayed: true };

    const multiplier = tierMultiplier(totalEarned, settings);
    const pointsEarned = computeEarnPoints(order.total, settings, totalEarned);
    if (!Number.isInteger(pointsEarned) || pointsEarned < 0 || pointsEarned > MAX_POINTS)
      throw new MoneyError('BAD_POINTS', 'earned points out of range', 400);
    const newTier = calculateTier(totalEarned + pointsEarned, settings);

    // the unique index is the backstop: a duplicate insert throws and the whole unit rolls back
    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'earn_purchase', ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        a.storeId,
        a.customerId,
        a.orderId,
        pointsEarned,
        `Points earned from order (${multiplier}x multiplier)`,
        settings.expirationMonths > 0 ? now + settings.expirationMonths * MONTH_MS : null,
        now,
      ]
    );
    const upd = db.all(
      `UPDATE loyalty_points SET points = points + ?1, total_earned = total_earned + ?1, tier = ?2, updated_at = ?5
       WHERE store_id = ?3 AND customer_id = ?4 RETURNING points`,
      [pointsEarned, newTier, a.storeId, a.customerId, now]
    );
    if ((lp.tier as string) !== newTier)
      db.run(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
         VALUES (?, ?, ?, ?, 'tier_changed', 0, ?, ?)`,
        [
          crypto.randomUUID(),
          a.storeId,
          a.customerId,
          a.orderId,
          `Tier ${lp.tier} → ${newTier} (from order earn)`,
          now,
        ]
      );
    return { pointsEarned, newBalance: upd[0].points as number, replayed: false };
  });
}

// ---------------------------------------------------------------- reversals

/**
 * Take back the points an order earned (refund / cancel). Idempotent through the tagged `adjust` row
 * (`refund-revoke:<earnTxId>`, unique index). The FULL earned amount is taken back (#631): points the customer already
 * spent (e.g. redeemed as a discount on another order) are NOT forgiven, the balance goes negative and that debt is
 * paid off by the next points earned (a negative balance can never redeem: the redeem gate needs `points >= n`).
 * `total_earned` drops by the earned amount (floored at 0) and the tier is recomputed. `null` when the order earned nothing.
 */
export function reverseEarnedPointsFromOrder(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number }
): { pointsReversed: number; newBalance: number; debt?: number; replayed: boolean } | null {
  requireId(a.storeId, 'storeId');
  requireId(a.orderId, 'orderId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    requireOrder(db, a.storeId, a.orderId);
    const earn = db.all(
      `SELECT id, customer_id, points FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'earn_purchase'`,
      [a.storeId, a.orderId]
    )[0];
    if (!earn || (earn.points as number) <= 0) return null;
    const customerId = earn.customer_id as string;
    const tag = `refund-revoke:${earn.id as string}`;
    const lp = db.all(
      'SELECT points, total_earned, tier FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, customerId]
    )[0];
    if (!lp) return null;
    const done = db.all(
      `SELECT id FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'adjust' AND description = ?`,
      [a.storeId, a.orderId, tag]
    )[0];
    if (done) return { pointsReversed: 0, newBalance: lp.points as number, replayed: true };

    const cfg = loadLoyaltyConfig(db, a.storeId);
    if (!cfg) return null;
    const earned = earn.points as number;
    // #631: never floored at the balance (that let redeem-then-refund keep the discount for free). Partial refunds
    // already took their share (`partialRevoked`); the whole-order reversal takes only what is left of the earn.
    const toReverse = Math.max(
      0,
      earned - partialRevoked(db, a.storeId, a.orderId, earn.id as string)
    );
    const newTotalEarned = Math.max(0, (lp.total_earned as number) - toReverse);
    const newTier = calculateTier(newTotalEarned, cfg.settings);

    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
       VALUES (?, ?, ?, ?, 'adjust', ?, ?, ?)`,
      [crypto.randomUUID(), a.storeId, customerId, a.orderId, -toReverse, tag, now]
    );
    db.run(
      `UPDATE loyalty_points SET points = points - ?1, total_earned = ?2, tier = ?3, updated_at = ?6
       WHERE store_id = ?4 AND customer_id = ?5`,
      [toReverse, newTotalEarned, newTier, a.storeId, customerId, now]
    );
    if (newTier !== (lp.tier as string))
      db.run(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
         VALUES (?, ?, ?, ?, 'tier_changed', 0, ?, ?)`,
        [
          crypto.randomUUID(),
          a.storeId,
          customerId,
          a.orderId,
          `Tier ${lp.tier} → ${newTier} (from refund reverse)`,
          now,
        ]
      );
    return {
      pointsReversed: toReverse,
      newBalance: (lp.points as number) - toReverse,
      debt: Math.max(0, toReverse - Math.max(0, lp.points as number)),
      replayed: false,
    };
  });
}

/** Points already taken back from one earn by PARTIAL refunds (`refund-revoke:<earnId>:p:<refundKey>` rows, stored negative). */
function partialRevoked(db: SyncSql, storeId: string, orderId: string, earnId: string): number {
  const r = db.all(
    `SELECT COALESCE(-SUM(points), 0) AS s FROM loyalty_transactions
      WHERE store_id = ? AND order_id = ? AND type = 'adjust' AND description LIKE ? ESCAPE '\\'`,
    [storeId, orderId, `refund-revoke:${earnId}:p:%`]
  )[0];
  return Number(r?.s ?? 0);
}

/**
 * A PARTIAL refund (amount, returned lines or store credit) takes back the matching share of the points the order earned:
 * `floor(earned * refundedValue / orderTotal)`, at most what is still left of the earn (partials plus a whole reversal can
 * never take more than was earned). Money rule: an external fact is never rejected, an over-large refunded value is clamped
 * here. Like the whole reversal it is not floored at the balance (spent points become debt). Idempotent per `refundKey`
 * through the tagged `adjust` row. `null` when the order earned nothing or has no points row.
 */
export function reverseEarnedPointsPartial(
  db: SyncSql,
  a: { storeId: string; orderId: string; refundKey: string; value: number; now?: number }
): { pointsReversed: number; newBalance: number; replayed: boolean } | null {
  requireId(a.storeId, 'storeId');
  requireId(a.orderId, 'orderId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const order = requireOrder(db, a.storeId, a.orderId);
    const earn = db.all(
      `SELECT id, customer_id, points FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'earn_purchase'`,
      [a.storeId, a.orderId]
    )[0];
    if (!earn || (earn.points as number) <= 0) return null;
    const customerId = earn.customer_id as string;
    const lp = db.all(
      'SELECT points, total_earned, tier FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, customerId]
    )[0];
    if (!lp) return null;
    const tag = `refund-revoke:${earn.id as string}:p:${a.refundKey}`;
    const done = db.all(
      `SELECT id FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'adjust' AND description = ?`,
      [a.storeId, a.orderId, tag]
    )[0];
    if (done) return { pointsReversed: 0, newBalance: lp.points as number, replayed: true };
    const cfg = loadLoyaltyConfig(db, a.storeId);
    if (!cfg) return null;

    const earned = earn.points as number;
    const total = Number(order.total);
    const share = total > 0 ? Math.min(1, Math.max(0, a.value) / total) : 0;
    const whole = db.all(
      `SELECT id FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'adjust' AND description = ?`,
      [a.storeId, a.orderId, `refund-revoke:${earn.id as string}`]
    )[0];
    const left = whole ? 0 : earned - partialRevoked(db, a.storeId, a.orderId, earn.id as string);
    const toReverse = Math.min(Math.max(0, left), Math.floor(earned * share));
    if (toReverse <= 0)
      return { pointsReversed: 0, newBalance: lp.points as number, replayed: false };
    const newTotalEarned = Math.max(0, (lp.total_earned as number) - toReverse);
    const newTier = calculateTier(newTotalEarned, cfg.settings);
    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
       VALUES (?, ?, ?, ?, 'adjust', ?, ?, ?)`,
      [crypto.randomUUID(), a.storeId, customerId, a.orderId, -toReverse, tag, now]
    );
    db.run(
      `UPDATE loyalty_points SET points = points - ?1, total_earned = ?2, tier = ?3, updated_at = ?6
       WHERE store_id = ?4 AND customer_id = ?5`,
      [toReverse, newTotalEarned, newTier, a.storeId, customerId, now]
    );
    if (newTier !== (lp.tier as string))
      db.run(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
         VALUES (?, ?, ?, ?, 'tier_changed', 0, ?, ?)`,
        [
          crypto.randomUUID(),
          a.storeId,
          customerId,
          a.orderId,
          `Tier ${lp.tier} → ${newTier} (from partial refund)`,
          now,
        ]
      );
    return {
      pointsReversed: toReverse,
      newBalance: (lp.points as number) - toReverse,
      replayed: false,
    };
  });
}

/**
 * Give back the points spent at checkout (refund / cancel). Idempotent through `redeem-recredit:<redeemTxId>`.
 * `points` goes up, `total_redeemed` goes down (floored at 0); the tier is untouched (it tracks total_earned).
 */
export function reverseRedeemedPointsFromOrder(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number }
): { pointsRecredited: number; newBalance: number; replayed: boolean } | null {
  requireId(a.storeId, 'storeId');
  requireId(a.orderId, 'orderId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    requireOrder(db, a.storeId, a.orderId);
    const redeem = db.all(
      `SELECT id, customer_id, points FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'redeem_discount'`,
      [a.storeId, a.orderId]
    )[0];
    if (!redeem || (redeem.points as number) >= 0) return null;
    const customerId = redeem.customer_id as string;
    const recredit = Math.abs(redeem.points as number);
    const tag = `redeem-recredit:${redeem.id as string}`;
    const lp = db.all(
      'SELECT points, total_redeemed FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, customerId]
    )[0];
    if (!lp) return null;
    const done = db.all(
      `SELECT id FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'adjust' AND description = ?`,
      [a.storeId, a.orderId, tag]
    )[0];
    if (done) return { pointsRecredited: 0, newBalance: lp.points as number, replayed: true };

    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, created_at)
       VALUES (?, ?, ?, ?, 'adjust', ?, ?, ?)`,
      [crypto.randomUUID(), a.storeId, customerId, a.orderId, recredit, tag, now]
    );
    db.run(
      `UPDATE loyalty_points SET points = points + ?1, total_redeemed = max(0, total_redeemed - ?1), updated_at = ?4
       WHERE store_id = ?2 AND customer_id = ?3`,
      [recredit, a.storeId, customerId, now]
    );
    return {
      pointsRecredited: recredit,
      newBalance: (lp.points as number) + recredit,
      replayed: false,
    };
  });
}

// ---------------------------------------------------------------- admin / storefront reads + manual awards (L-1)
//
// Before L-1 these lived on Postgres only, so on a DO-backed store the admin members list / stats / history showed
// nothing that was earned, and a manual award landed in Postgres where the DO redeem never saw it (Ruling FP-2: the DO is
// the source of truth). Row shapes mirror the Prisma models (camelCase, epoch-ms timestamps) so the service can map them
// to the same API response as the Postgres path.

export const AWARD_TYPES = [
  'earn_manual',
  'earn_referral',
  'earn_review',
  'earn_birthday',
  'adjust',
] as const;
export type AwardType = (typeof AWARD_TYPES)[number];

export interface LoyaltyPointsRow {
  id: string;
  storeId: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  createdAt: number;
  updatedAt: number;
}

const toPointsRow = (r: Record<string, unknown>): LoyaltyPointsRow => ({
  id: r.id as string,
  storeId: r.store_id as string,
  customerId: r.customer_id as string,
  points: r.points as number,
  totalEarned: r.total_earned as number,
  totalRedeemed: r.total_redeemed as number,
  tier: r.tier as string,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

const POINTS_COLS =
  'id, store_id, customer_id, points, total_earned, total_redeemed, tier, created_at, updated_at';

function ensurePointsRow(db: SyncSql, storeId: string, customerId: string, now: number) {
  db.run(
    `INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned, total_redeemed, tier, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 0, 'bronze', ?, ?) ON CONFLICT (store_id, customer_id) DO NOTHING`,
    [crypto.randomUUID(), storeId, customerId, now, now]
  );
  return db.all(
    `SELECT ${POINTS_COLS} FROM loyalty_points WHERE store_id = ? AND customer_id = ?`,
    [storeId, customerId]
  )[0];
}

/**
 * THE one gate for every loyalty write that is not an order step (award, init, review bonus, history import, import flag):
 * a store has loyalty on the DO exactly when its `store_config` row EXISTS. `loyalty_enabled` (the merchant's switch) is
 * deliberately not part of it: importing history is data, not enablement, and every write op uses this same predicate, so
 * the import and the ops that write after it cannot drift (a write is never possible before the import is).
 */
export function loyaltyStoreConfig(db: SyncSql, storeId: string) {
  return loadLoyaltyConfig(db, storeId);
}

/** Config for an admin/storefront operation: refuses (LOYALTY_DISABLED) when the platform flag is off or the DO has no config row. */
function requireConfig(db: SyncSql, storeId: string, featureEnabled: boolean) {
  const cfg = loyaltyStoreConfig(db, storeId);
  if (!cfg || featureEnabled !== true)
    throw new MoneyError('LOYALTY_DISABLED', 'Loyalty program is not enabled', 400);
  return cfg;
}

/** `LoyaltyService.awardBonusPoints` (manual award): same balance / total / tier maths as the Postgres path. */
export function awardBonusPoints(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    points: number;
    type: string;
    description?: string | null;
    featureEnabled: boolean;
    now?: number;
  }
): { newBalance: number } {
  requireId(a.storeId, 'storeId');
  requireId(a.customerId, 'customerId');
  if (!Number.isInteger(a.points) || a.points === 0 || Math.abs(a.points) > MAX_POINTS)
    throw new MoneyError('BAD_POINTS', 'points must be a non-zero integer', 400);
  if (!(AWARD_TYPES as readonly string[]).includes(a.type))
    throw new MoneyError('BAD_ARGS', 'unsupported award type', 400);
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const cfg = requireConfig(db, a.storeId, a.featureEnabled);
    const lp = ensurePointsRow(db, a.storeId, a.customerId, now);
    const positive = a.points > 0;
    const tier = positive
      ? calculateTier((lp.total_earned as number) + a.points, cfg.settings)
      : (lp.tier as string);
    const upd = db.all(
      `UPDATE loyalty_points SET points = points + ?1,
         total_earned = total_earned + ?2, total_redeemed = total_redeemed + ?3, tier = ?4, updated_at = ?7
       WHERE store_id = ?5 AND customer_id = ?6 AND points + ?1 >= 0 RETURNING points`,
      [
        a.points,
        positive ? a.points : 0,
        positive ? 0 : -a.points,
        tier,
        a.storeId,
        a.customerId,
        now,
      ]
    );
    // a deduction can never take the balance below zero: the check and the write are ONE statement
    if (upd.length !== 1)
      throw new MoneyError('INSUFFICIENT_POINTS', 'Insufficient points balance', 409, {
        messageAr: 'رصيد النقاط مش كفاية للخصم ده',
        messageEn: 'The points balance is too low for this deduction',
      });
    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        a.storeId,
        a.customerId,
        a.type,
        a.points,
        a.description ?? null,
        positive && cfg.settings.expirationMonths > 0
          ? now + cfg.settings.expirationMonths * MONTH_MS
          : null,
        now,
      ]
    );
    return { newBalance: upd[0].points as number };
  });
}

/** `LoyaltyService.initializeCustomerPoints`: a points row (+ signup bonus) for a customer that has none. */
export function initializeCustomerPoints(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    giveSignupBonus: boolean;
    featureEnabled: boolean;
    now?: number;
  }
): { row: LoyaltyPointsRow; settings: LoyaltySettings } {
  requireId(a.storeId, 'storeId');
  requireId(a.customerId, 'customerId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const cfg = requireConfig(db, a.storeId, a.featureEnabled);
    const existing = db.all(
      'SELECT id FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, a.customerId]
    )[0];
    if (existing)
      throw new MoneyError('ALREADY_EXISTS', 'Customer already has loyalty points', 400);
    const bonus = a.giveSignupBonus ? cfg.settings.signupBonus : 0;
    db.run(
      `INSERT INTO loyalty_points (id, store_id, customer_id, points, total_earned, total_redeemed, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'bronze', ?, ?)`,
      [crypto.randomUUID(), a.storeId, a.customerId, bonus, bonus, now, now]
    );
    if (bonus > 0)
      db.run(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
         VALUES (?, ?, ?, NULL, 'earn_signup', ?, 'Welcome bonus for joining loyalty program', ?, ?)`,
        [
          crypto.randomUUID(),
          a.storeId,
          a.customerId,
          bonus,
          cfg.settings.expirationMonths > 0 ? now + cfg.settings.expirationMonths * MONTH_MS : null,
          now,
        ]
      );
    const row = db.all(
      `SELECT ${POINTS_COLS} FROM loyalty_points WHERE store_id = ? AND customer_id = ?`,
      [a.storeId, a.customerId]
    )[0];
    return { row: toPointsRow(row), settings: cfg.settings };
  });
}

/** `LoyaltyService.awardReviewBonus`: once per review and once per product (description match, as on Postgres). */
export function awardReviewBonus(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    productId: string;
    reviewId: string;
    featureEnabled: boolean;
    now?: number;
  }
): { awarded: boolean; points: number } {
  requireId(a.storeId, 'storeId');
  requireId(a.customerId, 'customerId');
  requireId(a.productId, 'productId');
  requireId(a.reviewId, 'reviewId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const cfg = loadLoyaltyConfig(db, a.storeId);
    if (!cfg || !cfg.enabled || a.featureEnabled !== true) return { awarded: false, points: 0 };
    const bonus = cfg.settings.reviewBonus;
    if (bonus <= 0) return { awarded: false, points: 0 };
    for (const needle of [a.reviewId, a.productId]) {
      const hit = db.all(
        `SELECT id FROM loyalty_transactions WHERE store_id = ? AND customer_id = ? AND type = 'earn_review'
         AND instr(description, ?) > 0 LIMIT 1`,
        [a.storeId, a.customerId, needle]
      )[0];
      if (hit) return { awarded: false, points: 0 };
    }
    const lp = ensurePointsRow(db, a.storeId, a.customerId, now);
    db.run(
      `UPDATE loyalty_points SET points = points + ?1, total_earned = total_earned + ?1, tier = ?2, updated_at = ?5
       WHERE store_id = ?3 AND customer_id = ?4`,
      [
        bonus,
        calculateTier((lp.total_earned as number) + bonus, cfg.settings),
        a.storeId,
        a.customerId,
        now,
      ]
    );
    db.run(
      `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
       VALUES (?, ?, ?, NULL, 'earn_review', ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        a.storeId,
        a.customerId,
        bonus,
        `Review bonus for product ${a.productId} (review ${a.reviewId})`,
        cfg.settings.expirationMonths > 0 ? now + cfg.settings.expirationMonths * MONTH_MS : null,
        now,
      ]
    );
    return { awarded: true, points: bonus };
  });
}

/** `LoyaltyService.getCustomerPoints`: the customer's row + the store settings, or null (feature off / no row). */
export function getCustomerPoints(
  db: SyncSql,
  a: { storeId: string; customerId: string; featureEnabled: boolean }
): { row: LoyaltyPointsRow; settings: LoyaltySettings } | null {
  requireId(a.customerId, 'customerId');
  const cfg = loadLoyaltyConfig(db, a.storeId);
  if (!cfg || a.featureEnabled !== true) return null;
  const r = db.all(
    `SELECT ${POINTS_COLS} FROM loyalty_points WHERE store_id = ? AND customer_id = ?`,
    [a.storeId, a.customerId]
  )[0];
  return r ? { row: toPointsRow(r), settings: cfg.settings } : null;
}

const pageArgs = (page: unknown, limit: unknown) => {
  const p = Number.isInteger(page) && (page as number) >= 1 ? (page as number) : 1;
  const l = Number.isInteger(limit) && (limit as number) >= 1 ? Math.min(limit as number, 200) : 20;
  return { page: p, limit: l, skip: (p - 1) * l };
};

/** `LoyaltyService.getTransactionHistory`: newest first, with the order's id + number. */
export function getTransactionHistory(
  db: SyncSql,
  a: { storeId: string; customerId: string; page?: number; limit?: number }
) {
  requireId(a.customerId, 'customerId');
  const { page, limit, skip } = pageArgs(a.page, a.limit);
  const rows = db.all(
    `SELECT t.id, t.store_id, t.customer_id, t.order_id, t.type, t.points, t.description, t.expires_at, t.created_at,
            o.order_number AS order_number
     FROM loyalty_transactions t LEFT JOIN orders o ON o.id = t.order_id AND o.store_id = t.store_id
     WHERE t.store_id = ?1 AND t.customer_id = ?2 ORDER BY t.created_at DESC, t.id DESC LIMIT ?3 OFFSET ?4`,
    [a.storeId, a.customerId, limit, skip]
  );
  const total = db.all(
    'SELECT count(*) AS n FROM loyalty_transactions WHERE store_id = ? AND customer_id = ?',
    [a.storeId, a.customerId]
  )[0].n as number;
  return {
    transactions: rows.map(r => ({
      id: r.id as string,
      storeId: r.store_id as string,
      customerId: r.customer_id as string,
      orderId: (r.order_id as string | null) ?? null,
      type: r.type as string,
      points: r.points as number,
      description: (r.description as string | null) ?? null,
      expiresAt: (r.expires_at as number | null) ?? null,
      createdAt: r.created_at as number,
      order:
        r.order_id && r.order_number
          ? { id: r.order_id as string, orderNumber: r.order_number as string }
          : null,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** `LoyaltyService.listMembers` (rows only; the service joins the customer's name/email from `users`). */
export function listMembers(
  db: SyncSql,
  a: { storeId: string; page?: number; limit?: number; tier?: string }
) {
  const { page, limit, skip } = pageArgs(a.page, a.limit);
  const tier = typeof a.tier === 'string' && a.tier ? a.tier : null;
  const where = tier ? 'store_id = ?1 AND tier = ?2' : 'store_id = ?1';
  const args: unknown[] = tier ? [a.storeId, tier] : [a.storeId];
  const rows = db.all(
    `SELECT ${POINTS_COLS} FROM loyalty_points WHERE ${where}
     ORDER BY total_earned DESC, id DESC LIMIT ${limit} OFFSET ${skip}`,
    args
  );
  const total = db.all(`SELECT count(*) AS n FROM loyalty_points WHERE ${where}`, args)[0]
    .n as number;
  return {
    members: rows.map(toPointsRow),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** `LoyaltyService.getStats`. */
export function getLoyaltyStats(db: SyncSql, a: { storeId: string }) {
  requireId(a.storeId, 'storeId');
  const tiers = db.all(
    'SELECT tier, count(*) AS n FROM loyalty_points WHERE store_id = ? GROUP BY tier',
    [a.storeId]
  );
  const sums = db.all(
    'SELECT count(*) AS n, coalesce(sum(total_earned), 0) AS earned, coalesce(sum(total_redeemed), 0) AS redeemed FROM loyalty_points WHERE store_id = ?',
    [a.storeId]
  )[0];
  const breakdown: Record<string, number> = {};
  for (const t of tiers) breakdown[t.tier as string] = t.n as number;
  return {
    totalMembers: sums.n as number,
    tierBreakdown: {
      bronze: breakdown.bronze || 0,
      silver: breakdown.silver || 0,
      gold: breakdown.gold || 0,
      platinum: breakdown.platinum || 0,
    },
    totalPointsIssued: sums.earned as number,
    totalPointsRedeemed: sums.redeemed as number,
    outstandingPoints: (sums.earned as number) - (sums.redeemed as number),
  };
}

/**
 * Is this Postgres ledger row already in the DO ledger? Semantic, not only by id (a cutover may have regenerated ids and
 * times, and the DO may have granted the same bonus itself): one signup bonus per customer; one review bonus per
 * description (it names the product and the review); one earn / redeem row per (order, type); one tagged reversal per
 * (order, description); anything else by id or by the same customer / type / points / description / time.
 */
function importedAlready(
  db: SyncSql,
  storeId: string,
  customerId: string,
  r: {
    id: string;
    orderId?: string | null;
    type: string;
    points: number;
    description?: string | null;
    createdAt: number;
  }
): boolean {
  const has = (sql: string, params: unknown[]) => db.all(sql, params)[0] !== undefined;
  if (has('SELECT 1 FROM loyalty_transactions WHERE id = ?', [r.id])) return true;
  if (r.type === 'earn_signup')
    return has(
      `SELECT 1 FROM loyalty_transactions WHERE store_id = ? AND customer_id = ? AND type = 'earn_signup'`,
      [storeId, customerId]
    );
  if (r.type === 'earn_review' && r.description)
    return has(
      `SELECT 1 FROM loyalty_transactions WHERE store_id = ? AND customer_id = ? AND type = 'earn_review' AND description = ?`,
      [storeId, customerId, r.description]
    );
  if ((r.type === 'earn_purchase' || r.type === 'redeem_discount') && r.orderId)
    return has(
      'SELECT 1 FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = ?',
      [storeId, r.orderId, r.type]
    );
  if (
    r.type === 'adjust' &&
    r.orderId &&
    /^(refund-revoke|redeem-recredit):/.test(r.description ?? '')
  )
    return has(
      `SELECT 1 FROM loyalty_transactions WHERE store_id = ? AND order_id = ? AND type = 'adjust' AND description = ?`,
      [storeId, r.orderId, r.description]
    );
  return has(
    `SELECT 1 FROM loyalty_transactions WHERE store_id = ? AND customer_id = ? AND type = ? AND points = ?
       AND created_at = ? AND coalesce(description, '') = coalesce(?, '')`,
    [storeId, customerId, r.type, r.points, r.createdAt, r.description ?? null]
  );
}

/** Has this customer's (or, with no customer, the store's) Postgres history been imported into the DO? */
export function importState(db: SyncSql, a: { customerId?: string }): { done: boolean } {
  const name = a.customerId ? `loyalty_import:${a.customerId}` : 'loyalty_import_store';
  const row = db.all('SELECT value FROM do_flags WHERE name = ?', [name])[0];
  return { done: row !== undefined && row.value === 1 };
}

/** Record that a customer's (or the whole store's) Postgres history is in the DO. */
export function markImported(db: SyncSql, a: { customerId?: string }): { done: true } {
  // (callers inside importLedgerRows already hold a config; the op door below re-checks it)
  const name = a.customerId ? `loyalty_import:${a.customerId}` : 'loyalty_import_store';
  db.run(
    'INSERT INTO do_flags (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = 1',
    [name]
  );
  return { done: true };
}

/**
 * One-off migration (Ruling FP-2): copy the ledger rows a DO store only has on Postgres (manual awards, signup /
 * review bonuses written before L-1) into the DO. Idempotent and keyed by the Postgres transaction id (or the same ledger
 * fact: customer, type, points and time, in case a cutover regenerated ids): a row the DO already holds is skipped and
 * moves no balance; each newly inserted row applies its delta once. An order the DO
 * does not hold is stored as NULL (the column is `ON DELETE SET NULL` anyway).
 */
export function importLedgerRows(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    rows: Array<{
      id: string;
      orderId?: string | null;
      type: string;
      points: number;
      description?: string | null;
      expiresAt?: number | null;
      createdAt: number;
    }>;
    /** Record the customer as imported in the same section (the lazy first-touch import sets it on its last batch). */
    markDone?: boolean;
    now?: number;
  }
): { inserted: number; skipped: number; newBalance: number; disabled?: true } {
  requireId(a.storeId, 'storeId');
  requireId(a.customerId, 'customerId');
  if (!Array.isArray(a.rows) || a.rows.length > 500)
    throw new MoneyError('BAD_ARGS', 'rows must be an array of at most 500', 400);
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const cfg = loyaltyStoreConfig(db, a.storeId);
    // An import never creates anything for a store without loyalty config (no `store_config` row): left untouched and NOT
    // marked, so the first touch after it is configured does the import. With a config row it always runs, enabled or not.
    if (!cfg) return { inserted: 0, skipped: 0, newBalance: 0, disabled: true };
    const settings = cfg.settings;
    let rowEnsured = false;
    let inserted = 0;
    let skipped = 0;
    let dPoints = 0;
    let dEarned = 0;
    let dRedeemed = 0;
    for (const r of a.rows) {
      requireId(r.id, 'row.id');
      if (!Number.isInteger(r.points) || Math.abs(r.points) > MAX_POINTS)
        throw new MoneyError('BAD_POINTS', 'row.points out of range', 400);
      if (importedAlready(db, a.storeId, a.customerId, r)) {
        skipped++;
        continue;
      }
      const orderOk =
        r.orderId &&
        db.all('SELECT 1 AS x FROM orders WHERE id = ? AND store_id = ?', [
          r.orderId,
          a.storeId,
        ])[0];
      // a points row appears only when at least one ledger row is really inserted (a read must never make a member)
      if (!rowEnsured) {
        ensurePointsRow(db, a.storeId, a.customerId, now);
        rowEnsured = true;
      }
      db.run(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          a.storeId,
          a.customerId,
          orderOk ? r.orderId : null,
          r.type,
          r.points,
          r.description ?? null,
          r.expiresAt ?? null,
          r.createdAt,
        ]
      );
      inserted++;
      if (r.type !== 'tier_changed') {
        dPoints += r.points;
        // engine-tagged reversals move the balance only; every other row counts like `awardBonusPoints` (positive = earned)
        const tagged =
          r.type === 'adjust' && /^(refund-revoke|redeem-recredit):/.test(r.description ?? '');
        if (!tagged && r.points > 0) dEarned += r.points;
        if (!tagged && r.points < 0) dRedeemed += -r.points;
      }
    }
    if (inserted === 0) {
      if (a.markDone) markImported(db, { customerId: a.customerId });
      const cur = db.all(
        'SELECT points FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
        [a.storeId, a.customerId]
      )[0];
      return { inserted, skipped, newBalance: (cur?.points as number | undefined) ?? 0 };
    }
    const lp = db.all(
      'SELECT total_earned FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
      [a.storeId, a.customerId]
    )[0];
    const upd = db.all(
      `UPDATE loyalty_points SET points = points + ?1, total_earned = total_earned + ?2, total_redeemed = total_redeemed + ?3,
         tier = ?4, updated_at = ?7 WHERE store_id = ?5 AND customer_id = ?6 RETURNING points`,
      [
        dPoints,
        dEarned,
        dRedeemed,
        calculateTier((lp.total_earned as number) + dEarned, settings),
        a.storeId,
        a.customerId,
        now,
      ]
    );
    if (a.markDone) markImported(db, { customerId: a.customerId });
    return { inserted, skipped, newBalance: upd[0].points as number };
  });
}

/** The admin store-level transaction log (`GET /stores/:id/loyalty/transactions`): filters + page, newest first. */
export function listStoreTransactions(
  db: SyncSql,
  a: {
    storeId: string;
    page?: number;
    limit?: number;
    type?: string;
    customerId?: string;
    from?: number | null;
    to?: number | null;
  }
) {
  requireId(a.storeId, 'storeId');
  const { limit, skip } = pageArgs(a.page, a.limit);
  const conds = ['t.store_id = ?'];
  const args: unknown[] = [a.storeId];
  if (typeof a.type === 'string' && a.type && a.type !== 'all') {
    conds.push('t.type = ?');
    args.push(a.type);
  }
  if (typeof a.customerId === 'string' && a.customerId) {
    conds.push('t.customer_id = ?');
    args.push(a.customerId);
  }
  if (typeof a.from === 'number') {
    conds.push('t.created_at >= ?');
    args.push(a.from);
  }
  if (typeof a.to === 'number') {
    conds.push('t.created_at <= ?');
    args.push(a.to);
  }
  const where = conds.join(' AND ');
  const rows = db.all(
    `SELECT t.id, t.store_id, t.customer_id, t.order_id, t.type, t.points, t.description, t.expires_at, t.created_at,
            o.order_number AS order_number
     FROM loyalty_transactions t LEFT JOIN orders o ON o.id = t.order_id AND o.store_id = t.store_id
     WHERE ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit} OFFSET ${skip}`,
    args
  );
  const total = db.all(`SELECT count(*) AS n FROM loyalty_transactions t WHERE ${where}`, args)[0]
    .n as number;
  return {
    transactions: rows.map(r => ({
      id: r.id as string,
      storeId: r.store_id as string,
      customerId: r.customer_id as string,
      orderId: (r.order_id as string | null) ?? null,
      type: r.type as string,
      points: r.points as number,
      description: (r.description as string | null) ?? null,
      expiresAt: (r.expires_at as number | null) ?? null,
      createdAt: r.created_at as number,
      order:
        r.order_id && r.order_number
          ? { id: r.order_id as string, orderNumber: r.order_number as string }
          : null,
    })),
    total,
  };
}

// ---- point expiry (the daily automation, port of LoyaltyAutomationService.processStorePointExpiration) ----------------

const EARN_TYPES = [
  'earn_purchase',
  'earn_signup',
  'earn_referral',
  'earn_review',
  'earn_birthday',
  'earn_manual',
];

const REVOKE_PREFIX = 'refund-revoke:';

/**
 * #631: what is LEFT of each earned lot for one customer, replayed from the ledger in time order (no extra column, so every
 * existing row is classified the same way). Every positive row is a lot (earns, positive adjusts such as a redeem
 * re-credit); every negative row consumes: a refund reversal (`refund-revoke:<earnTxId>`) its OWN lot first, everything
 * else (redeems, expiries, negative adjusts) the oldest lots first (FIFO). What cannot be taken from a lot is DEBT, and a
 * later lot pays the debt before anything else, so points earned while in debt are not expired a second time.
 */
// pq-allow(unused-export): test seam, imported by packages/repo/test/do-loyalty-lots.test.ts
export function lotRemaining(
  db: SyncSql,
  storeId: string,
  customerId: string
): Map<string, number> {
  const rows = db.all(
    `SELECT id, type, points, description FROM loyalty_transactions
      WHERE store_id = ?1 AND customer_id = ?2 AND points <> 0 ORDER BY created_at, rowid`,
    [storeId, customerId]
  );
  const lots: Array<{ id: string; left: number }> = [];
  const byId = new Map<string, { id: string; left: number }>();
  let debt = 0;
  const takeFifo = (n: number): number => {
    for (const l of lots) {
      if (n <= 0) break;
      const t = Math.min(l.left, n);
      l.left -= t;
      n -= t;
    }
    return n;
  };
  for (const r of rows) {
    const pts = Number(r.points);
    if (pts > 0) {
      const lot = { id: r.id as string, left: pts };
      const pay = Math.min(debt, lot.left);
      lot.left -= pay;
      debt -= pay;
      lots.push(lot);
      byId.set(lot.id, lot);
      continue;
    }
    let need = -pts;
    const desc = typeof r.description === 'string' ? r.description : '';
    if (r.type === 'adjust' && desc.startsWith(REVOKE_PREFIX)) {
      const own = byId.get(desc.slice(REVOKE_PREFIX.length).split(':')[0]);
      if (own) {
        const t = Math.min(own.left, need);
        own.left -= t;
        need -= t;
      }
    }
    debt += takeFifo(need);
  }
  return new Map(lots.map(l => [l.id, l.left]));
}

/**
 * One page (<= `limit` earn rows, id order, after the `after` cursor) of expired earn transactions. Per member: the expired
 * points are deducted from the balance (never below 0), ONE `expire` row is written, and the earn rows lose their `expires_at`
 * (the idempotency mark: a second run finds nothing). A member with no balance row is skipped, exactly as Postgres does, and the
 * cursor moves past it. All in one section. `more` = the page was full: call again with `last`.
 */
export function expirePoints(
  db: SyncSql,
  a: { storeId: string; now: number; after?: string | null; limit?: number }
): { members: number; expired: number; last: string | null; more: boolean } {
  const limit = Math.min(Math.max(a.limit ?? 500, 1), 500);
  const rows = db.all(
    `SELECT id, customer_id, points FROM loyalty_transactions
      WHERE store_id = ?1 AND expires_at IS NOT NULL AND expires_at < ?2 AND points > 0
        AND type IN (${EARN_TYPES.map(t => `'${t}'`).join(',')}) ${a.after ? 'AND id > ?4' : ''}
      ORDER BY id LIMIT ?3`,
    a.after ? [a.storeId, a.now, limit, a.after] : [a.storeId, a.now, limit]
  );
  const groups = new Map<string, { total: number; ids: string[] }>();
  for (const r of rows) {
    const g = groups.get(r.customer_id as string) ?? { total: 0, ids: [] };
    g.total += Number(r.points);
    g.ids.push(r.id as string);
    groups.set(r.customer_id as string, g);
  }
  let members = 0;
  let expired = 0;
  db.transactionSync(() => {
    for (const [customerId, g] of groups) {
      const lp = db.all(
        'SELECT points FROM loyalty_points WHERE store_id = ? AND customer_id = ?',
        [a.storeId, customerId]
      )[0];
      if (!lp) continue;
      // #631: only what is LEFT of the expiring lots expires (points already redeemed, reversed or expired, or that paid a
      // debt, never expire a second time against unrelated points); never more than a positive balance
      const left = lotRemaining(db, a.storeId, customerId);
      const remaining = g.ids.reduce((n, id) => n + Math.max(0, left.get(id) ?? 0), 0);
      const deduction = Math.max(0, Math.min(remaining, Number(lp.points)));
      const marks = g.ids.map(() => '?').join(',');
      if (deduction > 0) {
        db.run(
          `UPDATE loyalty_points SET points = points - ?1, total_redeemed = total_redeemed + ?1, updated_at = ?4
            WHERE store_id = ?2 AND customer_id = ?3`,
          [deduction, a.storeId, customerId, a.now]
        );
        db.run(
          `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
           VALUES (?, ?, ?, NULL, 'expire', ?, ?, NULL, ?)`,
          [
            crypto.randomUUID(),
            a.storeId,
            customerId,
            -deduction,
            `${deduction} points expired`,
            a.now,
          ]
        );
        expired += deduction;
      }
      db.run(
        `UPDATE loyalty_transactions SET expires_at = NULL WHERE store_id = ? AND id IN (${marks})`,
        [a.storeId, ...g.ids]
      );
      members++;
    }
  });
  const last = rows.length ? (rows[rows.length - 1].id as string) : null;
  return { members, expired, last, more: rows.length === limit };
}

/**
 * The daily birthday bonus for ONE store (port of LoyaltyAutomationService.processBirthdayBonuses): every loyalty member whose
 * date of birth (the store's customer directory, UTC month/day like the Worker's clock) is `month`/`day` and who has no
 * `earn_birthday` row since `yearStart` gets `settings.birthdayBonus` points (no tier recalculation, as in Postgres). One section,
 * so a member is never half-awarded; the existing-row check makes a second run a no-op. Off (store switch or platform feature)
 * or a store without a customer directory table: nothing.
 */
export function awardBirthdays(
  db: SyncSql,
  a: {
    storeId: string;
    now: number;
    month: number;
    day: number;
    yearStart: number;
    featureEnabled: boolean;
  }
): { awarded: number; points: number } {
  const cfg = loadLoyaltyConfig(db, a.storeId);
  if (!cfg || !cfg.enabled || a.featureEnabled !== true) return { awarded: 0, points: 0 };
  const bonus = cfg.settings.birthdayBonus;
  if (!(bonus > 0)) return { awarded: 0, points: 0 };
  const mmdd = `${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}`;
  let members: Array<Record<string, unknown>>;
  try {
    members = db.all(
      `SELECT lp.customer_id AS customer_id FROM loyalty_points lp
         JOIN _cauth_users u ON u.id = lp.customer_id
        WHERE lp.store_id = ?1 AND u.date_of_birth IS NOT NULL
          AND strftime('%m-%d', u.date_of_birth / 1000, 'unixepoch') = ?2
          AND NOT EXISTS (SELECT 1 FROM loyalty_transactions t WHERE t.store_id = ?1 AND t.customer_id = lp.customer_id
                            AND t.type = 'earn_birthday' AND t.created_at >= ?3)
        ORDER BY lp.customer_id LIMIT 500`,
      [a.storeId, mmdd, a.yearStart]
    );
  } catch {
    return { awarded: 0, points: 0 }; // no customer directory in this DO yet
  }
  const expiresAt =
    cfg.settings.expirationMonths > 0 ? a.now + cfg.settings.expirationMonths * MONTH_MS : null;
  db.transactionSync(() => {
    for (const m of members) {
      db.run(
        `UPDATE loyalty_points SET points = points + ?1, total_earned = total_earned + ?1, updated_at = ?4
          WHERE store_id = ?2 AND customer_id = ?3`,
        [bonus, a.storeId, m.customer_id, a.now]
      );
      db.run(
        `INSERT INTO loyalty_transactions (id, store_id, customer_id, order_id, type, points, description, expires_at, created_at)
         VALUES (?, ?, ?, NULL, 'earn_birthday', ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          a.storeId,
          m.customer_id,
          bonus,
          `Happy Birthday! ${bonus} bonus points`,
          expiresAt,
          a.now,
        ]
      );
    }
  });
  return { awarded: members.length, points: members.length * bonus };
}
