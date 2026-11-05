import { prisma } from '@ebda/database';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { redis } from './redis.service';
import { AppError } from '../middleware/error-handler';
import { withLeaderLock } from '../lib/leader-election';
import logger from '../lib/logger';
import { readInStoreContext } from '../lib/store-scoped-read';
import { LISTING_SWATCH_OPTIONS_SELECT } from '../lib/listing-swatch-select';
import { visibleProductWhere } from '../lib/visible-product';
import { enrichStockFlags, gateBackorder } from '../lib/effective-inventory';

// ==========================================
// Recommendation Service
// Handles manual product relations (cross-sell, upsell)
// and auto-calculated Frequently Bought Together (FBT)
// ==========================================

const CACHE_TTL_SECONDS = 300; // 5 minutes
const FBT_WINDOW_DAYS = 90;
const FBT_MIN_THRESHOLD = 2;
const FBT_LOCK_TTL_SECONDS = 300;
// Cart cross-sell: slots shown, and how many scored candidates are read to fill them.
const CART_RECS_SHOWN = 4;
const CART_RECS_CANDIDATES = 12;

// Minimal product shape returned in recommendation lists
const productSelect = {
  id: true,
  name: true,
  nameAr: true,
  slug: true,
  price: true,
  compareAtPrice: true,
  // The web mapper already forwards these to the discount badge; without them
  // a fixed-amount sale read as a percentage on the recommendation cards only.
  discountType: true,
  discountValue: true,
  // Stock (C-01, 2026-10-15). The cards decide quick-add vs "choose options"
  // vs sold-out from `inStock` / `acceptsBackorder` / `variants`, which
  // `enrichStockFlags` derives from these exactly as the listing does; the
  // storefront used to hard-code `inStock: true` because nothing here said
  // otherwise. `lowStockThreshold` is read and stripped by enrichStockFlags.
  // CACHE CLASS: BOUNDED-stale (the 5-minute CACHE_TTL_SECONDS below). The
  // card is a hint; the cart API re-reads stock uncached and refuses an
  // oversell, so the residual is a sold-out card that still offers the add
  // for at most 5 minutes and then gets a refusal toast.
  inventory: true,
  allowBackorder: true,
  lowStockThreshold: true,
  trackInventory: true,
  // Merchant-authored card badge. The FBT grid and the "You might also like"
  // strip render through StorefrontProductCard / ProductCarousel — the same
  // canonical card components as the PLP — so a badge omitted here shows up
  // as "the badge works everywhere except the recommendation strips".
  badgeLabel: true,
  badgeLabelAr: true,
  // Card fact chips. BOUNDED-stale within the 5-minute recommendation cache.
  facts: true,
  // Card "New" badge: every card path reads isProductNew (createdAt inside the
  // window). Without it the badge never rendered on these strips.
  createdAt: true,
  images: {
    take: 2, // primary + hover-reveal second image on recommendation cards
    orderBy: { position: 'asc' as const },
    select: { url: true, alt: true },
  },
  // Include variants so the storefront can detect variant-parent products
  // and gate the "Add to cart" / "Add all to cart" flows accordingly —
  // without this, the FBT "Add all" button silently adds the parent SKU
  // (no variant chosen) which either errors out or creates ambiguous
  // cart lines. Same gap fixed earlier on listPublic in commit `8c55a73`.
  // `isActive` is read (a disabled variant is not stock) and stripped by
  // enrichStockFlags. Every variant row comes back, disabled ones included: a
  // product whose variants are all disabled is still a variant product.
  variants: {
    select: {
      id: true,
      price: true,
      compareAtPrice: true,
      inventory: true,
      allowBackorder: true,
      isActive: true,
    },
  },
  // Colour dots on the recommendation cards (same payload as the listing).
  // CACHE CLASS: BOUNDED-stale; these lists sit behind the 5-minute
  // CACHE_TTL_SECONDS cache, so a swatch edit shows within that window.
  options: LISTING_SWATCH_OPTIONS_SELECT,
};

// FBT cron handle
let fbtCronTimer: ReturnType<typeof setInterval> | null = null;

// ==========================================
// Recommendation Service Class
// ==========================================

class RecommendationService {
  // ----------------------------------------
  // getProductRecommendations
  // ----------------------------------------
  async getProductRecommendations(storeId: string, productId: string) {
    const cacheKey = `recommendations:product:${storeId}:${productId}`;

    // 1. Check cache
    const cached = await redis.get<{
      crossSell: unknown[];
      upsell: unknown[];
      alsoLike: unknown[];
    }>(cacheKey, true);
    if (cached) {
      return cached;
    }

    // 2. Cross-sell: manual relations first, fall back to FBT
    let crossSell: unknown[] = [];

    const manualCrossSell = await (
      await storeWriter(storeId)
    ).productRelation.findMany({
      where: {
        storeId,
        sourceProductId: productId,
        type: 'cross_sell',
        targetProduct: visibleProductWhere(),
      },
      orderBy: { position: 'asc' },
      take: 4,
      select: {
        id: true,
        targetProduct: { select: productSelect },
        position: true,
      },
    });

    if (manualCrossSell.length > 0) {
      crossSell = manualCrossSell.map(r => ({
        relationId: r.id,
        position: r.position,
        ...enrichStockFlags(r.targetProduct),
      }));
    } else {
      // AI recommendations — second priority after manual cross-sells.
      // When the bulk-ai-recommendations sweep has been run for this store
      // these rows are populated and ordered by Gemini confidence score.
      //
      // `ai_recommendation` has a STRICT RLS policy and the public
      // `/public/:storeId/products/:productId/recommendations` route runs
      // with no tenant context (recommendation.routes.ts is deliberately
      // context-less, see routes/index.ts) — so under `ebda_app` this read
      // returned [] and the storefront silently fell back to FBT.
      const aiRecRows = await readInStoreContext(storeId, async () =>
        (await storeDb(storeId)).aiRecommendation.findMany({
          where: { storeId, sourceProductId: productId, targetProduct: visibleProductWhere() },
          orderBy: { score: 'desc' },
          take: 4,
          select: {
            targetProduct: { select: productSelect },
            score: true,
            reason: true,
          },
        })
      );

      if (aiRecRows.length > 0) {
        crossSell = aiRecRows.map(r => ({
          aiScore: r.score,
          aiReason: r.reason,
          ...enrichStockFlags(r.targetProduct),
        }));
      } else {
        // FBT fallback — used when no AI recs exist for this product yet.
        const fbtRows = await (
          await storeDb(storeId)
        ).frequentlyBoughtTogether.findMany({
          where: {
            storeId,
            OR: [{ productId1: productId }, { productId2: productId }],
            product1: visibleProductWhere(),
            product2: visibleProductWhere(),
          },
          orderBy: { coOccurrenceCount: 'desc' },
          take: 4,
          select: {
            productId1: true,
            productId2: true,
            coOccurrenceCount: true,
            product1: { select: productSelect },
            product2: { select: productSelect },
          },
        });

        crossSell = fbtRows.map(row => {
          const isSource = row.productId1 === productId;
          return {
            coOccurrenceCount: row.coOccurrenceCount,
            ...enrichStockFlags(isSource ? row.product2 : row.product1),
          };
        });
      }
    }

    // 3. Upsell: manual relations
    const upsellRows = await (
      await storeWriter(storeId)
    ).productRelation.findMany({
      where: {
        storeId,
        sourceProductId: productId,
        type: 'upsell',
        targetProduct: visibleProductWhere(),
      },
      orderBy: { position: 'asc' },
      take: 4,
      select: {
        id: true,
        targetProduct: { select: productSelect },
        position: true,
      },
    });
    const upsell = upsellRows.map(r => ({
      relationId: r.id,
      position: r.position,
      ...enrichStockFlags(r.targetProduct),
    }));

    // 4. Also Like: products from same categories
    const alreadyReturnedIds = new Set<string>([
      productId,
      ...crossSell.map((p: any) => p.id),
      ...upsell.map((p: any) => p.id),
    ]);

    const productCategories = await (
      await storeWriter(storeId)
    ).productCategory.findMany({
      where: { productId },
      select: { categoryId: true },
    });
    const categoryIds = productCategories.map(pc => pc.categoryId);

    let alsoLike: unknown[] = [];
    if (categoryIds.length > 0) {
      const alsoLikeRows = await (
        await storeWriter(storeId)
      ).product.findMany({
        where: {
          storeId,
          status: 'active',
          deletedAt: null,
          ...visibleProductWhere(),
          id: { notIn: Array.from(alreadyReturnedIds) },
          categories: {
            some: { categoryId: { in: categoryIds } },
          },
        },
        take: 6,
        select: productSelect,
      });
      alsoLike = alsoLikeRows.map(p => enrichStockFlags(p));
    }

    const result = { crossSell, upsell, alsoLike };

    // 5. Cache result
    await redis.set(cacheKey, result, CACHE_TTL_SECONDS);

    return result;
  }

  // ----------------------------------------
  // getCartRecommendations (not cached)
  // ----------------------------------------
  /**
   * `backorderFeatureEnabled` (default true = the old behaviour): with the store's
   * `inventory.backorder` feature OFF a sold-out backorderable product is not
   * buyable, so it is gated BEFORE the "keep only buyable picks" filter — a
   * feature-off store never fills a recommendation slot with a sold-out card.
   */
  async getCartRecommendations(
    storeId: string,
    productIds: string[],
    backorderFeatureEnabled = true
  ) {
    if (!productIds.length) return [];

    const scoreMap = new Map<string, number>();
    const productIdSet = new Set(productIds);

    // Batch the manual cross-sell + FBT lookups instead of running
    // two queries per cart item. Storefront cart pages with 4 items
    // used to issue 8 queries to render the "you might also like"
    // strip; now it's two queries regardless of cart size.
    const [manualRows, fbtRows] = await Promise.all([
      (await storeWriter(storeId)).productRelation.findMany({
        where: {
          storeId,
          sourceProductId: { in: productIds },
          type: 'cross_sell',
          targetProduct: visibleProductWhere(),
        },
        orderBy: { position: 'asc' },
        select: { sourceProductId: true, targetProductId: true },
      }),
      (await storeDb(storeId)).frequentlyBoughtTogether.findMany({
        where: {
          storeId,
          OR: [{ productId1: { in: productIds } }, { productId2: { in: productIds } }],
          product1: visibleProductWhere(),
          product2: visibleProductWhere(),
        },
        orderBy: { coOccurrenceCount: 'desc' },
        select: { productId1: true, productId2: true },
      }),
    ]);

    const manualBySource = new Map<string, string[]>();
    for (const r of manualRows) {
      const arr = manualBySource.get(r.sourceProductId);
      if (arr) arr.push(r.targetProductId);
      else manualBySource.set(r.sourceProductId, [r.targetProductId]);
    }

    for (const productId of productIds) {
      // Manual cross-sell first; per-product cap of 8 mirrors the
      // pre-batched query that used `take: 8`.
      const manual = (manualBySource.get(productId) ?? []).slice(0, 8);
      if (manual.length > 0) {
        for (const targetId of manual) {
          if (!productIdSet.has(targetId)) {
            scoreMap.set(targetId, (scoreMap.get(targetId) ?? 0) + 1);
          }
        }
      } else {
        // FBT fallback for products without manual cross-sells
        let added = 0;
        for (const row of fbtRows) {
          if (added >= 8) break;
          const isLeftMatch = row.productId1 === productId;
          const isRightMatch = row.productId2 === productId;
          if (!isLeftMatch && !isRightMatch) continue;
          const targetId = isLeftMatch ? row.productId2 : row.productId1;
          if (productIdSet.has(targetId)) continue;
          scoreMap.set(targetId, (scoreMap.get(targetId) ?? 0) + 1);
          added++;
        }
      }
    }

    // Sort by reference count. Read up to 12 candidates and keep the first 4
    // a shopper can actually buy: a sold-out pick (no backorder) used to take
    // one of the 4 slots as a dead card (W1a review, item 4).
    const sortedIds = Array.from(scoreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, CART_RECS_CANDIDATES)
      .map(([id]) => id);

    if (!sortedIds.length) return [];

    const products = await (
      await storeWriter(storeId)
    ).product.findMany({
      where: {
        id: { in: sortedIds },
        storeId,
        status: 'active',
        deletedAt: null,
        ...visibleProductWhere(),
      },
      select: productSelect,
    });

    // Preserve score order
    return sortedIds
      .map(id => products.find((p: any) => p.id === id))
      .filter(Boolean)
      .map(p => gateBackorder(enrichStockFlags(p!), backorderFeatureEnabled))
      .filter(p => p.inStock || p.acceptsBackorder)
      .slice(0, CART_RECS_SHOWN);
  }

  // ----------------------------------------
  // setProductRelations — bulk replace
  // ----------------------------------------
  async setProductRelations(
    storeId: string,
    productId: string,
    relations: Array<{ targetProductId: string; type: string; position?: number }>
  ) {
    // Replace-all is one atomic batch (a half-applied replace would leave the product with no relations).
    const w = await storeWriter(storeId);
    await w.$transaction([
      w.productRelation.deleteMany({ where: { storeId, sourceProductId: productId } }),
      ...(relations.length > 0
        ? [
            w.productRelation.createMany({
              data: relations.map((r, idx) => ({
                storeId,
                sourceProductId: productId,
                targetProductId: r.targetProductId,
                type: r.type,
                position: r.position ?? idx,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    await this.invalidateCache(storeId, productId);
  }

  // ----------------------------------------
  // addRelation — single
  // ----------------------------------------
  async addRelation(
    storeId: string,
    productId: string,
    relation: { targetProductId: string; type: string; position?: number }
  ) {
    // Count existing to set position
    const count = await (
      await storeWriter(storeId)
    ).productRelation.count({
      where: { storeId, sourceProductId: productId, type: relation.type },
    });

    const created = await (
      await storeWriter(storeId)
    ).productRelation.create({
      data: {
        storeId,
        sourceProductId: productId,
        targetProductId: relation.targetProductId,
        type: relation.type,
        position: relation.position ?? count,
      },
    });

    await this.invalidateCache(storeId, productId);
    return created;
  }

  // ----------------------------------------
  // removeRelation — single
  // ----------------------------------------
  async removeRelation(storeId: string, productId: string, relationId: string) {
    const relation = await (
      await storeWriter(storeId)
    ).productRelation.findFirst({
      where: { id: relationId, storeId, sourceProductId: productId },
    });

    if (!relation) {
      throw new AppError(404, 'NOT_FOUND', 'Relation not found');
    }

    await (
      await storeWriter(storeId)
    ).productRelation.delete({ where: { id: relationId, storeId } });
    await this.invalidateCache(storeId, productId);
  }

  // ----------------------------------------
  // getRelations — all relations with target details
  // ----------------------------------------
  async getRelations(storeId: string, productId: string) {
    return (await storeWriter(storeId)).productRelation.findMany({
      where: { storeId, sourceProductId: productId },
      orderBy: [{ type: 'asc' }, { position: 'asc' }],
      select: {
        id: true,
        type: true,
        position: true,
        createdAt: true,
        targetProduct: { select: productSelect },
      },
    });
  }

  // ----------------------------------------
  // recalculateFBT
  // ----------------------------------------
  async recalculateFBT(storeId: string) {
    const lockName = `fbt:calculating:${storeId}`;
    const acquired = await redis.acquireLock(lockName, FBT_LOCK_TTL_SECONDS);

    if (!acquired) {
      logger.info({ storeId }, '[FBT] Calculation already in progress, skipping');
      return;
    }

    try {
      logger.info({ storeId }, '[FBT] Starting recalculation');

      const since = new Date(Date.now() - FBT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      // Fetch completed orders with 2+ items in the window
      const orders = await (
        await storeDb(storeId)
      ).order.findMany({
        where: {
          storeId,
          status: { in: ['delivered', 'shipped', 'processing', 'confirmed'] },
          createdAt: { gte: since },
          items: { some: {} },
        },
        select: {
          id: true,
          items: { select: { productId: true } },
        },
      });

      // Count co-occurrences
      const pairCounts = new Map<string, number>();
      for (const order of orders) {
        const productIds = [...new Set(order.items.map((i: any) => i.productId))];
        if (productIds.length < 2) continue;

        for (let i = 0; i < productIds.length; i++) {
          for (let j = i + 1; j < productIds.length; j++) {
            const a = productIds[i];
            const b = productIds[j];
            // Normalize: smaller ID first
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
          }
        }
      }

      // Upsert pairs that meet threshold
      const validPairs = Array.from(pairCounts.entries()).filter(
        ([, count]) => count >= FBT_MIN_THRESHOLD
      );
      const upsertedPairKeys = new Set<string>();

      for (const [key, count] of validPairs) {
        const [productId1, productId2] = key.split(':');
        upsertedPairKeys.add(key);

        await (
          await storeWriter(storeId)
        ).frequentlyBoughtTogether.upsert({
          where: { storeId_productId1_productId2: { storeId, productId1, productId2 } },
          update: { coOccurrenceCount: count, lastCalculatedAt: new Date() },
          create: {
            storeId,
            productId1,
            productId2,
            coOccurrenceCount: count,
            lastCalculatedAt: new Date(),
          },
        });
      }

      // Delete stale rows (pairs no longer meeting threshold)
      const existingRows = await (
        await storeDb(storeId)
      ).frequentlyBoughtTogether.findMany({
        where: { storeId },
        select: { id: true, productId1: true, productId2: true },
      });

      const staleIds = existingRows
        .filter(row => {
          const key = `${row.productId1}:${row.productId2}`;
          return !upsertedPairKeys.has(key);
        })
        .map(row => row.id);

      if (staleIds.length > 0) {
        await (
          await storeWriter(storeId)
        ).frequentlyBoughtTogether.deleteMany({
          where: { storeId, id: { in: staleIds } },
        });
      }

      // Invalidate all recommendation caches for this store
      await this.invalidateStoreCache(storeId);

      logger.info(
        { storeId, pairsCalculated: validPairs.length, staleRemoved: staleIds.length },
        '[FBT] Recalculation complete'
      );
    } finally {
      await redis.releaseLock(lockName);
    }
  }

  // ----------------------------------------
  // FBT Cron
  // ----------------------------------------
  startFBTCron(intervalMs: number, storeIds: string[]) {
    if (fbtCronTimer) {
      logger.warn('[FBT] Cron already running, skipping start');
      return;
    }

    fbtCronTimer = setInterval(async () => {
      // Leader election: only one replica executes the FBT recalculation per
      // tick so we don't duplicate Prisma writes across Railway instances.
      await withLeaderLock('fbt-recalculation', intervalMs, async () => {
        logger.info({ storeIds }, '[FBT] Running scheduled recalculation');
        for (const storeId of storeIds) {
          try {
            await this.recalculateFBT(storeId);
          } catch (err) {
            logger.error({ err, storeId }, '[FBT] Scheduled recalculation failed');
          }
        }
      }).catch(err => {
        logger.error({ err }, '[FBT] Leader-lock acquisition error');
      });
    }, intervalMs);

    logger.info({ intervalMs }, '[FBT] Cron started');
  }

  stopFBTCron() {
    if (fbtCronTimer) {
      clearInterval(fbtCronTimer);
      fbtCronTimer = null;
      logger.info('[FBT] Cron stopped');
    }
  }

  // ----------------------------------------
  // getStats
  // ----------------------------------------
  async getStats(storeId: string) {
    const fbtCount = await (
      await storeDb(storeId)
    ).frequentlyBoughtTogether.count({ where: { storeId } });

    const lastRow = await (
      await storeDb(storeId)
    ).frequentlyBoughtTogether.findFirst({
      where: { storeId },
      orderBy: { lastCalculatedAt: 'desc' },
      select: { lastCalculatedAt: true },
    });

    return {
      fbtPairCount: fbtCount,
      lastCalculatedAt: lastRow?.lastCalculatedAt ?? null,
    };
  }

  // ----------------------------------------
  // Cache helpers
  // ----------------------------------------
  private async invalidateCache(storeId: string, productId: string) {
    await redis.delete(`recommendations:product:${storeId}:${productId}`);
  }

  // Public wrapper so Inngest cleanup functions can invalidate a product's
  // recommendation cache without accessing the private method directly.
  async invalidateProductCache(storeId: string, productId: string) {
    await this.invalidateCache(storeId, productId);
  }

  private async invalidateStoreCache(storeId: string) {
    // Best-effort: individual product caches expire within 5 min anyway.
    // If Redis client is available, use scan to remove all matching keys.
    const client = redis.getClient();
    if (!client) return;

    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          'MATCH',
          `cache:recommendations:product:${storeId}:*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await client.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.warn({ err, storeId }, '[FBT] Failed to invalidate store recommendation cache');
    }
  }
}

export const recommendationService = new RecommendationService();
