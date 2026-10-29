/**
 * Gold-rate pricing service (Phase B5 Task 10; Rulings B5-13, B5-14, B5-16, B5-18, B5-19, B5-20, B5-21).
 *
 * Every rate write is ONE transaction: advisory lock (serialises a store's rate writers, including the
 * first write of a karat that has no row to lock yet) -> `FOR UPDATE` on `gold_rates_current` (the
 * lock checkout's `FOR SHARE` queues behind) -> jump gate -> history row -> current row -> the
 * repricer, with the transaction-local `app.gold_reprice` flag on -> audit rows. After the commit the
 * caches are purged by the IMMEDIATE invalidator (never the order-coalesced one): price is NEVER-stale.
 */
import { prisma, Prisma, withMoneyTx } from '@ebda/database';
import {
  GOLD_KARATS,
  goldRateInputSchema,
  goldRateSettingsSchema,
  goldRateJumpBps,
  karatCoherenceBps,
  productGoldPricingInputSchema,
  variantGoldPricingInputSchema,
  type GoldKarat,
  type GoldRateInput,
  type GoldRateSettings,
  type GoldRoundingStep,
} from '@ebda/shared';
import { z } from 'zod/v3';
import { AppError } from '../../middleware/error-handler';
import { auditLog } from '../../middleware/security';
import { storeMoney } from '../../lib/repo-factory';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';
import { invalidateStoreProductCaches } from '../../lib/public-cache';
import {
  GOLD_CATALOGUE_CAP,
  KARAT_COHERENCE_GATE_BPS,
  loadCurrentRates,
  loadSettings,
  rateAgeMinutes,
  type CurrentRate,
  type GoldSettings,
} from './gate';
import { repriceProduct, repriceStore, withRepriceFlag, type RateLookup } from './repricer';

/** `forcePending`: store every feed rate PENDING whatever the gate says (the sources disagreed). */
export type RateActor =
  | { userId: string }
  | { feed: Record<string, unknown>; forcePending?: boolean };

export interface RateRow {
  id: string;
  karat: GoldKarat;
  ratePerGram: number;
  source: 'manual' | 'feed';
  status: 'applied' | 'pending' | 'rejected';
  jumpBps: number | null;
}

const actorUserId = (a: RateActor): string | null => ('userId' in a ? a.userId : null);

/**
 * STALENESS CLASS: price, NEVER-stale. Called after EVERY rate write path (manual, feed, confirming a
 * pending rate, a settings change that re-rounds, a spec or mode edit, the bulk switch). It is the
 * IMMEDIATE purge: it clears Redis `public:products:`, `public:product:`, `public:suggest:`,
 * `admin:products:`, the bundle and category keys, the in-process fallback, and POSTs ONE storefront
 * revalidation for the `products:`, `categories:` and `bundles:` tags (Ruling B5-21). It is NEVER
 * `invalidateStoreProductCachesAfterOrder`: that variant coalesces for 10 s, which is not acceptable
 * for a price change. Queued for after the commit inside a request (deferAfterTenantCommit), inline
 * outside one (the feed cron, which has already committed).
 */
export function purgeGoldPrices(storeId: string): Promise<unknown> {
  return deferAfterTenantCommit('gold-rate-purge', () => invalidateStoreProductCaches(storeId));
}

const lockKey = (storeId: string) => `gold-rate:${storeId}`;

/** The request-bound root client, typed as a transaction client for the shared read helpers. */
const root = () => prisma as unknown as Prisma.TransactionClient;

export class GoldRateService {
  /** Current rates, settings, ages, pending rows: what the admin rate page reads. Never cached. */
  static async getState(storeId: string) {
    const now = new Date();
    const [settings, current, pending, goldProducts] = await Promise.all([
      loadSettings(root(), storeId),
      loadCurrentRates(root(), storeId),
      prisma.goldRate.findMany({
        where: { storeId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          karat: true,
          ratePerGram: true,
          source: true,
          jumpBps: true,
          createdAt: true,
          feedReference: true,
        },
      }),
      prisma.product.count({ where: { storeId, pricingMode: 'gold_rate', deletedAt: null } }),
    ]);
    return {
      settings,
      goldProductCount: goldProducts,
      rates: GOLD_KARATS.map(karat => {
        const r = current.get(karat);
        return r
          ? {
              karat,
              ratePerGram: r.ratePerGram,
              appliedAt: r.appliedAt.toISOString(),
              ageMinutes: rateAgeMinutes(r.appliedAt, now),
              stale: rateAgeMinutes(r.appliedAt, now) >= settings.maxAgeMinutes,
            }
          : { karat, ratePerGram: null, appliedAt: null, ageMinutes: null, stale: true };
      }),
      pending: pending.map(p => ({
        id: p.id,
        karat: p.karat as GoldKarat,
        ratePerGram: p.ratePerGram,
        source: p.source,
        jumpBps: p.jumpBps,
        createdAt: p.createdAt.toISOString(),
      })),
      // The free automatic rate needs no secret (Ruling B5-15), so it is always available.
      feedAvailable: true,
    };
  }

  /** Cursor-paged history, newest first. Explicit select; the cursor is the last row's `created_at|id`. */
  static async history(
    storeId: string,
    opts: { karat?: GoldKarat; cursor?: string; limit?: number } = {}
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    let cursorWhere: Prisma.GoldRateWhereInput = {};
    if (opts.cursor) {
      const [iso, id] = opts.cursor.split('|');
      const at = new Date(iso ?? '');
      if (!id || Number.isNaN(at.getTime()))
        throw new AppError(400, 'INVALID_CURSOR', 'Bad cursor');
      cursorWhere = {
        OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }],
      };
    }
    const rows = await prisma.goldRate.findMany({
      where: { storeId, ...(opts.karat ? { karat: opts.karat } : {}), ...cursorWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        karat: true,
        ratePerGram: true,
        source: true,
        status: true,
        jumpBps: true,
        createdBy: true,
        decidedBy: true,
        createdAt: true,
        appliedAt: true,
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(r => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
      })),
      nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }

  /**
   * Write 1..3 rates. A MANUAL rate over the store's jump gate (or a 21k / 18k rate entered together
   * with 24k that is more than 4 % off 24k * karat/24) needs `confirm: true`, else 409
   * GOLD_RATE_CONFIRM_REQUIRED and nothing is written. A FEED rate over the gate is stored `pending`
   * and never self-confirms (Ruling B5-20).
   */
  static async applyRates(
    storeId: string,
    rawInput: GoldRateInput,
    actor: RateActor
  ): Promise<{ applied: RateRow[]; pending: RateRow[]; repriced: number }> {
    const input = goldRateInputSchema.parse(rawInput);
    const isFeed = 'feed' in actor;
    // Store on its Durable Object (Ruling CF-PAY-1): the jump gate, the history row, the current row and the repricer (flag on)
    // are ONE section there; an order priced in another section sees the old rate or the new one, never half.
    const money = await storeMoney(storeId);
    if (money) {
      const done = await money.goldApplyRates({
        input,
        ...(isFeed
          ? { feed: actor.feed, forcePending: actor.forcePending === true }
          : { userId: actor.userId }),
      });
      for (const row of [...done.applied, ...done.pending] as RateRow[])
        await auditLog({
          action: row.status === 'applied' ? 'gold_rate.set' : 'gold_rate.pending',
          userId: actorUserId(actor) ?? undefined,
          storeId,
          resourceType: 'gold_rate',
          resourceId: row.id,
          details: {
            karat: row.karat,
            to: row.ratePerGram,
            jumpBps: row.jumpBps,
            source: row.source,
          },
        }).catch(() => undefined);
      if (done.applied.length > 0) await purgeGoldPrices(storeId);
      return done;
    }
    const out = await withMoneyTx(prisma, async tx => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${lockKey(storeId)}))`;
      const settings = await loadSettings(tx, storeId);
      const current = await loadCurrentRates(tx, storeId, GOLD_KARATS, { lock: 'update' });
      const entered24 = input.rates.find(r => r.karat === 24)?.ratePerGram;

      // The gate, per rate.
      const verdicts = input.rates.map(r => {
        const prev = current.get(r.karat)?.ratePerGram;
        const jumpBps = prev ? goldRateJumpBps(prev, r.ratePerGram) : null;
        const coherenceBps =
          entered24 && r.karat !== 24
            ? karatCoherenceBps(entered24, r.ratePerGram, r.karat as 21 | 18)
            : null;
        const over =
          (jumpBps !== null && jumpBps > settings.jumpConfirmBps) ||
          (coherenceBps !== null && coherenceBps > KARAT_COHERENCE_GATE_BPS);
        return { ...r, prev: prev ?? null, jumpBps, coherenceBps, over };
      });
      const offending = verdicts.filter(v => v.over);
      if (offending.length > 0 && !isFeed && !input.confirm)
        throw new AppError(
          409,
          'GOLD_RATE_CONFIRM_REQUIRED',
          'This rate is far from the last one. Confirm it to continue.',
          {
            karat: offending[0].karat,
            jumpBps: offending[0].jumpBps,
            coherenceBps: offending[0].coherenceBps,
            items: offending.map(o => ({
              karat: o.karat,
              jumpBps: o.jumpBps,
              coherenceBps: o.coherenceBps,
            })),
          }
        );

      const applied: RateRow[] = [];
      const pending: RateRow[] = [];
      const now = new Date();
      let repriced = 0;
      await withRepriceFlag(tx, async () => {
        const newRates = new Map<GoldKarat, { id: string; ratePerGram: number }>();
        for (const v of verdicts) {
          const isPending = isFeed && (v.over || actor.forcePending === true);
          if (isPending) {
            // one pending rate per karat: a newer one supersedes the older
            await tx.goldRate.updateMany({
              where: { storeId, karat: v.karat, status: 'pending' },
              data: { status: 'rejected', decidedBy: 'system:superseded' },
            });
          }
          const row = await tx.goldRate.create({
            data: {
              storeId,
              karat: v.karat,
              ratePerGram: v.ratePerGram,
              source: isFeed ? 'feed' : 'manual',
              status: isPending ? 'pending' : 'applied',
              jumpBps: v.jumpBps,
              feedReference: isFeed ? (actor.feed as Prisma.InputJsonValue) : Prisma.JsonNull,
              createdBy: actorUserId(actor),
              appliedAt: isPending ? null : now,
            },
            select: { id: true },
          });
          const summary: RateRow = {
            id: row.id,
            karat: v.karat,
            ratePerGram: v.ratePerGram,
            source: isFeed ? 'feed' : 'manual',
            status: isPending ? 'pending' : 'applied',
            jumpBps: v.jumpBps,
          };
          if (isPending) {
            pending.push(summary);
            continue;
          }
          applied.push(summary);
          newRates.set(v.karat, { id: row.id, ratePerGram: v.ratePerGram });
          await tx.$executeRaw`
            INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at)
            VALUES (${storeId}, ${v.karat}, ${row.id}, ${v.ratePerGram}, ${now})
            ON CONFLICT (store_id, karat) DO UPDATE
              SET rate_id = EXCLUDED.rate_id, rate_per_gram = EXCLUDED.rate_per_gram, applied_at = EXCLUDED.applied_at`;
        }
        if (newRates.size > 0) {
          const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
          for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
          for (const [k, r] of newRates) lookup.set(k, r);
          repriced = await repriceStore(
            tx,
            storeId,
            [...newRates.keys()],
            lookup,
            settings.roundingStep
          );
        }
      });

      // Audit rows inside the transaction (savepointed by auditLog): the rate and its record commit together.
      for (const v of verdicts) {
        const row = [...applied, ...pending].find(r => r.karat === v.karat)!;
        await auditLog({
          action: row.status === 'applied' ? 'gold_rate.set' : 'gold_rate.pending',
          userId: actorUserId(actor) ?? undefined,
          storeId,
          resourceType: 'gold_rate',
          resourceId: row.id,
          details: {
            karat: v.karat,
            from: v.prev,
            to: v.ratePerGram,
            jumpBps: v.jumpBps,
            source: row.source,
            confirmed: !isFeed && v.over ? true : undefined,
          },
        });
      }
      return { applied, pending, repriced };
    });
    if (out.applied.length > 0) await purgeGoldPrices(storeId);
    return out;
  }

  /** Confirm or reject a PENDING (feed) rate. Confirming applies it exactly as typed. */
  static async decidePending(
    storeId: string,
    rateId: string,
    decision: 'confirm' | 'reject',
    actor: { userId: string }
  ): Promise<{ status: 'applied' | 'rejected'; repriced: number }> {
    const money = await storeMoney(storeId);
    if (money) {
      const done = (await money.goldDecidePending({ rateId, decision, userId: actor.userId })) as {
        status: 'applied' | 'rejected';
        repriced: number;
      };
      await auditLog({
        action: decision === 'confirm' ? 'gold_rate.confirmed' : 'gold_rate.rejected',
        userId: actor.userId,
        storeId,
        resourceType: 'gold_rate',
        resourceId: rateId,
        details: { decision },
      }).catch(() => undefined);
      if (done.status === 'applied') await purgeGoldPrices(storeId);
      return done;
    }
    const out = await withMoneyTx(prisma, async tx => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${lockKey(storeId)}))`;
      const row = await tx.goldRate.findFirst({
        where: { id: rateId, storeId },
        select: { id: true, karat: true, ratePerGram: true, status: true, source: true },
      });
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Rate not found');
      if (row.status !== 'pending')
        throw new AppError(409, 'RATE_NOT_PENDING', 'This rate has already been decided');
      const settings = await loadSettings(tx, storeId);
      const current = await loadCurrentRates(tx, storeId, GOLD_KARATS, { lock: 'update' });
      const now = new Date();
      let repriced = 0;
      if (decision === 'reject') {
        await tx.goldRate.update({
          where: { id: rateId, storeId } as never,
          data: { status: 'rejected', decidedBy: actor.userId },
        });
      } else {
        await withRepriceFlag(tx, async () => {
          await tx.goldRate.update({
            where: { id: rateId, storeId } as never,
            data: { status: 'applied', decidedBy: actor.userId, appliedAt: now },
          });
          await tx.$executeRaw`
            INSERT INTO gold_rates_current (store_id, karat, rate_id, rate_per_gram, applied_at)
            VALUES (${storeId}, ${row.karat}, ${row.id}, ${row.ratePerGram}, ${now})
            ON CONFLICT (store_id, karat) DO UPDATE
              SET rate_id = EXCLUDED.rate_id, rate_per_gram = EXCLUDED.rate_per_gram, applied_at = EXCLUDED.applied_at`;
          const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
          for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
          lookup.set(row.karat as GoldKarat, { id: row.id, ratePerGram: row.ratePerGram });
          repriced = await repriceStore(
            tx,
            storeId,
            [row.karat as GoldKarat],
            lookup,
            settings.roundingStep
          );
        });
      }
      await auditLog({
        action: decision === 'confirm' ? 'gold_rate.confirmed' : 'gold_rate.rejected',
        userId: actor.userId,
        storeId,
        resourceType: 'gold_rate',
        resourceId: rateId,
        details: {
          karat: row.karat,
          from: current.get(row.karat as GoldKarat)?.ratePerGram ?? null,
          to: row.ratePerGram,
          source: row.source,
        },
      });
      return {
        status: decision === 'confirm' ? ('applied' as const) : ('rejected' as const),
        repriced,
      };
    });
    if (out.status === 'applied') await purgeGoldPrices(storeId);
    return out;
  }

  /** Save the store's settings. A changed rounding step re-prices every gold row in the same transaction. */
  static async updateSettings(
    storeId: string,
    rawInput: GoldRateSettings,
    actor: { userId: string }
  ): Promise<GoldSettings & { repriced: number }> {
    const input = goldRateSettingsSchema.parse(rawInput);
    const money = await storeMoney(storeId);
    if (money) {
      const done = (await money.goldUpdateSettings({ input, userId: actor.userId })) as {
        repriced: number;
      };
      await auditLog({
        action: 'gold_rate.settings',
        userId: actor.userId,
        storeId,
        resourceType: 'gold_rate_settings',
        resourceId: storeId,
        details: { to: input },
      }).catch(() => undefined);
      await purgeGoldPrices(storeId);
      return {
        ...input,
        roundingStep: input.roundingStep as GoldRoundingStep,
        repriced: done.repriced,
      };
    }
    const out = await withMoneyTx(prisma, async tx => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${lockKey(storeId)}))`;
      const before = await loadSettings(tx, storeId);
      await tx.$executeRaw`
        INSERT INTO gold_rate_settings (store_id, enabled, feed_enabled, feed_premium_bps, max_age_minutes,
                                        jump_confirm_bps, rounding_step, show_breakdown, updated_by, updated_at)
        VALUES (${storeId}, ${input.enabled}, ${input.feedEnabled}, ${input.feedPremiumBps}, ${input.maxAgeMinutes},
                ${input.jumpConfirmBps}, ${input.roundingStep}, ${input.showBreakdown}, ${actor.userId}, now())
        ON CONFLICT (store_id) DO UPDATE SET
          enabled = EXCLUDED.enabled, feed_enabled = EXCLUDED.feed_enabled,
          feed_premium_bps = EXCLUDED.feed_premium_bps, max_age_minutes = EXCLUDED.max_age_minutes,
          jump_confirm_bps = EXCLUDED.jump_confirm_bps, rounding_step = EXCLUDED.rounding_step,
          show_breakdown = EXCLUDED.show_breakdown, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      let repriced = 0;
      if (before.roundingStep !== input.roundingStep) {
        const current = await loadCurrentRates(tx, storeId, GOLD_KARATS, { lock: 'update' });
        const lookup = new Map<GoldKarat, { id: string; ratePerGram: number }>();
        for (const [k, r] of current) lookup.set(k, { id: r.rateId, ratePerGram: r.ratePerGram });
        repriced = await withRepriceFlag(tx, () =>
          repriceStore(
            tx,
            storeId,
            [...lookup.keys()],
            lookup,
            input.roundingStep as GoldRoundingStep
          )
        );
      }
      await auditLog({
        action: 'gold_rate.settings',
        userId: actor.userId,
        storeId,
        resourceType: 'gold_rate_settings',
        resourceId: storeId,
        details: { from: before, to: input },
      });
      return { ...input, roundingStep: input.roundingStep as GoldRoundingStep, repriced };
    });
    // settings change what a price shows (breakdown) or is (rounding): purge on every save
    await purgeGoldPrices(storeId);
    return out;
  }

  /**
   * Set a product's pricing mode and spec (and its variants' overrides) and re-price it, in ONE
   * transaction. fixed -> gold needs a rate for every karat it uses (else 409 GOLD_RATE_MISSING),
   * clears any compare-at price or discount (Ruling B5-19) and refuses a bundled product; gold ->
   * fixed freezes the last computed price as the fixed price. Audited.
   */
  static async setProductPricing(
    storeId: string,
    productId: string,
    rawInput: {
      product: z.input<typeof productGoldPricingInputSchema>;
      variants?: Array<{ id: string } & z.input<typeof variantGoldPricingInputSchema>>;
    },
    actor: { userId: string }
  ): Promise<{ pricingMode: 'fixed' | 'gold_rate'; price: number }> {
    const product = productGoldPricingInputSchema.parse(rawInput.product);
    const variantInputs = (rawInput.variants ?? []).map(v => {
      const { id, ...rest } = v;
      return { id, ...variantGoldPricingInputSchema.parse(rest) };
    });
    // Store on its Durable Object (Ruling CF-LAST-1): spec, variant overrides and the re-price are ONE section there.
    const money = await storeMoney(storeId);
    if (money) {
      const done = (await money.goldSetProductPricing({
        productId,
        product,
        variants: variantInputs,
      })) as {
        pricingMode: 'fixed' | 'gold_rate';
        price: number;
        from: string;
        frozenPrice?: number;
      };
      await auditLog({
        action: 'gold_pricing.product',
        userId: actor.userId,
        storeId,
        resourceType: 'product',
        resourceId: productId,
        details: {
          from: done.from,
          to: product.pricingMode,
          frozenPrice: done.frozenPrice,
          spec:
            product.pricingMode === 'gold_rate'
              ? {
                  karat: product.karat,
                  weightMg: product.weightMg,
                  makingChargeType: product.makingChargeType,
                  makingChargeValue: product.makingChargeValue,
                  marginBps: product.marginBps ?? 0,
                }
              : undefined,
        },
      }).catch(() => undefined);
      await purgeGoldPrices(storeId);
      return { pricingMode: done.pricingMode, price: done.price };
    }
    const out = await withMoneyTx(prisma, async tx => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${lockKey(storeId)}))`;
      const existing = await tx.product.findFirst({
        where: { id: productId, storeId, deletedAt: null },
        select: {
          id: true,
          pricingMode: true,
          price: true,
          variants: { select: { id: true, price: true } },
        },
      });
      if (!existing) throw new AppError(404, 'NOT_FOUND', 'Product not found');
      const variantIds = new Set(existing.variants.map(v => v.id));
      for (const v of variantInputs)
        if (!variantIds.has(v.id)) throw new AppError(404, 'NOT_FOUND', 'Variant not found');
      // Ruling B5-36: a fixed variant under a gold product keeps ITS OWN price. One without a price would
      // fall back to the product's price, which is the minimum over the variants, so it could only ratchet down.
      if (product.pricingMode !== 'fixed') {
        const priceById = new Map(existing.variants.map(v => [v.id, v.price]));
        const unpriced = variantInputs.filter(
          v => v.pricingMode === 'fixed' && priceById.get(v.id) == null
        );
        if (unpriced.length > 0)
          throw new AppError(
            409,
            'GOLD_VARIANT_NEEDS_PRICE',
            'A fixed-price variant under a gold product needs its own price first',
            {
              variantIds: unpriced.map(v => v.id),
              messageAr: 'المتغيّر ده بسعر ثابت ومحتاج سعر خاص بيه الأول.',
            }
          );
      }

      const settings = await loadSettings(tx, storeId);
      const before = existing.pricingMode;

      if (product.pricingMode === 'fixed') {
        // gold -> fixed: freeze the last computed price (the column already holds it); variants too.
        await withRepriceFlag(tx, async () => {
          await tx.product.updateMany({
            where: { id: productId, storeId },
            data: { pricingMode: 'fixed' },
          });
          await tx.productVariant.updateMany({
            where: { productId, product: { storeId } },
            data: { pricingMode: null },
          });
        });
      } else {
        if (before !== 'gold_rate') {
          // Ruling B5-13: the catalogue cap is enforced where a product BECOMES gold, not only by the repricer.
          const goldCount = await tx.product.count({
            where: { storeId, pricingMode: 'gold_rate', deletedAt: null },
          });
          if (goldCount >= GOLD_CATALOGUE_CAP)
            throw new AppError(
              409,
              'GOLD_CATALOGUE_TOO_LARGE',
              `A store can hold at most ${GOLD_CATALOGUE_CAP} gold-priced products`
            );
        }
        const bundled = await tx.bundleItem.count({ where: { productId } });
        if (bundled > 0)
          throw new AppError(
            409,
            'GOLD_IN_BUNDLE',
            'A product in a bundle cannot be priced by the gold rate',
            { messageAr: 'مينفعش تسعّر منتج جوه باقة بسعر الدهب.' }
          );
        const tiers = await tx.productPriceTier.count({ where: { storeId, productId } });
        if (tiers > 0)
          throw new AppError(
            409,
            'GOLD_NO_PRICE_TIERS',
            'A product with fixed-price wholesale tiers cannot be priced by the gold rate',
            { messageAr: 'امسح شرائح الأسعار الثابتة الأول وبعدين سعّر المنتج بسعر الدهب.' }
          );
        const karatsUsed = new Set<GoldKarat>([product.karat as GoldKarat]);
        for (const v of variantInputs)
          if (v.karat != null && v.pricingMode !== 'fixed') karatsUsed.add(v.karat as GoldKarat);
        const rates = await loadCurrentRates(tx, storeId, [...karatsUsed], { lock: 'share' });
        const missing = [...karatsUsed].filter(k => !rates.has(k));
        if (missing.length > 0)
          throw new AppError(
            409,
            'GOLD_RATE_MISSING',
            `Set today's ${missing.join('k, ')}k rate before pricing a product by gold`,
            {
              karats: missing,
              messageAr: 'سجّل سعر الجرام النهارده الأول وبعدين اختار التسعير بالدهب.',
            }
          );
        await withRepriceFlag(tx, async () => {
          await tx.product.updateMany({
            where: { id: productId, storeId },
            data: {
              pricingMode: 'gold_rate',
              goldKarat: product.karat!,
              goldWeightMg: product.weightMg!,
              makingChargeType: product.makingChargeType!,
              makingChargeValue: product.makingChargeValue!,
              goldMarginBps: product.marginBps ?? 0,
              // Ruling B5-19: a gold row carries no compare-at price or discount (sales run through coupons)
              compareAtPrice: null,
              discountType: null,
              discountValue: null,
            },
          });
          // every variant: clear compare-at (it inherits gold), then apply the explicit overrides
          await tx.productVariant.updateMany({
            where: { productId, product: { storeId } },
            data: { compareAtPrice: null },
          });
          for (const v of variantInputs) {
            await tx.productVariant.updateMany({
              where: { id: v.id, productId, product: { storeId } },
              data: {
                pricingMode: v.pricingMode ?? null,
                goldKarat: v.karat ?? null,
                goldWeightMg: v.weightMg ?? null,
                makingChargeType: v.makingChargeType ?? null,
                makingChargeValue: v.makingChargeValue ?? null,
                goldMarginBps: v.marginBps ?? null,
                ...(v.pricingMode === 'gold_rate' ? { compareAtPrice: null } : {}),
              },
            });
          }
          const lookup: RateLookup = new Map(
            [...(await loadCurrentRates(tx, storeId, GOLD_KARATS)).entries()].map(([k, r]) => [
              k,
              { id: r.rateId, ratePerGram: r.ratePerGram },
            ])
          );
          await repriceProduct(tx, storeId, productId, lookup, settings.roundingStep);
        });
      }
      const after = await tx.product.findFirstOrThrow({
        where: { id: productId, storeId },
        select: { pricingMode: true, price: true },
      });
      await auditLog({
        action: 'gold_pricing.product',
        userId: actor.userId,
        storeId,
        resourceType: 'product',
        resourceId: productId,
        details: {
          from: before,
          to: product.pricingMode,
          frozenPrice: product.pricingMode === 'fixed' ? after.price : undefined,
          spec:
            product.pricingMode === 'gold_rate'
              ? {
                  karat: product.karat,
                  weightMg: product.weightMg,
                  makingChargeType: product.makingChargeType,
                  makingChargeValue: product.makingChargeValue,
                  marginBps: product.marginBps ?? 0,
                }
              : undefined,
        },
      });
      return { pricingMode: after.pricingMode as 'fixed' | 'gold_rate', price: after.price };
    });
    await purgeGoldPrices(storeId);
    return out;
  }

  /**
   * Run `fn` as the repricer on one gold product: the guard flag is on only for `fn`, then the
   * product is re-priced from the current rates inside the same transaction, so a variant added to a
   * gold product is born with its computed price (the database trigger refuses any other path).
   * Rolls everything back, and throws 409 GOLD_RATE_MISSING, if the karat has no rate.
   */
  static async asRepricer<T>(
    storeId: string,
    productId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    onDo?: () => Promise<T>
  ): Promise<T> {
    // Store on its Durable Object (Ruling CF-LAST-1): a closure cannot cross the door and the DO's price guard refuses a
    // gold variant insert outside the repricer section, so the caller passes `onDo` (one `goldCreateVariant` section).
    if (await storeMoney(storeId)) {
      if (!onDo)
        throw new Error('GoldRateService.asRepricer needs onDo for a Durable Object store');
      const result = await onDo();
      await purgeGoldPrices(storeId);
      return result;
    }
    const out = await withMoneyTx(prisma, async tx => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${lockKey(storeId)}))`;
      const settings = await loadSettings(tx, storeId);
      const result = await withRepriceFlag(tx, () => fn(tx));
      const rates = await loadCurrentRates(tx, storeId, GOLD_KARATS, { lock: 'share' });
      const lookup: RateLookup = new Map(
        [...rates.entries()].map(([k, r]) => [k, { id: r.rateId, ratePerGram: r.ratePerGram }])
      );
      await withRepriceFlag(tx, () =>
        repriceProduct(tx, storeId, productId, lookup, settings.roundingStep)
      );
      return result;
    });
    await purgeGoldPrices(storeId);
    return out;
  }

  /**
   * Bulk mode switch (Ruling B5-20: `store:settings`). Products with a complete stored spec switch to
   * gold; the rest are SKIPPED with the reason. Back to fixed freezes each product's current price.
   * At most 500 ids per call. One audit row per product (written by {@link setProductPricing}).
   */
  static async bulkSwitchMode(
    storeId: string,
    ids: string[],
    mode: 'fixed' | 'gold_rate',
    actor: { userId: string }
  ) {
    const money = await storeMoney(storeId);
    if (money) {
      // every product is its own nested section on the DO (a refused one is skipped and leaves nothing), as on Postgres
      const done = (await money.goldBulkSwitchMode({ ids, mode })) as {
        switched: string[];
        skipped: Array<{ id: string; reason: string }>;
      };
      for (const id of done.switched)
        await auditLog({
          action: 'gold_pricing.product',
          userId: actor.userId,
          storeId,
          resourceType: 'product',
          resourceId: id,
          details: { to: mode, bulk: true },
        }).catch(() => undefined);
      await purgeGoldPrices(storeId);
      return done;
    }
    const unique = [...new Set(ids)].slice(0, 500);
    const rows = await prisma.product.findMany({
      where: { storeId, id: { in: unique }, deletedAt: null },
      select: {
        id: true,
        pricingMode: true,
        goldKarat: true,
        goldWeightMg: true,
        makingChargeType: true,
        makingChargeValue: true,
        goldMarginBps: true,
      },
    });
    const switched: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const found = new Set(rows.map(r => r.id));
    for (const id of unique) if (!found.has(id)) skipped.push({ id, reason: 'NOT_FOUND' });
    for (const r of rows) {
      if (r.pricingMode === mode) {
        skipped.push({ id: r.id, reason: 'ALREADY' });
        continue;
      }
      try {
        if (mode === 'fixed') {
          await this.setProductPricing(storeId, r.id, { product: { pricingMode: 'fixed' } }, actor);
        } else {
          if (
            r.goldKarat == null ||
            r.goldWeightMg == null ||
            r.makingChargeType == null ||
            r.makingChargeValue == null
          ) {
            skipped.push({ id: r.id, reason: 'SPEC_INCOMPLETE' });
            continue;
          }
          await this.setProductPricing(
            storeId,
            r.id,
            {
              product: {
                pricingMode: 'gold_rate',
                karat: r.goldKarat as GoldKarat,
                weightMg: r.goldWeightMg,
                makingChargeType: r.makingChargeType as 'fixed' | 'per_gram',
                makingChargeValue: r.makingChargeValue,
                marginBps: r.goldMarginBps,
              },
            },
            actor
          );
        }
        switched.push(r.id);
      } catch (e) {
        if (e instanceof AppError && e.statusCode < 500) skipped.push({ id: r.id, reason: e.code });
        else throw e;
      }
    }
    return { switched, skipped };
  }
}

export type { CurrentRate };
