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

import { prisma } from '@force/database';
import { redis } from './redis.service';
import { featureService } from './feature.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import logger from '../lib/logger';
import crypto from 'crypto';
import { config } from '../config';
import type { NotificationData, NotificationEvent } from '@force/shared';

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
    // Find all stores with the abandoned_cart feature enabled
    const storeFeatures = await prisma.storeFeature.findMany({
      where: { featureKey: 'abandoned_cart', enabled: true },
      select: { storeId: true },
    });

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
      // Find carts that:
      // 1. Haven't been active for >1 hour
      // 2. Have at least one item
      // 3. Don't already have an AbandonedCart record
      // 4. Have a customer with email or phone (so we can actually reach them)
      const carts = await prisma.cart.findMany({
        where: {
          storeId,
          lastActivityAt: { lt: abandonmentCutoff },
          items: { some: {} },
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
            },
          },
        },
      });

      for (const cart of carts) {
        try {
          // Build a snapshot of cart items at abandonment time
          const itemSnapshot: CartItemSnapshot[] = cart.items.map(item => ({
            productName: item.product.name,
            productImage: item.product.images[0]?.url ?? null,
            price: item.product.price,
            quantity: item.quantity,
          }));

          // Calculate total from snapshot (price is in fils / integer cents)
          const cartTotal = cart.items.reduce(
            (sum, item) => sum + item.product.price * item.quantity,
            0
          );

          // Get step1 delay to compute nextStepAt
          const storeConfig = await this.getConfig(storeId);
          const nextStepAt = storeConfig.step1Enabled
            ? new Date(Date.now() + storeConfig.step1DelayMinutes * 60 * 1000)
            : null;

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
              cartItemCount: cart.items.length,
              cartItems: itemSnapshot as any,
              status: 'pending',
              nextStepAt,
            },
          });

          logger.info(
            { correlationId, storeId, cartId: cart.id, itemCount: cart.items.length },
            '[AbandonedCart] New abandoned cart detected'
          );
        } catch (err) {
          logger.error(
            { err, correlationId, storeId, cartId: cart.id },
            '[AbandonedCart] Failed to create abandoned cart record — skipping'
          );
        }
      }
    }
  }

  // ──────────────────────────────────────────
  // Step 2: Process Reminders
  // ──────────────────────────────────────────

  async processReminders(correlationId?: string): Promise<void> {
    const now = new Date();

    const pending = await prisma.abandonedCart.findMany({
      where: {
        status: { in: ['pending', 'step1_sent', 'step2_sent'] },
        nextStepAt: { lte: now },
      },
      include: {
        store: { select: { id: true, name: true, domain: true, slug: true } },
        customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });

    logger.info(
      { correlationId, count: pending.length },
      '[AbandonedCart] Processing due reminders'
    );

    for (const abandonedCart of pending) {
      try {
        // Check if cart was already recovered (order placed using recovery URL)
        if (
          abandonedCart.status === 'pending' ||
          abandonedCart.status === 'step1_sent' ||
          abandonedCart.status === 'step2_sent'
        ) {
          const nextStep = this.getNextStep(abandonedCart.status);
          if (nextStep !== null) {
            await this.sendStep(abandonedCart, nextStep);
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
          where: { id: abandonedCart.id },
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

    // Build recovery URL with HMAC signature
    const sig = crypto
      .createHmac('sha256', config.encryptionKey)
      .update(abandonedCart.id)
      .digest('hex');

    const storeDomain = abandonedCart.store?.domain
      ? `https://${abandonedCart.store.domain}`
      : `${config.webUrl}/${abandonedCart.store?.slug ?? ''}`;

    const recoveryUrl = `${storeDomain}/cart?recover=${abandonedCart.id}&sig=${sig}`;

    // Step 3: generate a coupon if auto-coupon is enabled
    let couponCode: string | null = null;
    if (stepNumber === 3 && storeConfig.autoCouponEnabled) {
      couponCode = await this.generateRecoveryCoupon(storeId, abandonedCart.id, storeConfig);
    }

    // Build notification data
    const customerName = abandonedCart.customer
      ? `${abandonedCart.customer.firstName} ${abandonedCart.customer.lastName}`.trim()
      : 'Customer';
    const cartTotalDecimal = Number(abandonedCart.cartTotal);
    const cartTotalFormatted = (cartTotalDecimal / 1000).toFixed(3); // fils → KWD

    const notificationData: NotificationData = {
      customerName,
      customerPhone: abandonedCart.customerPhone ?? undefined,
      orderNumber: abandonedCart.id, // no order number at abandonment stage; use record ID
      storeId,
      storeName: abandonedCart.store?.name ?? '',
      cartUrl: recoveryUrl,
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
      where: { id: abandonedCart.id },
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

      // Coupon.value is Int (percentage 0–100 or fixed amount in fils)
      // couponMaxDiscount in schema is Decimal(12,3) → stored as Int in Coupon.maxDiscount
      const maxDiscountInt =
        storeConfig.couponMaxDiscount !== null
          ? Math.round(storeConfig.couponMaxDiscount * 1000) // convert KWD to fils
          : undefined;

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
        where: { id: abandonedCartId },
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
      where: { id: abandonedCartId },
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
      couponMaxDiscount: row.couponMaxDiscount !== null ? Number(row.couponMaxDiscount) : null,
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
      couponMaxDiscount: row.couponMaxDiscount !== null ? Number(row.couponMaxDiscount) : null,
      couponExpiryHours: row.couponExpiryHours,
    };
  }

  // ──────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────

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
    let totalRecovered = 0;

    for (const row of grouped) {
      byStatus[row.status] = row._count.id;
      totalAbandoned += row._count.id;
      if (row.status === 'recovered') {
        totalRecovered = row._count.id;
      }
    }

    // Sum up recovered order totals
    const recoveredRecords = await prisma.abandonedCart.findMany({
      where: { storeId, status: 'recovered', recoveredOrderId: { not: null } },
      select: { recoveredOrderId: true },
    });

    let recoveredRevenue = 0;
    if (recoveredRecords.length > 0) {
      const orderIds = recoveredRecords.map(r => r.recoveredOrderId).filter(Boolean) as string[];

      const orders = await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { total: true },
      });

      recoveredRevenue = orders.reduce((sum, o) => sum + o.total, 0);
    }

    const recoveryRate =
      totalAbandoned > 0 ? Math.round((totalRecovered / totalAbandoned) * 100 * 100) / 100 : 0;

    return {
      byStatus,
      totalAbandoned,
      totalRecovered,
      recoveryRate,
      recoveredRevenue,
    };
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
