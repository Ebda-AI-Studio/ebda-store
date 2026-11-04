import { prisma, Prisma, LoyaltyTransactionType, withMoneyTx, withStore } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { featureService } from './feature.service';

import { fromMinor, minorToDecimalString } from '@ebda/shared';
import {
  storeMoney,
  storeUpdate,
  type DoLoyaltyPointsRow,
  type MoneyClient,
} from '../lib/repo-factory';
import { assertStoreCustomer } from '../lib/store-customer';
// Default loyalty settings structure
export interface LoyaltySettings {
  // Points earning
  pointsPerMajorUnit: number; // Points earned per 1 EGP spent (default 1 point per EGP)
  signupBonus: number; // Points given on account creation
  referralBonus: number; // Points for referring someone
  reviewBonus: number; // Points for leaving a review
  birthdayBonus: number; // Annual birthday bonus

  // Tiers
  tiers: {
    bronze: { minPoints: number; multiplier: number };
    silver: { minPoints: number; multiplier: number };
    gold: { minPoints: number; multiplier: number };
    platinum: { minPoints: number; multiplier: number };
  };

  // Redemption
  pointsValue: number; // Value in piastres per point (e.g., 1 point = 1 piastres)
  minRedeemPoints: number; // Minimum points to redeem
  maxRedeemPercentage: number; // Max % of order that can be paid with points

  // Expiration
  expirationMonths: number; // Points expire after X months (0 = never)
}

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = {
  // 1 point per 1 EGP spent; with pointsValue 1 piastre/point that is a 1% accrual
  // (10 points per 1 major unit at 1 minor unit/point = the same 1%). Name kept for API compat.
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
  pointsValue: 1, // 1 point = 1 piastre (0.01 EGP)
  minRedeemPoints: 500, // Minimum 500 points to redeem
  maxRedeemPercentage: 50, // Max 50% of order value
  expirationMonths: 12, // Points expire after 1 year
};

interface LoyaltySettingsResponse {
  loyaltyEnabled: boolean;
  settings: LoyaltySettings;
}

/** Result of resolving a requested loyalty redemption against the store's
 *  settings + the customer's balance + the order subtotal. All money is in
 *  PIASTRES (integers). `pointsToRedeem`/`discountFils` are 0 when redemption is
 *  not possible (below minimum, no balance, zero subtotal). */
export interface RedemptionQuote {
  /** Points that will actually be burned (clamped to balance + caps). */
  pointsToRedeem: number;
  /** Discount in piastres = pointsToRedeem * pointsValue. */
  discountFils: number;
  /** Whether the requested redemption produced any discount at all. */
  applied: boolean;
}

/**
 * Pure, side-effect-free redemption math. Server-side source of truth — the
 * order-create path NEVER trusts a client-sent discount; it sends only a
 * *requested* point count and this function decides what (if anything) is
 * actually redeemable.
 *
 * Rules (all in piastres, all integer):
 *  - below `minRedeemPoints` → nothing redeemed (applied=false).
 *  - clamp requested points to the customer's available balance.
 *  - the discount is capped at BOTH the order subtotal AND
 *    `maxRedeemPercentage`% of the subtotal (whichever is smaller). When the
 *    cap binds, we reduce the burned point count to match so we never spend
 *    points we don't credit as discount (discount = points * pointsValue
 *    exactly — no orphaned points).
 *  - `pointsValue` is piastres-per-point (>=1 by schema), so the integer division
 *    when re-deriving capped points is exact at the floor.
 */
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

  // Clamp the request to what the customer actually has.
  let points = Math.min(Math.floor(requestedPoints), Math.max(0, Math.floor(availablePoints)));

  // Minimum-redemption gate. Checked AFTER the balance clamp so a customer who
  // requests more than they have but still >= the minimum can redeem what they
  // hold; if their actual balance is below the minimum, nothing redeems.
  if (points < settings.minRedeemPoints) return none;

  // Cap the discount at the lower of the subtotal and maxRedeemPercentage% of it.
  const pct = Math.min(100, Math.max(0, settings.maxRedeemPercentage ?? 100));
  const pctCapFils = Math.floor((subtotalFils * pct) / 100);
  const maxDiscountFils = Math.min(subtotalFils, pctCapFils);

  let discountFils = points * pointsValue;
  if (discountFils > maxDiscountFils) {
    // The cap binds — reduce the burned points so discount == points*value
    // exactly. floor() means we never over-discount; the customer keeps the
    // remainder of their points.
    points = Math.floor(maxDiscountFils / pointsValue);
    discountFils = points * pointsValue;
  }

  // After capping, re-check the minimum — if the cap pushed us below the
  // minimum redeemable points, redeem nothing rather than a sub-minimum amount.
  if (points < settings.minRedeemPoints || points <= 0 || discountFils <= 0) return none;

  return { pointsToRedeem: points, discountFils, applied: true };
}

interface CustomerPointsInfo {
  id: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  tierMultiplier: number;
  nextTier: string | null;
  pointsToNextTier: number;
  pointsValue: number; // Value in piastres
}

/**
 * Take the customer's `loyalty_points` row lock for the rest of `tx`. Every
 * read-compute-write of the balance must run after this, so a concurrent
 * writer on the same customer queues instead of being overwritten.
 */
async function lockLoyaltyRow(
  tx: Prisma.TransactionClient,
  storeId: string,
  customerId: string
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM public.loyalty_points
    WHERE store_id = ${storeId} AND customer_id = ${customerId}
    FOR UPDATE`;
}

/** A reversal for an order the DO does not hold is a no-op, as it is on Postgres (no ledger row = nothing to reverse). */
function orderNotFoundAsNull(err: unknown): null {
  if (err instanceof AppError && err.code === 'ORDER_NOT_FOUND') return null;
  throw err;
}

/** DO rows carry epoch-ms timestamps; the API (and the Postgres path) return Dates. */
const asDate = (ms: number | null | undefined): Date | null => (ms == null ? null : new Date(ms));
const mergeDoSettings = (stored: unknown): LoyaltySettings => ({
  ...DEFAULT_LOYALTY_SETTINGS,
  ...(stored as Partial<LoyaltySettings>),
});
const doPointsRow = (r: DoLoyaltyPointsRow) => ({
  ...r,
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
});

export class LoyaltyService {
  /**
   * Get store loyalty settings
   */
  static async getSettings(storeId: string): Promise<LoyaltySettingsResponse> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltyEnabled: true,
          loyaltySettings: true,
        },
      })
    );

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    return {
      loyaltyEnabled: store.loyaltyEnabled,
      settings,
    };
  }

  /**
   * Update store loyalty settings
   */
  static async updateSettings(
    storeId: string,
    data: { loyaltyEnabled?: boolean; settings?: Partial<LoyaltySettings> }
  ): Promise<LoyaltySettingsResponse> {
    // Verify store exists
    const existing = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { loyaltySettings: true },
      })
    );

    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    const currentSettings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(existing.loyaltySettings as Partial<LoyaltySettings>),
    };

    const updatedSettings = data.settings
      ? { ...currentSettings, ...data.settings }
      : currentSettings;

    const store = await withStore(storeId, tx =>
      storeUpdate(tx, {
        where: { id: storeId },
        data: {
          loyaltyEnabled: data.loyaltyEnabled,
          loyaltySettings: updatedSettings as unknown as Prisma.InputJsonValue,
        },
        select: {
          loyaltyEnabled: true,
          loyaltySettings: true,
        },
      })
    );

    return {
      loyaltyEnabled: store.loyaltyEnabled,
      settings: store.loyaltySettings as unknown as LoyaltySettings,
    };
  }

  /**
   * Get customer's loyalty points info
   */
  static async getCustomerPoints(
    storeId: string,
    customerId: string
  ): Promise<CustomerPointsInfo | null> {
    // L-1 (Ruling FP-2): a DO store's balance lives on its Durable Object.
    const money = await storeMoney(storeId);
    if (money) {
      const featureEnabled = await featureService.isFeatureEnabled(storeId, 'loyalty');
      const r = await money.loyaltyCustomerPoints({ customerId, featureEnabled });
      if (!r) return null;
      const settings = mergeDoSettings(r.settings);
      const tierInfo = this.getTierInfo(r.row.totalEarned, settings);
      return {
        id: r.row.id,
        customerId: r.row.customerId,
        points: r.row.points,
        totalEarned: r.row.totalEarned,
        totalRedeemed: r.row.totalRedeemed,
        tier: r.row.tier,
        tierMultiplier: tierInfo.multiplier,
        nextTier: tierInfo.nextTier,
        pointsToNextTier: tierInfo.pointsToNext,
        pointsValue: settings.pointsValue,
      };
    }
    const [loyalty, store, loyaltyEnabled] = await Promise.all([
      prisma.loyaltyPoints.findUnique({
        where: {
          storeId_customerId: { storeId, customerId },
        },
      }),
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            loyaltySettings: true,
          },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      return null;
    }

    if (!loyalty) {
      return null;
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    const tierInfo = this.getTierInfo(loyalty.totalEarned, settings);

    return {
      id: loyalty.id,
      customerId: loyalty.customerId,
      points: loyalty.points,
      totalEarned: loyalty.totalEarned,
      totalRedeemed: loyalty.totalRedeemed,
      tier: loyalty.tier,
      tierMultiplier: tierInfo.multiplier,
      nextTier: tierInfo.nextTier,
      pointsToNextTier: tierInfo.pointsToNext,
      pointsValue: settings.pointsValue,
    };
  }

  /**
   * Initialize loyalty points for a new customer
   */
  static async initializeCustomerPoints(
    storeId: string,
    customerId: string,
    giveSignupBonus = true
  ): Promise<CustomerPointsInfo> {
    const [store, loyaltyEnabled] = await Promise.all([
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            loyaltySettings: true,
          },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store) {
      throw new AppError(404, 'NOT_FOUND', 'Store not found');
    }

    if (!loyaltyEnabled) {
      throw new AppError(400, 'LOYALTY_DISABLED', 'Loyalty program is not enabled for this store');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    await assertStoreCustomer(storeId, customerId); // SEC-CUSTOMER-SCOPE-1

    const money = await storeMoney(storeId);
    if (money) {
      const r = await money.loyaltyInit({
        customerId,
        giveSignupBonus,
        featureEnabled: loyaltyEnabled,
      });
      const doSettings = mergeDoSettings(r.settings);
      const tierInfo = this.getTierInfo(r.row.totalEarned, doSettings);
      return {
        id: r.row.id,
        customerId: r.row.customerId,
        points: r.row.points,
        totalEarned: r.row.totalEarned,
        totalRedeemed: r.row.totalRedeemed,
        tier: r.row.tier,
        tierMultiplier: tierInfo.multiplier,
        nextTier: tierInfo.nextTier,
        pointsToNextTier: tierInfo.pointsToNext,
        pointsValue: doSettings.pointsValue,
      };
    }

    // Check if already exists
    const existing = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (existing) {
      throw new AppError(400, 'ALREADY_EXISTS', 'Customer already has loyalty points');
    }

    const signupBonus = giveSignupBonus ? settings.signupBonus : 0;

    // Create loyalty points record
    const loyalty = await prisma.loyaltyPoints.create({
      data: {
        storeId,
        customerId,
        points: signupBonus,
        totalEarned: signupBonus,
        tier: 'bronze',
      },
    });

    // Log signup bonus transaction
    if (signupBonus > 0) {
      await prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          type: 'earn_signup',
          points: signupBonus,
          description: 'Welcome bonus for joining loyalty program',
          expiresAt:
            settings.expirationMonths > 0
              ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
              : null,
        },
      });
    }

    const tierInfo = this.getTierInfo(loyalty.totalEarned, settings);

    return {
      id: loyalty.id,
      customerId: loyalty.customerId,
      points: loyalty.points,
      totalEarned: loyalty.totalEarned,
      totalRedeemed: loyalty.totalRedeemed,
      tier: loyalty.tier,
      tierMultiplier: tierInfo.multiplier,
      nextTier: tierInfo.nextTier,
      pointsToNextTier: tierInfo.pointsToNext,
      pointsValue: settings.pointsValue,
    };
  }

  /**
   * Award points for a purchase
   */
  static async earnPointsFromPurchase(
    storeId: string,
    customerId: string,
    orderId: string,
    orderTotalFils: number
  ): Promise<{ pointsEarned: number; newBalance: number }> {
    // Store on its Durable Object (Ruling CF-MONEY-1): one named operation, one section, in place of the Postgres
    // transaction below. The DO reads the order total from its own order row (orderTotalFils is what Postgres is given).
    const money = await storeMoney(storeId);
    if (money) {
      const featureEnabled = await featureService.isFeatureEnabled(storeId, 'loyalty');
      const r = await money.loyaltyEarn({ customerId, orderId, featureEnabled });
      return { pointsEarned: r.pointsEarned, newBalance: r.newBalance };
    }
    const [store, loyaltyEnabled] = await Promise.all([
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            loyaltySettings: true,
          },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      return { pointsEarned: 0, newBalance: 0 };
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    // Get or create loyalty record
    let loyalty = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (!loyalty) {
      // Auto-initialize for purchase
      loyalty = await prisma.loyaltyPoints.create({
        data: {
          storeId,
          customerId,
          points: 0,
          totalEarned: 0,
          tier: 'bronze',
        },
      });
    }

    // Idempotency fast-path: award points at most once per order. Two separate
    // `order/status-changed` events for the same delivered transition (admin
    // double-click, or updateStatus called twice) spawn two independent Inngest
    // runs — without this guard each would credit points again. A matching
    // `earn_purchase` row means this order was already credited → no-op.
    //
    // This is a fast-path only, not the full guarantee: two concurrent calls
    // for the same order can both pass this findFirst before either commits
    // (the fanout runs concurrency: limit 5 per store). The DB-level partial
    // unique index on (store_id, order_id) WHERE type='earn_purchase' (see
    // migration 20260711120000_loyalty_earn_unique) closes that race — the
    // loser's insert below hits P2002 and is caught as a no-op too.
    if (orderId) {
      const alreadyEarned = await prisma.loyaltyTransaction.findFirst({
        where: { storeId, orderId, type: 'earn_purchase' },
        select: { id: true },
      });
      if (alreadyEarned) {
        return { pointsEarned: 0, newBalance: loyalty.points };
      }
    }

    // Get tier multiplier
    const tierInfo = this.getTierInfo(loyalty.totalEarned, settings);

    // Calculate points: (orderTotal in EGP) * pointsPerMajorUnit * tierMultiplier
    const orderTotalMajor = fromMinor(orderTotalFils);
    const basePoints = Math.floor(orderTotalMajor * settings.pointsPerMajorUnit);
    const pointsEarned = Math.floor(basePoints * tierInfo.multiplier);

    // Update balance and log transaction atomically. Compute the new
    // tier into a local first so we can detect a tier flip and write
    // an audit-only `tier_changed` bookkeeping row alongside the earn.
    const newTier = this.calculateTier(loyalty.totalEarned + pointsEarned, settings);
    const tierFlipped = newTier !== loyalty.tier;

    const txs: Prisma.PrismaPromise<unknown>[] = [
      prisma.loyaltyPoints.update({
        where: { id: loyalty.id, storeId },
        data: {
          points: { increment: pointsEarned },
          totalEarned: { increment: pointsEarned },
          tier: newTier,
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          orderId,
          type: 'earn_purchase',
          points: pointsEarned,
          description: `Points earned from order (${tierInfo.multiplier}x multiplier)`,
          expiresAt:
            settings.expirationMonths > 0
              ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
              : null,
        },
      }),
    ];

    if (tierFlipped) {
      txs.push(
        prisma.loyaltyTransaction.create({
          data: {
            storeId,
            customerId,
            orderId,
            type: 'tier_changed',
            points: 0,
            description: `Tier ${loyalty.tier} → ${newTier} (from order earn)`,
          },
        })
      );
    }

    try {
      const results = await prisma.$transaction(txs);
      const updated = results[0] as { points: number };

      return {
        pointsEarned,
        newBalance: updated.points,
      };
    } catch (err) {
      // P2002 = unique constraint violation on the partial unique index
      // (store_id, order_id) WHERE type='earn_purchase'. This means a
      // concurrent earnPointsFromPurchase call for the SAME order won the
      // race between this call's findFirst check above and its own insert —
      // this call lost. Postgres aborts the ENTIRE transaction on any
      // statement error, so the loyaltyPoints increment above was rolled
      // back along with the insert — points were NOT double-incremented.
      // Treat this exactly like the findFirst no-op above.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const current = await prisma.loyaltyPoints.findUnique({
          where: { storeId_customerId: { storeId, customerId } },
          select: { points: true },
        });
        return { pointsEarned: 0, newBalance: current?.points ?? loyalty.points };
      }
      throw err;
    }
  }

  /**
   * Reverse the points that were credited when this order was delivered.
   *
   * Idempotent: looks up the original `earn_purchase` transaction for
   * (orderId, customerId) — if none exists (order never reached delivered,
   * loyalty was disabled at the time, or this method already ran), it's
   * a no-op. Otherwise it decrements `points` + `totalEarned` by the same
   * amount (floored at 0 so a partial redeem since earn can't push the
   * balance negative), logs an inverse `adjust` transaction tagged with
   * the order id, and recomputes the tier from the new totalEarned.
   *
   * Called from `OrderService.applyRefundEffects` so every refund path —
   * status-button refund, gateway-initiated webhook refund, manual admin
   * "Refund via provider" — reverses the loyalty credit consistently.
   */
  static async reverseEarnedPointsFromOrder(
    storeId: string,
    orderId: string
  ): Promise<{ pointsReversed: number; newBalance: number } | null> {
    const money = await storeMoney(storeId);
    if (money) {
      // an order the DO does not hold has no earn row either: Postgres answers null for it
      const r = await money.loyaltyReverseEarned({ orderId }).catch(orderNotFoundAsNull);
      return r ? { pointsReversed: r.pointsReversed, newBalance: r.newBalance } : null;
    }
    // Find the original earn transaction. If loyalty was disabled at delivery
    // time, this returns null and we short-circuit.
    const earn = await prisma.loyaltyTransaction.findFirst({
      where: { storeId, orderId, type: 'earn_purchase' },
    });
    if (!earn || earn.points <= 0) return null;

    // Idempotency: refuse to revoke twice. We tag the inverse transaction
    // with the original earn's id in `description` so a second refund call
    // (e.g. partial-then-full) won't double-decrement.
    const tag = `refund-revoke:${earn.id}`;
    const already = await prisma.loyaltyTransaction.findFirst({
      where: { storeId, orderId, type: 'adjust', description: tag },
    });
    if (already) {
      const current = await prisma.loyaltyPoints.findUnique({
        where: { storeId_customerId: { storeId, customerId: earn.customerId } },
      });
      return { pointsReversed: 0, newBalance: current?.points ?? 0 };
    }

    const [store, loyaltyEnabled] = await Promise.all([
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: { loyaltySettings: true },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);
    if (!store) return null;

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...((store.loyaltySettings as Partial<LoyaltySettings>) ?? {}),
    };

    // Read-and-write under the customer's loyalty row lock. The balance used
    // to be read here with a plain findUnique OUTSIDE the transaction and then
    // written back as ABSOLUTE `points` / `totalEarned` values inside it, so a
    // concurrent earn or redeem on the same customer landing between the two
    // was silently overwritten (100 pts, reversal computes 50, another order's
    // earn lifts it to 130, the reversal stamps 50 — 30 points destroyed, and
    // `totalEarned` / the tier with them) (#1427). Every writer that changes
    // this row queues on the lock, so the values computed below are computed
    // from what the row holds at the moment it is written.
    let result: { pointsReversed: number; newBalance: number } | null;
    try {
      result = await withMoneyTx(prisma, async tx => {
        await lockLoyaltyRow(tx, storeId, earn.customerId);

        // Re-check the idempotency tag UNDER the lock: a concurrent reversal of
        // this same order that committed while we waited is visible now.
        const raced = await tx.loyaltyTransaction.findFirst({
          where: { storeId, orderId, type: 'adjust', description: tag },
          select: { id: true },
        });
        const loyalty = await tx.loyaltyPoints.findUnique({
          where: { storeId_customerId: { storeId, customerId: earn.customerId } },
        });
        if (!loyalty) return null;
        if (raced) return { pointsReversed: 0, newBalance: loyalty.points };

        // Floor at zero — a customer who redeemed their points already
        // shouldn't go into negative balance from the reversal.
        const pointsToReverse = Math.min(earn.points, loyalty.points);
        const newPoints = loyalty.points - pointsToReverse;
        const newTotalEarned = Math.max(0, loyalty.totalEarned - earn.points);

        const newTier = this.calculateTier(newTotalEarned, settings);
        const updated = await tx.loyaltyPoints.update({
          where: { id: loyalty.id, storeId },
          data: {
            points: newPoints,
            totalEarned: newTotalEarned,
            tier: newTier,
          },
        });
        await tx.loyaltyTransaction.create({
          data: {
            storeId,
            customerId: earn.customerId,
            orderId,
            type: 'adjust',
            points: -pointsToReverse,
            description: tag,
          },
        });
        if (newTier !== loyalty.tier) {
          await tx.loyaltyTransaction.create({
            data: {
              storeId,
              customerId: earn.customerId,
              orderId,
              type: 'tier_changed',
              points: 0,
              description: `Tier ${loyalty.tier} → ${newTier} (from refund reverse)`,
            },
          });
        }
        return { pointsReversed: pointsToReverse, newBalance: updated.points };
      });
    } catch (err) {
      // Backstop for a writer that bypasses the lock: the partial unique index
      // on (store_id, order_id, description) for `refund-revoke:%` adjust rows
      // (migration 20260903130000) makes a duplicate reversal's insert fail,
      // and Postgres aborts its whole transaction, so the balance write above
      // is rolled back with it. Treat that exactly like the fast-path no-op.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const current = await prisma.loyaltyPoints.findUnique({
          where: { storeId_customerId: { storeId, customerId: earn.customerId } },
          select: { points: true },
        });
        return { pointsReversed: 0, newBalance: current?.points ?? 0 };
      }
      throw err;
    }
    if (!result) return null;

    // Loyalty disabled at refund time still reverses — the points were
    // earned under the program and should come back out. Logged for clarity.
    if (!loyaltyEnabled) {
      logger.info(
        { storeId, orderId, pointsReversed: result.pointsReversed },
        '[Loyalty] reversed earned points despite loyalty currently disabled'
      );
    }

    return result;
  }

  /**
   * Resolve the server-side context needed to decide a redemption: whether
   * loyalty is active for the store, the effective settings, and the
   * customer's current available balance. Returns `null` when loyalty is
   * disabled or the customer has no points record (nothing to redeem). Used
   * by the order-create path to compute the actual discount via
   * `computeRedemption` before opening the order transaction.
   */
  static async getRedeemableContext(
    storeId: string,
    customerId: string
  ): Promise<{ settings: LoyaltySettings; availablePoints: number } | null> {
    const [store, loyaltyEnabled, loyalty] = await Promise.all([
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: { loyaltySettings: true, loyaltyEnabled: true },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
      prisma.loyaltyPoints.findUnique({
        where: { storeId_customerId: { storeId, customerId } },
        select: { points: true },
      }),
    ]);

    if (!store || !store.loyaltyEnabled || !loyaltyEnabled || !loyalty) return null;

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    return { settings, availablePoints: loyalty.points };
  }

  /**
   * Redeem points for a discount.
   *
   * `pointsToRedeem` is the EXACT, already-validated number of points to burn
   * (the caller resolves the request against the customer's balance + the
   * store caps via `computeRedemption` first). This method enforces the
   * minimum + the race-safe decrement and returns the resulting discount.
   *
   * Pass `client` to run inside an enclosing interactive transaction (the
   * order-create path) so the point decrement + the `redeem_discount` log
   * commit atomically with the order row — points are never deducted without
   * an order, and the order is never created without the deduction. Without a
   * `client` it runs on the global prisma client (standalone use).
   */
  static async redeemPoints(
    storeId: string,
    customerId: string,
    orderId: string,
    pointsToRedeem: number,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<{ discountFils: number; newBalance: number }> {
    const [store, loyaltyEnabled] = await Promise.all([
      client.store.findUnique({
        where: { id: storeId },
        select: {
          loyaltySettings: true,
        },
      }),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      throw new AppError(400, 'LOYALTY_DISABLED', 'Loyalty program is not enabled');
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    if (pointsToRedeem < settings.minRedeemPoints) {
      throw new AppError(
        400,
        'MIN_POINTS_NOT_MET',
        `Minimum ${settings.minRedeemPoints} points required to redeem`
      );
    }

    // Calculate discount value. pointsValue is piastres-per-point.
    const discountFils = pointsToRedeem * Math.max(1, Math.floor(settings.pointsValue || 1));

    // Race-safe redeem: previously this was read-then-decrement, so two
    // concurrent calls could both pass the `loyalty.points >=
    // pointsToRedeem` check and the customer would burn the balance
    // twice. The conditional `updateMany` does the gate AND the
    // decrement in a single statement; if the row's points have
    // already moved below the threshold, `count === 0` and we treat
    // that as INSUFFICIENT_POINTS. Inside the order transaction this also
    // means a concurrent checkout that already spent the balance loses
    // here and rolls back its whole order.
    const reserve = await client.loyaltyPoints.updateMany({
      where: {
        storeId,
        customerId,
        points: { gte: pointsToRedeem },
      },
      data: {
        points: { decrement: pointsToRedeem },
        totalRedeemed: { increment: pointsToRedeem },
      },
    });
    if (reserve.count === 0) {
      // Either no row at all, or balance dropped below the threshold
      // between the read and the write. Distinguish for a clearer
      // client error.
      const exists = await client.loyaltyPoints.findUnique({
        where: { storeId_customerId: { storeId, customerId } },
        select: { id: true },
      });
      if (!exists) {
        throw new AppError(400, 'NO_POINTS', 'Customer has no loyalty points');
      }
      throw new AppError(400, 'INSUFFICIENT_POINTS', 'Insufficient points balance');
    }

    // The decrement succeeded — log the transaction and return the
    // post-write balance. Re-read inside the same client so the caller sees
    // the value AFTER the decrement.
    await client.loyaltyTransaction.create({
      data: {
        storeId,
        customerId,
        orderId,
        type: 'redeem_discount',
        points: -pointsToRedeem,
        description: `Redeemed ${pointsToRedeem} points for ${minorToDecimalString(discountFils)} EGP discount`,
      },
    });
    const updated = await client.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
      select: { points: true },
    });

    return {
      discountFils,
      newBalance: updated?.points ?? 0,
    };
  }

  /**
   * Re-credit points that were redeemed at checkout when an order is
   * refunded or cancelled. Mirror of `reverseEarnedPointsFromOrder`.
   *
   * Idempotent: looks up the original `redeem_discount` transaction for
   * (orderId, customerId). If none exists (guest order, no redemption, or
   * this already ran) it's a no-op. The re-credit is guarded by a tagged
   * `adjust` row (`redeem-recredit:<txId>`) so a second refund call (e.g.
   * partial-then-full) never double-credits. It adds the points back to
   * `points` and reduces `totalRedeemed` by the same amount (the redemption
   * is unwound, not a new spend). Tier is NOT recomputed — redemption never
   * changed tier (tier tracks totalEarned, untouched here).
   *
   * Called from `OrderService.applyRefundEffects` alongside the earn reversal.
   */
  static async reverseRedeemedPointsFromOrder(
    storeId: string,
    orderId: string
  ): Promise<{ pointsRecredited: number; newBalance: number } | null> {
    const money = await storeMoney(storeId);
    if (money) {
      const r = await money.loyaltyReverseRedeemed({ orderId }).catch(orderNotFoundAsNull);
      return r ? { pointsRecredited: r.pointsRecredited, newBalance: r.newBalance } : null;
    }
    const redeem = await prisma.loyaltyTransaction.findFirst({
      where: { storeId, orderId, type: 'redeem_discount' },
    });
    // points on a redeem_discount row are stored negative (e.g. -500).
    if (!redeem || redeem.points >= 0) return null;

    const pointsToRecredit = Math.abs(redeem.points);

    // Idempotency guard tagged with the original redeem tx id.
    const tag = `redeem-recredit:${redeem.id}`;
    const already = await prisma.loyaltyTransaction.findFirst({
      where: { storeId, orderId, type: 'adjust', description: tag },
    });
    if (already) {
      const current = await prisma.loyaltyPoints.findUnique({
        where: { storeId_customerId: { storeId, customerId: redeem.customerId } },
      });
      return { pointsRecredited: 0, newBalance: current?.points ?? 0 };
    }

    // Same lock as the earn reversal (#1427): `totalRedeemed` used to be
    // written as an absolute value computed from a read outside the
    // transaction, so a concurrent redeem's increment landing in between was
    // overwritten. Computed and written under the row lock now.
    try {
      return await withMoneyTx(prisma, async tx => {
        await lockLoyaltyRow(tx, storeId, redeem.customerId);

        // Re-check the idempotency tag UNDER the lock (see the earn reversal).
        const raced = await tx.loyaltyTransaction.findFirst({
          where: { storeId, orderId, type: 'adjust', description: tag },
          select: { id: true },
        });
        const loyalty = await tx.loyaltyPoints.findUnique({
          where: { storeId_customerId: { storeId, customerId: redeem.customerId } },
        });
        if (!loyalty) return null;
        if (raced) return { pointsRecredited: 0, newBalance: loyalty.points };

        const updated = await tx.loyaltyPoints.update({
          where: { id: loyalty.id, storeId },
          data: {
            points: { increment: pointsToRecredit },
            totalRedeemed: Math.max(0, loyalty.totalRedeemed - pointsToRecredit),
          },
        });
        await tx.loyaltyTransaction.create({
          data: {
            storeId,
            customerId: redeem.customerId,
            orderId,
            type: 'adjust',
            points: pointsToRecredit,
            description: tag,
          },
        });
        return { pointsRecredited: pointsToRecredit, newBalance: updated.points };
      });
    } catch (err) {
      // Backstop: the partial unique index on `redeem-recredit:%` adjust rows
      // (migration 20260903130000) makes a duplicate re-credit's insert fail,
      // and Postgres aborts its whole transaction, so the increment above is
      // rolled back with it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const current = await prisma.loyaltyPoints.findUnique({
          where: { storeId_customerId: { storeId, customerId: redeem.customerId } },
          select: { points: true },
        });
        return { pointsRecredited: 0, newBalance: current?.points ?? 0 };
      }
      throw err;
    }
  }

  /**
   * Award bonus points (manual or for reviews, referrals, etc.)
   */
  static async awardBonusPoints(
    storeId: string,
    customerId: string,
    points: number,
    type: LoyaltyTransactionType,
    description?: string
  ): Promise<{ newBalance: number }> {
    const [store, loyaltyEnabled] = await Promise.all([
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: {
            loyaltySettings: true,
          },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !loyaltyEnabled) {
      throw new AppError(400, 'LOYALTY_DISABLED', 'Loyalty program is not enabled');
    }

    // SEC-CUSTOMER-SCOPE-1: the id is a global user uuid; it must be THIS store's customer before any row is created.
    await assertStoreCustomer(storeId, customerId);

    // L-1 (Ruling FP-2): on a DO store the award lands in the ledger the DO redeem reads.
    const money = await storeMoney(storeId);
    if (money) {
      return money.loyaltyAward({
        customerId,
        points,
        type,
        description,
        featureEnabled: loyaltyEnabled,
      });
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    // Get or create loyalty record
    let loyalty = await prisma.loyaltyPoints.findUnique({
      where: {
        storeId_customerId: { storeId, customerId },
      },
    });

    if (!loyalty) {
      loyalty = await prisma.loyaltyPoints.create({
        data: {
          storeId,
          customerId,
          points: 0,
          totalEarned: 0,
          tier: 'bronze',
        },
      });
    }

    // Update balance and log transaction atomically
    const isPositive = points > 0;
    const [updated] = await prisma.$transaction([
      prisma.loyaltyPoints.update({
        where: { id: loyalty.id, storeId },
        data: {
          points: { increment: points },
          totalEarned: isPositive ? { increment: points } : undefined,
          totalRedeemed: !isPositive ? { increment: Math.abs(points) } : undefined,
          tier: isPositive
            ? this.calculateTier(loyalty.totalEarned + points, settings)
            : loyalty.tier,
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          type,
          points,
          description,
          expiresAt:
            isPositive && settings.expirationMonths > 0
              ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
              : null,
        },
      }),
    ]);

    return { newBalance: updated.points };
  }

  /**
   * Award review bonus points when a review is approved.
   * Idempotent: no-ops if the customer already has an earn_review transaction
   * referencing this reviewId in the description.
   */
  static async awardReviewBonus(
    storeId: string,
    customerId: string,
    productId: string,
    reviewId: string
  ): Promise<{ awarded: boolean; points: number }> {
    const money = await storeMoney(storeId);
    if (money) {
      const featureEnabled = await featureService.isFeatureEnabled(storeId, 'loyalty');
      if (!featureEnabled) return { awarded: false, points: 0 };
      await assertStoreCustomer(storeId, customerId); // SEC-CUSTOMER-SCOPE-1
      return money.loyaltyReviewBonus({ customerId, productId, reviewId, featureEnabled });
    }
    const [store, loyaltyEnabled] = await Promise.all([
      withStore(storeId, tx =>
        tx.store.findUnique({
          where: { id: storeId },
          select: { loyaltySettings: true, loyaltyEnabled: true },
        })
      ),
      featureService.isFeatureEnabled(storeId, 'loyalty'),
    ]);

    if (!store || !store.loyaltyEnabled || !loyaltyEnabled) {
      return { awarded: false, points: 0 };
    }

    const settings = {
      ...DEFAULT_LOYALTY_SETTINGS,
      ...(store.loyaltySettings as Partial<LoyaltySettings>),
    };

    const reviewBonus = settings.reviewBonus;
    if (reviewBonus <= 0) {
      return { awarded: false, points: 0 };
    }

    // Idempotency: check if already awarded for this review
    const existingBonus = await prisma.loyaltyTransaction.findFirst({
      where: {
        storeId,
        customerId,
        type: 'earn_review',
        description: { contains: reviewId },
      },
    });

    if (existingBonus) {
      return { awarded: false, points: 0 };
    }

    // Also check: one review bonus per product (not per review submission)
    const existingProductBonus = await prisma.loyaltyTransaction.findFirst({
      where: {
        storeId,
        customerId,
        type: 'earn_review',
        description: { contains: productId },
      },
    });

    if (existingProductBonus) {
      return { awarded: false, points: 0 };
    }

    await assertStoreCustomer(storeId, customerId); // SEC-CUSTOMER-SCOPE-1

    // Get or create loyalty record
    let loyalty = await prisma.loyaltyPoints.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });

    if (!loyalty) {
      loyalty = await prisma.loyaltyPoints.create({
        data: { storeId, customerId, points: 0, totalEarned: 0, tier: 'bronze' },
      });
    }

    const expiresAt =
      settings.expirationMonths > 0
        ? new Date(Date.now() + settings.expirationMonths * 30 * 24 * 60 * 60 * 1000)
        : null;

    await prisma.$transaction([
      prisma.loyaltyPoints.update({
        where: { id: loyalty.id, storeId },
        data: {
          points: { increment: reviewBonus },
          totalEarned: { increment: reviewBonus },
          tier: this.calculateTier(loyalty.totalEarned + reviewBonus, settings),
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          storeId,
          customerId,
          type: 'earn_review',
          points: reviewBonus,
          description: `Review bonus for product ${productId} (review ${reviewId})`,
          expiresAt,
        },
      }),
    ]);

    return { awarded: true, points: reviewBonus };
  }

  /**
   * Get customer's transaction history
   */
  static async getTransactionHistory(
    storeId: string,
    customerId: string,
    options?: { page?: number; limit?: number }
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    await assertStoreCustomer(storeId, customerId); // SEC-CUSTOMER-SCOPE-1

    const money = await storeMoney(storeId);
    if (money) {
      const r = await money.loyaltyHistory({ customerId, page, limit });
      return {
        transactions: r.transactions.map(t => ({
          ...t,
          expiresAt: asDate(t.expiresAt),
          createdAt: new Date(t.createdAt),
        })),
        pagination: r.pagination,
      };
    }

    const [transactions, total] = await Promise.all([
      prisma.loyaltyTransaction.findMany({
        where: { storeId, customerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
            },
          },
        },
      }),
      prisma.loyaltyTransaction.count({
        where: { storeId, customerId },
      }),
    ]);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * List all loyalty members for a store (admin)
   */
  static async listMembers(
    storeId: string,
    options?: { page?: number; limit?: number; tier?: string; search?: string }
  ) {
    const page = options?.page || 1;
    const limit = options?.limit || 20;
    const skip = (page - 1) * limit;

    const money = await storeMoney(storeId);
    if (money) {
      const r = await money.loyaltyMembers({ page, limit, tier: options?.tier });
      // SEC-CUSTOMER-SCOPE-1: the name/email join is Postgres identity, scoped to this store's customer accounts.
      const customers = await withStore(storeId, tx =>
        tx.user.findMany({
          where: { id: { in: r.members.map(m => m.customerId) }, role: 'customer', storeId },
          select: { id: true, email: true, firstName: true, lastName: true },
        })
      );
      const byId = new Map(customers.map(c => [c.id, c]));
      return {
        members: r.members.flatMap(m => {
          const customer = byId.get(m.customerId);
          return customer ? [{ ...doPointsRow(m), customer }] : [];
        }),
        pagination: r.pagination,
      };
    }

    // SEC-CUSTOMER-SCOPE-1: never list (or join PII of) a user who is not this store's customer, even if a stray row exists.
    const where: Prisma.LoyaltyPointsWhereInput = {
      storeId,
      customer: { storeId, role: 'customer' },
    };
    if (options?.tier) {
      where.tier = options.tier;
    }

    const [members, total] = await Promise.all([
      prisma.loyaltyPoints.findMany({
        where,
        orderBy: [{ totalEarned: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: {
          customer: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      prisma.loyaltyPoints.count({ where }),
    ]);

    return {
      members,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Store-level transaction log with the customer's name/email and the order number (admin, `GET .../loyalty/transactions`).
   * SEC-CUSTOMER-SCOPE-1: the joined PII must belong to this store's customers on both backends.
   */
  static async listStoreTransactions(
    storeId: string,
    q: {
      page: number;
      limit: number;
      type?: string;
      customerId?: string;
      from?: Date | null;
      to?: Date | null;
    }
  ) {
    const money = await storeMoney(storeId);
    if (money) {
      const r = await money.loyaltyStoreTransactions({
        page: q.page,
        limit: q.limit,
        type: q.type,
        customerId: q.customerId,
        from: q.from ? q.from.getTime() : null,
        to: q.to ? q.to.getTime() : null,
      });
      const customers = await withStore(storeId, tx =>
        tx.user.findMany({
          where: {
            id: { in: [...new Set(r.transactions.map(t => t.customerId))] },
            role: 'customer',
            storeId,
          },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      );
      const byId = new Map(customers.map(c => [c.id, c]));
      return {
        total: r.total,
        transactions: r.transactions.flatMap(t => {
          const customer = byId.get(t.customerId);
          return customer
            ? [{ ...t, expiresAt: asDate(t.expiresAt), createdAt: new Date(t.createdAt), customer }]
            : [];
        }),
      };
    }
    const where: Prisma.LoyaltyTransactionWhereInput = {
      storeId,
      customer: { storeId, role: 'customer' },
    };
    if (q.type && q.type !== 'all') where.type = q.type as LoyaltyTransactionType;
    if (q.customerId) where.customerId = q.customerId;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) where.createdAt.gte = q.from;
      if (q.to) where.createdAt.lte = q.to;
    }
    const [transactions, total] = await Promise.all([
      prisma.loyaltyTransaction.findMany({
        where,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, email: true } },
          order: { select: { id: true, orderNumber: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prisma.loyaltyTransaction.count({ where }),
    ]);
    return { transactions, total };
  }

  /**
   * One-off migration (Ruling FP-2, `docs/cf/loyalty-do-migration.md`): copy the Postgres ledger rows of a DO-backed store
   * into its Durable Object. Idempotent (the DO skips rows it already holds). `dryRun` (the default) only reports what Postgres
   * holds and what the DO shows today; nothing is written. Postgres rows are never deleted.
   */
  static async migrateLedgerToDo(
    storeId: string,
    opts: { dryRun?: boolean } = {}
  ): Promise<{
    dryRun: boolean;
    customers: number;
    rows: number;
    pgPoints: number;
    inserted: number;
    skipped: number;
    doStatsBefore: Awaited<ReturnType<MoneyClient['loyaltyStats']>>;
    doStatsAfter: Awaited<ReturnType<MoneyClient['loyaltyStats']>> | null;
  }> {
    const dryRun = opts.dryRun !== false;
    const money = await storeMoney(storeId);
    if (!money)
      throw new AppError(400, 'NOT_A_DO_STORE', 'This store is not on its Durable Object');
    const doStatsBefore = await money.loyaltyStats();
    const rows = await prisma.loyaltyTransaction.findMany({
      where: { storeId },
      orderBy: [{ customerId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        customerId: true,
        orderId: true,
        type: true,
        points: true,
        description: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    const byCustomer = new Map<string, typeof rows>();
    for (const r of rows)
      byCustomer.set(r.customerId, [...(byCustomer.get(r.customerId) ?? []), r]);
    let inserted = 0;
    let skipped = 0;
    if (!dryRun) {
      for (const [customerId, list] of byCustomer) {
        for (let i = 0; i < list.length; i += 500) {
          const r = await money.loyaltyImport({
            customerId,
            rows: list.slice(i, i + 500).map(t => ({
              id: t.id,
              orderId: t.orderId,
              type: t.type,
              points: t.points,
              description: t.description,
              expiresAt: t.expiresAt ? t.expiresAt.getTime() : null,
              createdAt: t.createdAt.getTime(),
            })),
          });
          inserted += r.inserted;
          skipped += r.skipped;
        }
      }
    }
    return {
      dryRun,
      customers: byCustomer.size,
      rows: rows.length,
      pgPoints: rows.reduce((n, r) => n + r.points, 0),
      inserted,
      skipped,
      doStatsBefore,
      doStatsAfter: dryRun ? null : await money.loyaltyStats(),
    };
  }

  /**
   * Get loyalty program statistics
   */
  static async getStats(storeId: string) {
    const money = await storeMoney(storeId);
    if (money) return money.loyaltyStats();
    const [totalMembers, tierCounts, totalPointsIssued, totalPointsRedeemed] = await Promise.all([
      prisma.loyaltyPoints.count({ where: { storeId } }),
      prisma.loyaltyPoints.groupBy({
        by: ['tier'],
        where: { storeId },
        _count: true,
      }),
      prisma.loyaltyPoints.aggregate({
        where: { storeId },
        _sum: { totalEarned: true },
      }),
      prisma.loyaltyPoints.aggregate({
        where: { storeId },
        _sum: { totalRedeemed: true },
      }),
    ]);

    const tierBreakdown = tierCounts.reduce(
      (acc, { tier, _count }) => {
        acc[tier] = _count;
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      totalMembers,
      tierBreakdown: {
        bronze: tierBreakdown.bronze || 0,
        silver: tierBreakdown.silver || 0,
        gold: tierBreakdown.gold || 0,
        platinum: tierBreakdown.platinum || 0,
      },
      totalPointsIssued: totalPointsIssued._sum.totalEarned || 0,
      totalPointsRedeemed: totalPointsRedeemed._sum.totalRedeemed || 0,
      outstandingPoints:
        (totalPointsIssued._sum.totalEarned || 0) - (totalPointsRedeemed._sum.totalRedeemed || 0),
    };
  }

  // Helper: Get tier info
  private static getTierInfo(
    totalEarned: number,
    settings: LoyaltySettings
  ): { tier: string; multiplier: number; nextTier: string | null; pointsToNext: number } {
    const tiers = ['bronze', 'silver', 'gold', 'platinum'] as const;
    let currentTier: (typeof tiers)[number] = 'bronze';
    let nextTier: (typeof tiers)[number] | null = null;

    for (let i = tiers.length - 1; i >= 0; i--) {
      if (totalEarned >= settings.tiers[tiers[i]].minPoints) {
        currentTier = tiers[i];
        nextTier = i < tiers.length - 1 ? tiers[i + 1] : null;
        break;
      }
    }

    const pointsToNext = nextTier ? settings.tiers[nextTier].minPoints - totalEarned : 0;

    return {
      tier: currentTier,
      multiplier: settings.tiers[currentTier].multiplier,
      nextTier,
      pointsToNext: Math.max(0, pointsToNext),
    };
  }

  // Helper: Calculate tier from points
  private static calculateTier(totalEarned: number, settings: LoyaltySettings): string {
    const tiers = ['bronze', 'silver', 'gold', 'platinum'] as const;
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (totalEarned >= settings.tiers[tiers[i]].minPoints) {
        return tiers[i];
      }
    }
    return 'bronze';
  }
}
