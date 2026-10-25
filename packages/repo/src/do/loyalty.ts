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
 * (`refund-revoke:<earnTxId>`, unique index). Floors the points at the customer's balance (a customer who already
 * spent them cannot go negative); `total_earned` drops by the full earned amount (floored at 0) and the tier is
 * recomputed. `null` when the order earned nothing.
 */
export function reverseEarnedPointsFromOrder(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number }
): { pointsReversed: number; newBalance: number; replayed: boolean } | null {
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
    const toReverse = Math.min(earned, lp.points as number);
    const newTotalEarned = Math.max(0, (lp.total_earned as number) - earned);
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
