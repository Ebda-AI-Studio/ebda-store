/**
 * Abandoned Cart Service
 *
 * Periodically detects abandoned carts and sends step-by-step recovery
 * reminders via the notification dispatcher.
 *
 * Processing lifecycle:
 *   startProcessing() → setInterval → process()
 *     ├─ detectNewAbandonments()  — find carts idle >1h, create AbandonedCart records
 *     └─ processReminders()       — send scheduled reminder steps
 */

import {
  prisma,
  acrossStoresFlat,
  currentStoreId,
  runInStoreScope,
  storeDirectory,
} from '@ebda/database';
import { storefrontOrigin } from '@ebda/shared';
import { PriceResolver } from './price-resolver.service';
import { buyerFromCartOwner } from '../lib/buyer-identity';
import { redis } from './redis.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import { resolveBundle } from './bundle.service';
import { featureService } from './feature.service';
import { storeDb, storeRepo, storeWriter, type StoreReads } from '../lib/repo-factory';
import {
  sweepCartRecoveryEmails,
  CART_EMAIL_DEFAULT_DELAY_MINUTES,
} from './cart-recovery-email.service';
import logger from '../lib/logger';
import { sendEventAfterCommit } from '../lib/inngest/send-after-commit';
import crypto from 'crypto';
import { config } from '../config';
import type { NotificationData, NotificationEvent } from '@ebda/shared';

// ==========================================
// Constants / Types
// ==========================================

const LOCK_KEY = 'abandoned-cart:processing';
const LOCK_TTL_SECONDS = 60;
const ABANDONMENT_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

interface AbandonedCartConfigDefaults {
  step1Enabled: boolean;
  step1DelayMinutes: number;
  step2Enabled: boolean;
  step2DelayMinutes: number;
  step3Enabled: boolean;
  step3DelayMinutes: number;
  autoCouponEnabled: boolean;
  couponDiscountPercent: number;
  couponMaxDiscount: number | null;
  couponExpiryHours: number;
  /** Recovery email channel (cart-recovery-email.service). OFF until the merchant opts in. */
  emailEnabled: boolean;
  emailDelayMinutes: number;
}

const DEFAULT_CONFIG: AbandonedCartConfigDefaults = {
  step1Enabled: true,
  step1DelayMinutes: 60,
  step2Enabled: true,
  step2DelayMinutes: 240,
  step3Enabled: true,
  step3DelayMinutes: 1440,
  autoCouponEnabled: true,
  couponDiscountPercent: 10,
  couponMaxDiscount: null,
  couponExpiryHours: 48,
  emailEnabled: false,
  emailDelayMinutes: CART_EMAIL_DEFAULT_DELAY_MINUTES,
};

interface CartItemSnapshot {
  productName: string;
  productImage: string | null;
  price: number;
  quantity: number;
  /**
   * Set on a snapshot row built from a `CartBundle` (never expanded into
   * per-component rows here, mirroring the cart/checkout rule that a
   * bundle is always ONE line). `price` on a bundle row is always
   * `resolveBundle(...).price` — the bundle's sale price — NEVER the sum
   * of its per-component allocated shares (`componentSum`), which must
   * never reach a customer-facing surface.
   */
  isBundle?: boolean;
}

/**
 * Stores whose EFFECTIVE `feature` entitlement is on: the plan baseline OR a `store_features`
 * override, exactly what `featureService` resolves for the request paths. Detection used to
 * ask only for an enabled `store_features` ROW, so a store entitled purely by its plan (every
 * plan has `abandoned_cart` in STARTER_CORE; no row exists) was never swept and push, SMS and the
 * email channel silently never fired for it. `storeDirectory` lists stores through the definer
 * (stores is under RLS); the feature map is cached 5 min per store (BOUNDED-stale).
 */
async function storeIdsWithFeature(feature: 'abandoned_cart'): Promise<string[]> {
  const stores = await storeDirectory();
  const out: string[] = [];
  const CHUNK = 20;
  for (let i = 0; i < stores.length; i += CHUNK) {
    const part = stores.slice(i, i + CHUNK);
    const flags = await Promise.all(
      part.map(st => featureService.isFeatureEnabled(st.id, feature).catch(() => false))
    );
    part.forEach((st, j) => {
      if (flags[j]) out.push(st.id);
    });
  }
  return out;
}

// ==========================================
// Abandoned Cart Service
// ==========================================

class AbandonedCartService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // ──────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────

  startProcessing(intervalMs = 900_000): void {
    if (this.intervalHandle) {
      logger.warn('[AbandonedCart] Already running — ignoring startProcessing() call');
      return;
    }

    logger.info({ intervalMs }, '[AbandonedCart] Starting processing loop');
    this.intervalHandle = setInterval(() => {
      this.process().catch(err => {
        logger.error({ err }, '[AbandonedCart] Unhandled error in process()');
      });
    }, intervalMs);
  }

  stopProcessing(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('[AbandonedCart] Processing loop stopped');
    }
  }

  // ──────────────────────────────────────────
  // Main Process
  // ──────────────────────────────────────────

  async process(): Promise<void> {
    const correlationId = crypto.randomBytes(8).toString('hex');

    // Acquire distributed lock to prevent concurrent runs across multiple instances
    const lockAcquired = await redis.acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
    if (!lockAcquired) {
      logger.debug(
        { correlationId },
        '[AbandonedCart] Lock not acquired — another instance is processing'
      );
      return;
    }

    try {
      logger.info({ correlationId }, '[AbandonedCart] Processing started');

      await this.detectNewAbandonments(correlationId);

      await this.processReminders(correlationId);

      // Email channel (own state in email_status, independent of the push/SMS steps). A failure
      // here must not fail the sweep that already ran the other channels.
      try {
        await sweepCartRecoveryEmails();
      } catch (err) {
        logger.error({ err, correlationId }, '[AbandonedCart] Email sweep failed');
      }

      logger.info({ correlationId }, '[AbandonedCart] Processing completed');
    } catch (err) {
      logger.error({ err, correlationId }, '[AbandonedCart] Processing failed');
    } finally {
      await redis.releaseLock(LOCK_KEY);
    }
  }

  // ──────────────────────────────────────────
  // Step 1: Detect New Abandonments
  // ──────────────────────────────────────────

  async detectNewAbandonments(correlationId?: string): Promise<void> {
    // Stores with the EFFECTIVE abandoned_cart entitlement (plan baseline OR override row).
    const storeFeatureIds = await storeIdsWithFeature('abandoned_cart');

    if (storeFeatureIds.length === 0) {
      logger.debug(
        { correlationId },
        '[AbandonedCart] No stores have abandoned_cart feature enabled'
      );
      return;
    }

    const storeIds = storeFeatureIds;
    const abandonmentCutoff = new Date(Date.now() - ABANDONMENT_THRESHOLD_MS);

    logger.info(
      { correlationId, storeCount: storeIds.length },
      '[AbandonedCart] Scanning stores for abandoned carts'
    );

    for (const storeId of storeIds) {
      await runInStoreScope(storeId, async () => {
        // Find carts that:
        // 1. Haven't been active for >1 hour
        // 2. Have at least one item OR at least one bundle — a bundle-only
        //    cart (no `CartItem` rows at all; a bundle is never expanded into
        //    `cart_items`, see cart.service.ts's file doc comment) must be
        //    detected exactly like a loose-item cart. A store without the
        //    `bundles` feature can never have a `CartBundle` row (bundle
        //    creation is itself feature-gated), so this OR arm is a no-op —
        //    0 extra matches, 0 extra work — for every such store.
        // 3. Don't already have an AbandonedCart record
        // 4. Have a customer with email or phone (so we can actually reach them)
        const carts = await prisma.cart.findMany({
          where: {
            storeId,
            lastActivityAt: { lt: abandonmentCutoff },
            abandonedCart: null,
            AND: [
              { OR: [{ items: { some: {} } }, { bundles: { some: {} } }] },
              {
                OR: [
                  { customer: { OR: [{ email: { not: '' } }, { phone: { not: null } }] } },
                  // A guest (or any shopper) who ticked the checkout box "email me about my
                  // cart": reachable by the email channel only. Consent is re-checked at send time.
                  { guestEmail: { not: null }, guestEmailConsentAt: { not: null } },
                ],
              },
            ],
          },
          include: {
            customer: {
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            },
            items: {
              include: {
                product: {
                  include: { images: { take: 1, orderBy: { position: 'asc' } } },
                },
                variant: { select: { price: true } },
              },
            },
            // Raw rows only — display fields (name/image) and price come from
            // `resolveBundle` below, recomputed live, same as every other
            // cart-bundle read in this codebase (see cart.service.ts).
            bundles: true,
          },
        });

        // Hoist the per-store config lookup out of the per-cart loop. It's
        // identical for every iteration of this sweep and previously cost
        // one query per detected abandoned cart — N+1 against
        // `abandoned_cart_configs` for no semantic benefit.
        const storeConfig = await this.getConfig(storeId);
        const nextStepAtFromConfig = storeConfig.step1Enabled
          ? () => new Date(Date.now() + storeConfig.step1DelayMinutes * 60 * 1000)
          : () => null;

        for (const cart of carts) {
          try {
            // Price the cart as its OWNER would see it (their session-written customer id, else anonymous), through the one
            // resolver: tiers, group price and MOQ included, so the recovery email shows what checkout will charge.
            // Soft-deleted lines are not orderable and are priced out everywhere else (cart.service), so they neither
            // reach the resolver nor the snapshot / total (design review M-6).
            const liveItems = cart.items.filter(item => !item.product.deletedAt);
            const resolver = await PriceResolver.forBuyer(
              storeId,
              buyerFromCartOwner(cart.customerId)
            );
            const priced = await resolver.priceCart(
              liveItems.map(item => ({
                key: item.id,
                product: { id: item.productId, price: item.product.price, moq: item.product.moq },
                variant: item.variantId
                  ? { id: item.variantId, price: item.variant?.price ?? null }
                  : null,
                qty: item.quantity,
              }))
            );
            const unitOf = (item: { id: string }) => priced.get(item.id)!.unitMinor;
            // Build a snapshot of cart items at abandonment time
            const itemSnapshot: CartItemSnapshot[] = liveItems.map(item => ({
              productName: item.product.name,
              productImage: item.product.images[0]?.url ?? null,
              price: unitOf(item),
              quantity: item.quantity,
            }));

            // Each `CartBundle` row becomes ONE snapshot line, priced at
            // `resolveBundle(...).price` — the bundle's sale price, never the
            // sum of its per-component allocated shares (`componentSum`,
            // which never reaches a customer-facing surface — see
            // `ResolvedBundle`'s doc comment in bundle.service.ts). A bundle
            // reference that fails to resolve (e.g. a stale/cross-store row —
            // see `tryResolveCartBundle` in cart.service.ts for the same
            // defensive pattern) is dropped from the snapshot rather than
            // failing the whole detection for this cart.
            const bundleSnapshot: CartItemSnapshot[] = (
              await Promise.all(
                cart.bundles.map(async (cb): Promise<CartItemSnapshot | null> => {
                  try {
                    const resolved = await resolveBundle(prisma, storeId, cb.bundleId);
                    return {
                      productName: resolved.name,
                      productImage: resolved.image,
                      price: resolved.price,
                      quantity: cb.quantity,
                      isBundle: true,
                    };
                  } catch (err) {
                    logger.warn(
                      { err, correlationId, storeId, cartId: cart.id, bundleId: cb.bundleId },
                      '[AbandonedCart] Failed to resolve cart bundle — omitting from snapshot'
                    );
                    return null;
                  }
                })
              )
            ).filter((b): b is CartItemSnapshot => b !== null);

            // Calculate total from snapshot (price is in piastres / integer cents) —
            // per chosen variant price, matching cart/checkout. Bundles add
            // their resolved bundle price x quantity, exactly like the
            // storefront cart's own `bundlesSubtotal` (cart.service.ts).
            const cartTotal =
              liveItems.reduce((sum, item) => sum + unitOf(item) * item.quantity, 0) +
              bundleSnapshot.reduce((sum, b) => sum + b.price * b.quantity, 0);

            const cartItemCount = liveItems.length + bundleSnapshot.length;

            // Push/SMS steps need a customer (a phone, an account); a guest cart has neither, so it
            // gets no push/SMS sequence and only the email channel serves it.
            const nextStepAt = cart.customer ? nextStepAtFromConfig() : null;

            // The address the shopper consented to at checkout wins over the account email.
            const customerEmail =
              (cart.guestEmailConsentAt ? cart.guestEmail : null) ?? cart.customer?.email ?? null;
            const customerPhone = cart.customer?.phone ?? null;

            await prisma.abandonedCart.create({
              data: {
                storeId,
                cartId: cart.id,
                customerId: cart.customerId ?? undefined,
                sessionId: cart.sessionId,
                customerEmail: customerEmail ?? undefined,
                customerPhone: customerPhone ?? undefined,
                cartTotal: cartTotal,
                cartItemCount,
                cartItems: [...itemSnapshot, ...bundleSnapshot] as any,
                status: 'pending',
                nextStepAt,
              },
            });

            // Ebda WhatsApp (contract section 4 `cart.abandoned`): the rule just fired for this cart.
            // The job drops it unless the store linked WhatsApp; the envelope id is seeded by the cart.
            if (customerPhone) {
              await sendEventAfterCommit(
                'wa-cart-abandoned',
                { name: 'cart/abandoned', data: { storeId, cartId: cart.id } },
                { ifUnhookable: 'send' }
              );
            }

            logger.info(
              { correlationId, storeId, cartId: cart.id, itemCount: cartItemCount },
              '[AbandonedCart] New abandoned cart detected'
            );
          } catch (err) {
            logger.error(
              { err, correlationId, storeId, cartId: cart.id },
              '[AbandonedCart] Failed to create abandoned cart record — skipping'
            );
          }
        }
      });
    }
  }

  // ──────────────────────────────────────────
  // Step 2: Process Reminders
  // ──────────────────────────────────────────

  async processReminders(correlationId?: string): Promise<void> {
    const now = new Date();

    const pending = await acrossStoresFlat(storeId =>
      prisma.abandonedCart.findMany({
        where: {
          storeId,
          status: { in: ['pending', 'step1_sent', 'step2_sent'] },
          nextStepAt: { lte: now },
        },
        include: {
          store: { select: { id: true, name: true, domain: true, slug: true } },
          customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
        },
      })
    );

    logger.info(
      { correlationId, count: pending.length },
      '[AbandonedCart] Processing due reminders'
    );

    for (const abandonedCart of pending) {
      try {
        // Only carts still in the reminder sequence get their next step.
        if (
          abandonedCart.status === 'pending' ||
          abandonedCart.status === 'step1_sent' ||
          abandonedCart.status === 'step2_sent'
        ) {
          const nextStep = this.getNextStep(abandonedCart.status);
          if (nextStep !== null) {
            await runInStoreScope(abandonedCart.storeId, () =>
              this.sendStep(abandonedCart, nextStep)
            );
          }
        }
      } catch (err) {
        logger.error(
          { err, correlationId, abandonedCartId: abandonedCart.id },
          '[AbandonedCart] Failed to process reminder — skipping'
        );
      }
    }
  }

  // ──────────────────────────────────────────
  // Send a Reminder Step
  // ──────────────────────────────────────────

  async sendStep(abandonedCart: any, stepNumber: 1 | 2 | 3): Promise<void> {
    const storeId = abandonedCart.storeId;
    const storeConfig = await this.getConfig(storeId);

    // Check if this step is enabled; if not, find the next enabled step
    const stepEnabled = this.isStepEnabled(storeConfig, stepNumber);
    if (!stepEnabled) {
      // Try to advance to next enabled step
      const nextEnabledStep = this.findNextEnabledStep(storeConfig, (stepNumber + 1) as 2 | 3 | 4);
      if (nextEnabledStep === null) {
        // No more steps — expire the record
        await prisma.abandonedCart.update({
          where: { id: abandonedCart.id, storeId },
          data: { status: 'expired', nextStepAt: null },
        });
        logger.info(
          { abandonedCartId: abandonedCart.id, stepNumber },
          '[AbandonedCart] No more enabled steps — marking expired'
        );
        return;
      }
      // Recurse with the next enabled step
      return this.sendStep(abandonedCart, nextEnabledStep);
    }

    // The reminder links to the store's cart page — no `?recover=&sig=`
    // params (owner decision 2026-10-01, issue 2035). Nothing on the
    // storefront ever read them, the snapshot could not restore a cart (no
    // product/variant ids), and the signed link never expired, so the
    // recovery flow they implied did not exist.
    const storeDomain = abandonedCart.store ? storefrontOrigin(abandonedCart.store) : config.webUrl;

    const cartUrl = `${storeDomain}/cart`;

    // Step 3: generate a coupon if auto-coupon is enabled
    let couponCode: string | null = null;
    if (stepNumber === 3 && storeConfig.autoCouponEnabled) {
      couponCode = await this.generateRecoveryCoupon(storeId, abandonedCart.id, storeConfig);
    }

    // Build notification data
    const customerName = abandonedCart.customer
      ? `${abandonedCart.customer.firstName} ${abandonedCart.customer.lastName}`.trim()
      : 'Customer';
    const cartTotalFormatted = (abandonedCart.cartTotal / 1000).toFixed(3); // piastres → EGP

    const notificationData: NotificationData = {
      customerName,
      customerPhone: abandonedCart.customerPhone ?? undefined,
      orderNumber: abandonedCart.id, // no order number at abandonment stage; use record ID
      storeId,
      storeName: abandonedCart.store?.name ?? '',
      cartUrl,
      cartTotal: cartTotalFormatted,
      cartItemCount: abandonedCart.cartItemCount,
      couponCode: couponCode ?? undefined,
    };

    const event: NotificationEvent = `cart_abandoned_step${stepNumber}` as NotificationEvent;

    // Dispatch (fire-and-forget; dispatcher never throws)
    await notificationDispatcher.dispatch(storeId, event, notificationData);

    logger.info(
      { abandonedCartId: abandonedCart.id, storeId, stepNumber },
      '[AbandonedCart] Reminder dispatched'
    );

    // Compute next step timing
    const nextStep = this.findNextEnabledStep(storeConfig, (stepNumber + 1) as 2 | 3 | 4);
    const nextStepAt =
      nextStep !== null
        ? new Date(Date.now() + this.getStepDelayMinutes(storeConfig, nextStep) * 60 * 1000)
        : null;

    const newStatus = `step${stepNumber}_sent`;

    const updateData: Record<string, any> = {
      status: nextStep !== null ? newStatus : 'expired',
      nextStepAt,
    };
    updateData[`step${stepNumber}SentAt`] = new Date();

    if (couponCode && stepNumber === 3) {
      // couponId is updated inside generateRecoveryCoupon via separate update
    }

    await prisma.abandonedCart.update({
      where: { id: abandonedCart.id, storeId },
      data: updateData,
    });
  }

  // ──────────────────────────────────────────
  // Generate Recovery Coupon
  // ──────────────────────────────────────────

  async generateRecoveryCoupon(
    storeId: string,
    abandonedCartId: string,
    storeConfig: AbandonedCartConfigDefaults
  ): Promise<string | null> {
    try {
      // Deterministic code — same cart always gets the same coupon code
      const hash = crypto
        .createHash('sha256')
        .update(abandonedCartId + storeId)
        .digest('hex');
      const code = `RECOVER-${hash.substring(0, 6).toUpperCase()}`;

      const expiresAt = new Date(Date.now() + storeConfig.couponExpiryHours * 60 * 60 * 1000);

      // Coupon.value is Int (percentage 0–100 or fixed amount in piastres)
      // couponMaxDiscount is now Int (piastres) — use directly as Coupon.maxDiscount
      const maxDiscountInt =
        storeConfig.couponMaxDiscount !== null ? storeConfig.couponMaxDiscount : undefined;

      const coupon = await prisma.coupon.upsert({
        where: { storeId_code: { storeId, code } },
        create: {
          storeId,
          code,
          name: `Cart Recovery Coupon`,
          type: 'percentage',
          value: storeConfig.couponDiscountPercent,
          maxDiscount: maxDiscountInt,
          usageLimit: 1,
          usageLimitPerUser: 1,
          expiresAt,
          isActive: true,
        },
        update: {
          // Update expiry and ensure it's active (in case it was previously expired)
          expiresAt,
          isActive: true,
        },
      });

      // Link coupon to the abandoned cart
      await prisma.abandonedCart.update({
        where: { id: abandonedCartId, storeId },
        data: { couponId: coupon.id },
      });

      logger.info(
        { storeId, abandonedCartId, couponCode: code },
        '[AbandonedCart] Recovery coupon generated'
      );

      return code;
    } catch (err) {
      logger.error(
        { err, storeId, abandonedCartId },
        '[AbandonedCart] Failed to generate recovery coupon'
      );
      return null;
    }
  }

  // ──────────────────────────────────────────
  // Mark Recovered
  // ──────────────────────────────────────────

  async markRecovered(abandonedCartId: string, orderId: string): Promise<void> {
    await (
      await storeWriter(currentStoreId())
    ).abandonedCart.update({
      where: { id: abandonedCartId, storeId: currentStoreId() },
      data: {
        status: 'recovered',
        recoveredAt: new Date(),
        recoveredOrderId: orderId,
      },
    });

    logger.info({ abandonedCartId, orderId }, '[AbandonedCart] Cart marked as recovered');
  }

  // ──────────────────────────────────────────
  // Config
  // ──────────────────────────────────────────

  async getConfig(storeId: string): Promise<AbandonedCartConfigDefaults> {
    const row = await (
      await storeDb(storeId)
    ).abandonedCartConfig.findUnique({
      where: { storeId },
    });

    if (!row) {
      return { ...DEFAULT_CONFIG };
    }

    return {
      step1Enabled: row.step1Enabled,
      step1DelayMinutes: row.step1DelayMinutes,
      step2Enabled: row.step2Enabled,
      step2DelayMinutes: row.step2DelayMinutes,
      step3Enabled: row.step3Enabled,
      step3DelayMinutes: row.step3DelayMinutes,
      autoCouponEnabled: row.autoCouponEnabled,
      couponDiscountPercent: row.couponDiscountPercent,
      couponMaxDiscount: row.couponMaxDiscount,
      couponExpiryHours: row.couponExpiryHours,
      emailEnabled: row.emailEnabled,
      emailDelayMinutes: row.emailDelayMinutes,
    };
  }

  async upsertConfig(
    storeId: string,
    data: Partial<AbandonedCartConfigDefaults>
  ): Promise<AbandonedCartConfigDefaults> {
    const row = await (
      await storeWriter(storeId)
    ).abandonedCartConfig.upsert({
      where: { storeId },
      create: {
        storeId,
        ...data,
        couponMaxDiscount:
          data.couponMaxDiscount !== undefined ? data.couponMaxDiscount : undefined,
      },
      update: {
        ...data,
        couponMaxDiscount:
          data.couponMaxDiscount !== undefined ? data.couponMaxDiscount : undefined,
      },
    });

    return {
      step1Enabled: row.step1Enabled,
      step1DelayMinutes: row.step1DelayMinutes,
      step2Enabled: row.step2Enabled,
      step2DelayMinutes: row.step2DelayMinutes,
      step3Enabled: row.step3Enabled,
      step3DelayMinutes: row.step3DelayMinutes,
      autoCouponEnabled: row.autoCouponEnabled,
      couponDiscountPercent: row.couponDiscountPercent,
      couponMaxDiscount: row.couponMaxDiscount,
      couponExpiryHours: row.couponExpiryHours,
      emailEnabled: row.emailEnabled,
      emailDelayMinutes: row.emailDelayMinutes,
    };
  }

  // ──────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────

  /**
   * The abandoned-cart report.
   *
   * "Recovered" is LAST-TOUCH, not reminder-attributed (issue 2356):
   * `OrderService.createOrder` marks the store's open abandoned cart for the
   * same cart or customer `recovered` (with `recoveredAt` + `recoveredOrderId`)
   * inside the order transaction, whether or not a reminder was opened — the
   * recovery LINK was removed (issue 2035), the attribution write was not. So
   * these figures are a real measurement of "ordered after abandoning", and the
   * admin labels say exactly that. `markRecovered` (above) still has no caller.
   *
   * `recoveredRevenue` counts only orders that count as revenue elsewhere
   * (not cancelled/refunded, payment not failed — issue 2235; unpaid COD
   * counts), summed in SQL so the row count never loads into memory.
   */
  async getStats(storeId: string): Promise<{
    byStatus: Record<string, number>;
    totalAbandoned: number;
    totalRecovered: number;
    recoveryRate: number;
    recoveredRevenue: number;
  }> {
    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    // prisma-lite has no groupBy: a DO store counts the rows per status itself (a store's abandoned carts are few)
    const grouped = onDo
      ? [
          ...(
            await repo.db.abandonedCart.findMany({ where: { storeId }, select: { status: true } })
          )
            .reduce(
              (m, r) => m.set(r.status, (m.get(r.status) ?? 0) + 1),
              new Map<string, number>()
            )
            .entries(),
        ].map(([status, n]) => ({ status, _count: { id: n } }))
      : await prisma.abandonedCart.groupBy({
          by: ['status'],
          where: { storeId },
          _count: { id: true },
        });

    const byStatus: Record<string, number> = {};
    let totalAbandoned = 0;
    for (const row of grouped) {
      byStatus[row.status] = row._count.id;
      totalAbandoned += row._count.id;
    }
    const totalRecovered = byStatus.recovered ?? 0;

    const revenueRows = onDo
      ? [{ revenue: await doRecoveredRevenue(repo.db, storeId) }]
      : await prisma.$queryRaw<Array<{ revenue: bigint | null }>>`
      SELECT COALESCE(SUM(o.total), 0)::bigint AS revenue
      FROM public.abandoned_carts ac
      JOIN public.orders o ON o.id = ac.recovered_order_id
      WHERE ac.store_id = ${storeId}
        AND ac.status = 'recovered'
        AND o.store_id = ${storeId}
        AND o.deleted_at IS NULL
        AND o.status NOT IN ('cancelled', 'refunded', 'awaiting_payment_confirmation')
        AND o.payment_status <> 'failed'
    `;
    const recoveredRevenue = Number(revenueRows[0]?.revenue ?? 0);

    // Nothing abandoned = a genuine 0% (no denominator to be unknown about).
    const recoveryRate =
      totalAbandoned > 0 ? Math.round((totalRecovered / totalAbandoned) * 10000) / 100 : 0;

    return { byStatus, totalAbandoned, totalRecovered, recoveryRate, recoveredRevenue };
  }

  // ──────────────────────────────────────────
  // List Abandoned Carts (paginated)
  // ──────────────────────────────────────────

  async listAbandoned(
    storeId: string,
    options: { page?: number; limit?: number; status?: string } = {}
  ) {
    const { page = 1, limit = 20, status } = options;
    const skip = (page - 1) * limit;

    const where: Record<string, any> = { storeId };
    if (status) {
      where.status = status;
    }

    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const [found, total] = await Promise.all([
      repo.db.abandonedCart.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        // `customer` is a User on the platform database: for a DO store it is attached below
        ...(onDo
          ? {}
          : {
              include: {
                customer: {
                  select: { id: true, firstName: true, lastName: true, email: true, phone: true },
                },
              },
            }),
      }),
      repo.db.abandonedCart.count({ where }),
    ]);
    const records = onDo ? await withCustomers(storeId, found) : found;

    return {
      records,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** One abandoned cart with its customer (a DO store attaches the platform `User` itself). Null when not this store's. */
  async getAbandoned(storeId: string, id: string) {
    const repo = await storeRepo(storeId);
    const onDo = repo.backend === 'do';
    const found = await repo.db.abandonedCart.findUnique({
      where: { id, storeId },
      ...(onDo
        ? {}
        : {
            include: {
              customer: {
                select: { id: true, firstName: true, lastName: true, email: true, phone: true },
              },
            },
          }),
    });
    return found && onDo ? (await withCustomers(storeId, [found]))[0] : found;
  }

  // ──────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────

  private getNextStep(currentStatus: string): 1 | 2 | 3 | null {
    switch (currentStatus) {
      case 'pending':
        return 1;
      case 'step1_sent':
        return 2;
      case 'step2_sent':
        return 3;
      default:
        return null;
    }
  }

  private isStepEnabled(storeConfig: AbandonedCartConfigDefaults, step: number): boolean {
    switch (step) {
      case 1:
        return storeConfig.step1Enabled;
      case 2:
        return storeConfig.step2Enabled;
      case 3:
        return storeConfig.step3Enabled;
      default:
        return false;
    }
  }

  private findNextEnabledStep(
    storeConfig: AbandonedCartConfigDefaults,
    fromStep: 2 | 3 | 4
  ): 1 | 2 | 3 | null {
    for (let s = fromStep; s <= 3; s++) {
      if (this.isStepEnabled(storeConfig, s)) {
        return s as 1 | 2 | 3;
      }
    }
    return null;
  }

  private getStepDelayMinutes(storeConfig: AbandonedCartConfigDefaults, step: number): number {
    switch (step) {
      case 1:
        return storeConfig.step1DelayMinutes;
      case 2:
        return storeConfig.step2DelayMinutes;
      case 3:
        return storeConfig.step3DelayMinutes;
      default:
        return 0;
    }
  }
}

/** The recovered orders' revenue for a DO store: orders that count as revenue elsewhere (the SQL twin above), summed here. */
async function doRecoveredRevenue(db: StoreReads, storeId: string): Promise<number> {
  const recovered = await db.abandonedCart.findMany({
    where: { storeId, status: 'recovered', recoveredOrderId: { not: null } },
    select: { recoveredOrderId: true },
  });
  const ids = recovered.map(r => r.recoveredOrderId).filter((x): x is string => !!x);
  if (ids.length === 0) return 0;
  const orders = await db.order.findMany({
    where: {
      id: { in: ids },
      storeId,
      deletedAt: null,
      status: { notIn: ['cancelled', 'refunded', 'awaiting_payment_confirmation'] },
      paymentStatus: { not: 'failed' },
    },
    select: { total: true },
  });
  return orders.reduce((n, o) => n + o.total, 0);
}

/** `AbandonedCart.customer` (a platform `User`) for rows read from a DO. */
async function withCustomers<T extends { customerId: string | null }>(storeId: string, rows: T[]) {
  const ids = [...new Set(rows.map(r => r.customerId).filter((x): x is string => !!x))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, storeId },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      })
    : [];
  const byId = new Map(users.map(u => [u.id, u]));
  return rows.map(r => ({
    ...r,
    customer: r.customerId ? (byId.get(r.customerId) ?? null) : null,
  }));
}

// Singleton
export const abandonedCartService = new AbandonedCartService();
