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
  acrossStores,
  acrossStoresFlat,
  currentStoreId,
  runInStoreScope,
  storeDirectory,
  withStore,
} from '@ebda/database';
import { storefrontOrigin } from '@ebda/shared';
import { cartLineUnitPrice } from '../lib/cart-pricing';
import { redis } from './redis.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import { resolveBundle } from './bundle.service';
import { wbsBridgeService, WbsUnauthorizedError, type AbandonedWaCart } from './wbs-bridge.service';
import { encryption } from './encryption.service';
import logger from '../lib/logger';
import crypto from 'crypto';
import { config } from '../config';
import type { NotificationData, NotificationEvent } from '@ebda/shared';

// ==========================================
// Constants / Types
// ==========================================

const LOCK_KEY = 'abandoned-cart:processing';
const LOCK_TTL_SECONDS = 60;
const ABANDONMENT_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// WA cart abandonment: 30-minute inactivity threshold for DM-origin carts.
// Shorter than website carts (1h) because DM sessions go cold faster.
const WA_ABANDONMENT_MINUTES = 30;

// Multi-step WA cart abandoned reminder cadence.
// Mirrors the website abandoned-cart default config (step1=60min, step2=240min, step3=1440min)
// except the WBS inactivity trigger already implies 30 min has passed before step 1 fires.
//   step1: fires when cart is detected as abandoned (≥30min inactivity).
//   step2: fires 4h (240min) after step1 sentinel is written.
//   step3: fires 24h (1440min) after step2 sentinel is written.
const WA_CART_STEP1_DELAY_SECONDS = 0; // immediate on detection
const WA_CART_STEP2_DELAY_SECONDS = 240 * 60; // 4 hours after step1
const WA_CART_STEP3_DELAY_SECONDS = 1440 * 60; // 24 hours after step2

// Redis sentinel TTL for each step.
// Step-N sentinel lives long enough for step N+1 to check it exists, plus headroom.
// Step3 sentinel = 25h so a re-abandoned cart can get a fresh sequence after that window.
const WA_CART_STEP1_SENTINEL_TTL =
  WA_CART_STEP2_DELAY_SECONDS + WA_CART_STEP3_DELAY_SECONDS + 2 * 60 * 60; // ~30h
const WA_CART_STEP2_SENTINEL_TTL = WA_CART_STEP3_DELAY_SECONDS + 2 * 60 * 60; // ~26h
const WA_CART_STEP3_SENTINEL_TTL = 25 * 60 * 60; // 25h

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

      // Run website-cart detection + WA-cart notification in parallel.
      // Both are independent; a WBS failure must not block website reminders.
      await Promise.all([
        this.detectNewAbandonments(correlationId),
        this.detectAndNotifyAbandonedWaCarts(correlationId),
      ]);

      await this.processReminders(correlationId);

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
    // Find all stores with the abandoned_cart feature enabled.
    // store_features is FORCE-RLS; this is a platform-level cron with no tenant
    // context, and the scan is INTENTIONALLY cross-tenant (all eligible stores).
    // Contextless, the policy returns 0 rows → the whole abandoned-cart system
    // silently never runs. So the scan visits each store in its own scope.
    const storeFeatures = await acrossStoresFlat(storeId =>
      prisma.storeFeature.findMany({
        where: { storeId, featureKey: 'abandoned_cart', enabled: true },
        select: { storeId: true },
      })
    );

    if (storeFeatures.length === 0) {
      logger.debug(
        { correlationId },
        '[AbandonedCart] No stores have abandoned_cart feature enabled'
      );
      return;
    }

    const storeIds = storeFeatures.map(sf => sf.storeId);
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
            OR: [{ items: { some: {} } }, { bundles: { some: {} } }],
            abandonedCart: null,
            customer: {
              OR: [{ email: { not: '' } }, { phone: { not: null } }],
            },
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
            // Build a snapshot of cart items at abandonment time
            const itemSnapshot: CartItemSnapshot[] = cart.items.map(item => ({
              productName: item.product.name,
              productImage: item.product.images[0]?.url ?? null,
              price: cartLineUnitPrice(item),
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
              cart.items.reduce((sum, item) => sum + cartLineUnitPrice(item) * item.quantity, 0) +
              bundleSnapshot.reduce((sum, b) => sum + b.price * b.quantity, 0);

            const cartItemCount = cart.items.length + bundleSnapshot.length;

            const nextStepAt = nextStepAtFromConfig();

            const customerEmail = cart.customer?.email ?? null;
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
  // WA Cart Detection + WhatsApp Notification
  // ──────────────────────────────────────────

  /**
   * Fetch abandoned WhatsApp DM carts from WBS and fire the cartAbandoned
   * WhatsApp template for each one.
   *
   * Architecture decision: we do NOT create AbandonedCart records for WA-origin
   * carts (the model requires a foreign-key to a Ebda Cart row which doesn't
   * exist for DM carts). Instead we send a single step-1 WhatsApp reminder
   * directly via the WBS bridge and use a Redis sentinel key for dedup across
   * sweep cycles.
   *
   * Per-store conditions to run:
   *   1. Store.wbsEnabled = true
   *   2. Store.wbsApiKey is set
   *   3. wbsTemplates.cartAbandoned template is configured
   *   4. abandoned_cart feature enabled for the store
   *
   * Source → channel mapping:
   *   WA-origin cart → WhatsApp template only (email not applicable)
   */
  async detectAndNotifyAbandonedWaCarts(correlationId?: string): Promise<void> {
    // Find all stores with both abandoned_cart + whatsapp features enabled.
    // Cross-tenant platform cron over FORCE-RLS store_features → per-store scan
    // (same reason as detectNewAbandonments above).
    const perStore = await acrossStores(storeId =>
      Promise.all([
        prisma.storeFeature.findMany({
          where: { storeId, featureKey: 'abandoned_cart', enabled: true },
          select: { storeId: true },
        }),
        prisma.storeFeature.findMany({
          where: { storeId, featureKey: 'whatsapp', enabled: true },
          select: { storeId: true },
        }),
      ])
    );
    const storeFeatures = perStore.flatMap(r => r.value[0]);
    const waFeatures = perStore.flatMap(r => r.value[1]);

    const abandonedCartStoreIds = new Set(storeFeatures.map(sf => sf.storeId));
    const waStoreIds = new Set(waFeatures.map(sf => sf.storeId));

    // Only stores that have BOTH features enabled
    const eligibleStoreIds = [...abandonedCartStoreIds].filter(id => waStoreIds.has(id));

    if (eligibleStoreIds.length === 0) {
      logger.debug(
        { correlationId },
        '[AbandonedCart:WA] No stores with both abandoned_cart + whatsapp features'
      );
      return;
    }

    // Load store WBS config for eligible stores. The directory picks the
    // wbsEnabled + eligible stores; each store's config + credential is then
    // read inside its own store scope.
    const eligible = new Set(eligibleStoreIds);
    const directory = await storeDirectory(s => s.wbsEnabled && eligible.has(s.id));
    const loaded = await Promise.all(
      directory.map(d =>
        withStore(d.id, tx =>
          tx.store.findUnique({
            where: { id: d.id },
            select: {
              id: true,
              name: true,
              wbsTemplates: true,
              credentials: { select: { wbsApiKey: true } },
            },
          })
        )
      )
    );
    const stores = loaded
      .filter((s): s is NonNullable<typeof s> => s !== null && s.credentials?.wbsApiKey != null)
      .map(s => ({
        id: s.id,
        name: s.name,
        wbsApiKey: s.credentials!.wbsApiKey,
        wbsTemplates: s.wbsTemplates,
      }));

    logger.info(
      { correlationId, storeCount: stores.length },
      '[AbandonedCart:WA] Scanning WBS clients for abandoned DM carts'
    );

    for (const store of stores) {
      try {
        await this.processWaAbandonedCartsForStore(store, correlationId);
      } catch (err) {
        logger.error(
          { err, correlationId, storeId: store.id },
          '[AbandonedCart:WA] Failed for store — skipping (non-fatal)'
        );
      }
    }
  }

  private async processWaAbandonedCartsForStore(
    store: { id: string; name: string; wbsApiKey: string | null; wbsTemplates: unknown },
    correlationId?: string
  ): Promise<void> {
    if (!store.wbsApiKey) return;

    // Resolve cartAbandoned template from wbsTemplates JSON.
    // Shape: { cartAbandoned?: { name: string, languageCode: string, channels?: { whatsapp?: boolean, email?: boolean } } }
    type TemplateEntry = {
      name?: string;
      languageCode?: string;
      channels?: { whatsapp?: boolean; email?: boolean };
    };
    type WbsTemplatesShape = { cartAbandoned?: TemplateEntry };
    const templates = store.wbsTemplates as WbsTemplatesShape | null;
    const cartAbandonedTemplate = templates?.cartAbandoned;

    if (!cartAbandonedTemplate?.name) {
      logger.debug(
        { storeId: store.id },
        '[AbandonedCart:WA] No cartAbandoned template configured — skipping store'
      );
      return;
    }

    // Respect explicit channel disable (default ON when absent)
    if (cartAbandonedTemplate.channels?.whatsapp === false) {
      logger.debug(
        { storeId: store.id },
        '[AbandonedCart:WA] WhatsApp channel disabled for cartAbandoned — skipping store'
      );
      return;
    }

    // Decrypt the WBS API key
    let plaintextKey: string;
    try {
      plaintextKey = encryption.decrypt(store.wbsApiKey);
    } catch {
      logger.warn(
        { storeId: store.id },
        '[AbandonedCart:WA] Failed to decrypt WBS API key — skipping'
      );
      return;
    }

    // Fetch abandoned WA carts from WBS (degraded mode: throws on 401, returns [] on 5xx)
    let waCarts: AbandonedWaCart[];
    try {
      waCarts = await wbsBridgeService.fetchAbandonedWaCarts(plaintextKey, {
        minutes: WA_ABANDONMENT_MINUTES,
      });
    } catch (err) {
      if (err instanceof WbsUnauthorizedError) {
        logger.warn({ storeId: store.id }, '[AbandonedCart:WA] WBS 401 — skipping store');
      } else {
        logger.error(
          { err, storeId: store.id },
          '[AbandonedCart:WA] Failed to fetch WA carts — skipping store'
        );
      }
      return;
    }

    // Filter to carts that belong to this store (fwb_store_id match or null as fallback)
    const relevantCarts = waCarts.filter(
      cart => cart.fwbStoreId === store.id || cart.fwbStoreId === null
    );

    logger.info(
      { correlationId, storeId: store.id, total: waCarts.length, relevant: relevantCarts.length },
      '[AbandonedCart:WA] Processing abandoned WA carts for store'
    );

    for (const cart of relevantCarts) {
      try {
        await this.sendWaCartAbandonedReminder(store, cart, cartAbandonedTemplate, correlationId);
      } catch (err) {
        logger.error(
          { err, correlationId, storeId: store.id, waCartId: cart.waCartId },
          '[AbandonedCart:WA] Failed to send reminder for cart — skipping'
        );
      }
    }
  }

  /**
   * Multi-step WA cart abandoned reminder sequence.
   *
   * Cadence (mirrors website AbandonedCartConfig defaults):
   *   step1 — fires immediately when the cart is detected as abandoned (≥30min inactivity)
   *   step2 — fires 4h after step1 sentinel was written
   *   step3 — fires 24h after step2 sentinel was written
   *
   * Each step is deduped via a Redis sentinel key keyed by waCartId + step number.
   * Sentinel value = Unix timestamp (ms) of when it was written — used by the
   * next step to check if enough time has elapsed.
   *
   * Step N fires only when:
   *   (a) step N sentinel does NOT yet exist (not already sent)
   *   (b) for N>1: step N-1 sentinel EXISTS and its stored timestamp is ≥ step-N delay ago
   *
   * All 3 steps use the same Meta-approved template (force_cart_abandoned_v1).
   * Variables are identical across steps; messaging variation is a future enhancement.
   *
   * Sentinel expiry ensures re-abandoned carts (recovered then abandoned again) get
   * a fresh reminder sequence after the TTL window.
   */
  private async sendWaCartAbandonedReminder(
    store: { id: string; name: string; wbsApiKey: string | null },
    cart: AbandonedWaCart,
    template: { name?: string; languageCode?: string },
    correlationId?: string
  ): Promise<void> {
    if (!store.wbsApiKey) return;

    // Pre-validate the encrypted key decrypts before attempting any send.
    try {
      encryption.decrypt(store.wbsApiKey);
    } catch {
      logger.warn({ storeId: store.id }, '[AbandonedCart:WA] decrypt failed — skipping cart');
      return;
    }

    const step1Key = `wa-cart-abandoned:${cart.waCartId}:step1`;
    const step2Key = `wa-cart-abandoned:${cart.waCartId}:step2`;
    const step3Key = `wa-cart-abandoned:${cart.waCartId}:step3`;

    // Read all sentinel values (stored as ms timestamps, or null if not yet fired)
    const [step1Val, step2Val, step3Val] = await Promise.all([
      redis.get<string>(step1Key),
      redis.get<string>(step2Key),
      redis.get<string>(step3Key),
    ]);

    const now = Date.now();

    // Determine which step to fire.
    // At most one step fires per cart per sweep; the next sweep advances further.
    let stepToFire: 1 | 2 | 3 | null = null;

    if (!step1Val) {
      // Step 1: fire immediately — cart is newly detected as abandoned
      stepToFire = 1;
    } else if (!step2Val) {
      // Step 2: fires ≥4h after step1
      const step1SentAt = parseInt(step1Val, 10);
      if (now - step1SentAt >= WA_CART_STEP2_DELAY_SECONDS * 1000) {
        stepToFire = 2;
      }
    } else if (!step3Val) {
      // Step 3: fires ≥24h after step2
      const step2SentAt = parseInt(step2Val, 10);
      if (now - step2SentAt >= WA_CART_STEP3_DELAY_SECONDS * 1000) {
        stepToFire = 3;
      }
    }

    if (stepToFire === null) {
      logger.debug(
        {
          waCartId: cart.waCartId,
          step1: Boolean(step1Val),
          step2: Boolean(step2Val),
          step3: Boolean(step3Val),
        },
        '[AbandonedCart:WA] All applicable steps already sent or not yet due — skipping'
      );
      return;
    }

    const templateName = template.name!;
    const languageCode = template.languageCode || (cart.language === 'ar' ? 'ar' : 'en');
    const idempotencyKey = `wa-cart-${cart.waCartId}-step${stepToFire}`;

    // Build variables for force_cart_abandoned_v1:
    //   {{1}} customer name, {{2}} cart total, {{3}} store name
    const cartTotalMajor = (cart.totalFils / 1000).toFixed(3);
    const totalDisplay = `${cartTotalMajor} ${cart.currency}`;
    const customerName = cart.customerName || 'Customer';

    const variables = [customerName, totalDisplay, store.name];

    try {
      const result = await wbsBridgeService.sendOrderNotification({
        encryptedApiKey: store.wbsApiKey, // sendOrderNotification decrypts internally
        recipientPhone: cart.customerPhone,
        templateName,
        languageCode,
        variables,
        idempotencyKey,
      });

      // Write sentinel: value = ms timestamp so the next step can measure elapsed time
      const sentinelKey = stepToFire === 1 ? step1Key : stepToFire === 2 ? step2Key : step3Key;
      const sentinelTtl =
        stepToFire === 1
          ? WA_CART_STEP1_SENTINEL_TTL
          : stepToFire === 2
            ? WA_CART_STEP2_SENTINEL_TTL
            : WA_CART_STEP3_SENTINEL_TTL;
      await redis.set(sentinelKey, String(now), sentinelTtl);

      logger.info(
        {
          correlationId,
          storeId: store.id,
          waCartId: cart.waCartId,
          step: stepToFire,
          messageId: result.messageId,
        },
        '[AbandonedCart:WA] WhatsApp reminder sent'
      );
    } catch (err) {
      if (err instanceof WbsUnauthorizedError) {
        logger.error({ storeId: store.id }, '[AbandonedCart:WA] WBS 401 on send — skipping');
      } else {
        // Re-throw so the caller can log + skip to the next cart
        throw err;
      }
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
    await prisma.abandonedCart.update({
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
    const row = await prisma.abandonedCartConfig.findUnique({
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
    };
  }

  async upsertConfig(
    storeId: string,
    data: Partial<AbandonedCartConfigDefaults>
  ): Promise<AbandonedCartConfigDefaults> {
    const row = await prisma.abandonedCartConfig.upsert({
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
    const grouped = await prisma.abandonedCart.groupBy({
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

    const revenueRows = await prisma.$queryRaw<Array<{ revenue: bigint | null }>>`
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

    const [records, total] = await Promise.all([
      prisma.abandonedCart.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
        },
      }),
      prisma.abandonedCart.count({ where }),
    ]);

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

// Singleton
export const abandonedCartService = new AbandonedCartService();
