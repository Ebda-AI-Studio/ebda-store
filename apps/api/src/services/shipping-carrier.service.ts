// ==========================================
// Shipping Carrier Service
// Orchestrates carrier integrations: shipment creation, tracking, webhooks
// ==========================================

import { prisma } from '@force/database';
import { redis } from './redis.service';
import { encryption } from './encryption.service';
import { featureService } from './feature.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import logger from '../lib/logger';
import { config } from '../config';

import { iCarryCarrier } from './carriers/icarry.carrier';
import { aramexCarrier } from './carriers/aramex.carrier';
import {
  ShippingCarrierProvider,
  CarrierCode,
  CARRIER_CODES,
  ShipmentAddress,
} from './carriers/types';

const CARRIER_REGISTRY: Record<CarrierCode, ShippingCarrierProvider> = {
  icarry: iCarryCarrier,
  aramex: aramexCarrier,
};

// Cache TTL for carrier configs (5 minutes)
const CARRIER_CONFIG_CACHE_TTL = 300;
const CARRIER_CONFIG_CACHE_PREFIX = 'shipping:carrier-configs:';

// Redis lock for tracking cron
const TRACKING_CRON_LOCK = 'shipping:tracking-cron';

interface CarrierConfigData {
  enabled: boolean;
  isDefault?: boolean;
  credentials: Record<string, string>;
  settings?: Record<string, unknown>;
}

interface ListShipmentsOptions {
  page?: number;
  limit?: number;
  status?: string;
  carrier?: string;
}

class ShippingCarrierService {
  private trackingCronTimer: ReturnType<typeof setInterval> | null = null;

  // ==========================================
  // Carrier Config Management
  // ==========================================

  /**
   * Get all carrier configs for a store (Redis-cached, credentials decrypted)
   */
  async getCarrierConfigs(storeId: string) {
    const cacheKey = `${CARRIER_CONFIG_CACHE_PREFIX}${storeId}`;

    // Try cache first
    const cached = await redis.get<any[]>(cacheKey, true);
    if (cached !== null) {
      return cached;
    }

    // Fetch from DB
    const configs = await prisma.shippingCarrierConfig.findMany({
      where: { storeId },
      orderBy: { createdAt: 'asc' },
    });

    // Decrypt credentials before returning
    const decrypted = configs.map(cfg => ({
      ...cfg,
      credentials: cfg.credentials ? this.decryptCredentials(cfg.credentials) : {},
    }));

    // Cache (best-effort)
    try {
      await redis.set(cacheKey, decrypted, CARRIER_CONFIG_CACHE_TTL);
    } catch (err) {
      logger.warn(
        { err, storeId },
        '[ShippingCarrierService] Cache write failed for carrier configs'
      );
    }

    return decrypted;
  }

  /**
   * Get a single carrier config for a store
   */
  async getCarrierConfig(storeId: string, carrier: CarrierCode) {
    const configs = await this.getCarrierConfigs(storeId);
    return configs.find((c: any) => c.carrier === carrier) ?? null;
  }

  /**
   * Upsert a carrier config (encrypts credentials, invalidates cache)
   */
  async upsertCarrierConfig(storeId: string, carrier: CarrierCode, data: CarrierConfigData) {
    const encryptedCredentials = encryption.encrypt(JSON.stringify(data.credentials));

    const result = await prisma.shippingCarrierConfig.upsert({
      where: { storeId_carrier: { storeId, carrier } },
      create: {
        storeId,
        carrier,
        credentials: encryptedCredentials,
        enabled: data.enabled ?? false,
        isDefault: data.isDefault ?? false,
        settings: (data.settings ?? {}) as any,
      },
      update: {
        credentials: encryptedCredentials,
        enabled: data.enabled ?? false,
        settings: (data.settings ?? {}) as any,
        updatedAt: new Date(),
      },
    });

    await this.invalidateCarrierConfigCache(storeId);
    return result;
  }

  /**
   * Delete a carrier config
   */
  async deleteCarrierConfig(storeId: string, carrier: CarrierCode) {
    await prisma.shippingCarrierConfig.deleteMany({
      where: { storeId, carrier },
    });
    await this.invalidateCarrierConfigCache(storeId);
  }

  /**
   * Set the default carrier for a store (unsets others first)
   */
  async setDefaultCarrier(storeId: string, carrier: CarrierCode) {
    await prisma.$transaction([
      prisma.shippingCarrierConfig.updateMany({
        where: { storeId, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.shippingCarrierConfig.updateMany({
        where: { storeId, carrier },
        data: { isDefault: true, enabled: true },
      }),
    ]);

    await this.invalidateCarrierConfigCache(storeId);
  }

  /**
   * Test carrier credentials by making a lightweight API call
   */
  async testConnection(storeId: string, carrier: CarrierCode) {
    const config = await this.getCarrierConfig(storeId, carrier);
    if (!config) {
      return { success: false, error: 'Carrier not configured for this store' };
    }

    const carrierImpl = CARRIER_REGISTRY[carrier];
    return carrierImpl.testConnection(config.credentials);
  }

  // ==========================================
  // Shipment Lifecycle
  // ==========================================

  /**
   * Create a shipment for an order via the default (or specified) carrier
   */
  async createShipmentForOrder(storeId: string, orderId: string, carrierCode?: CarrierCode) {
    logger.info(
      { storeId, orderId, carrierCode },
      '[ShippingCarrierService] createShipmentForOrder'
    );

    // Idempotency guard: if a shipment already exists for this order, return
    // it instead of calling the carrier again. Without this, every retry
    // (admin re-clicks "ship", auto-ship retry on order confirmation, etc.)
    // would print a duplicate label and bill the carrier a second time.
    // Note: this only protects when a Shipment row was committed. If the DB
    // write previously failed AFTER the carrier created a shipment, the
    // next call will hit the carrier again — that's an accepted edge-case
    // requiring manual reconciliation (logged below).
    const existingShipment = await prisma.shipment.findFirst({
      where: { orderId, storeId },
    });
    if (existingShipment) {
      logger.info(
        { shipmentId: existingShipment.id, orderId, storeId },
        '[ShippingCarrierService] Shipment already exists for order — returning existing'
      );
      return existingShipment;
    }

    // Get order + shipping address
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        items: {
          include: { product: { select: { name: true, sku: true } } },
        },
        customer: { select: { email: true, firstName: true, lastName: true } },
      },
    });

    if (!order) {
      throw new Error(`Order ${orderId} not found in store ${storeId}`);
    }

    // Determine which carrier to use
    const resolvedCarrierCode = carrierCode ?? (await this.getDefaultCarrierCode(storeId));
    if (!resolvedCarrierCode) {
      throw new Error('No default carrier configured for this store');
    }

    const carrierConfig = await this.getCarrierConfig(storeId, resolvedCarrierCode);
    if (!carrierConfig || !carrierConfig.enabled) {
      throw new Error(`Carrier ${resolvedCarrierCode} is not enabled for this store`);
    }

    // Get store pickup address from carrier settings
    const settings = (carrierConfig.settings as Record<string, any>) ?? {};
    const pickupAddress = this.buildPickupAddress(storeId, settings);

    // Build delivery address from order shipping address
    const shippingAddr = order.shippingAddress as Record<string, any>;
    const deliveryAddress: ShipmentAddress = {
      name: `${shippingAddr.firstName ?? ''} ${shippingAddr.lastName ?? ''}`.trim() || 'Customer',
      phone: shippingAddr.phone ?? '',
      email: order.customer?.email,
      line1: shippingAddr.address1 ?? shippingAddr.line1 ?? '',
      line2: shippingAddr.address2 ?? shippingAddr.line2,
      city: shippingAddr.city ?? '',
      state: shippingAddr.state,
      country: shippingAddr.country ?? 'KW',
      postalCode: shippingAddr.postalCode,
      area: shippingAddr.area,
      block: shippingAddr.block,
      street: shippingAddr.street,
      building: shippingAddr.building,
      floor: shippingAddr.floor,
      apartment: shippingAddr.apartment,
    };

    const items = order.items.map(item => ({
      name: item.productName,
      quantity: item.quantity,
      sku: item.sku ?? undefined,
      value: item.price,
    }));

    // Call carrier API
    const carrierImpl = CARRIER_REGISTRY[resolvedCarrierCode];
    const response = await carrierImpl.createShipment(carrierConfig.credentials, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      pickupAddress,
      deliveryAddress,
      items,
      weight: settings.defaultWeight ?? 0.5,
    });

    // Persist Shipment + flip Order to 'shipped' atomically. Previously these
    // were two sequential writes, so a partial failure (e.g. db hiccup
    // between them) could strand a real carrier shipment — admin sees an
    // order still "processing" while the carrier already has the package
    // out for delivery. The carrier API call stays OUTSIDE the transaction
    // because it's external and non-rollbackable.
    let shipment;
    try {
      shipment = await prisma.$transaction(async tx => {
        const created = await tx.shipment.create({
          data: {
            storeId,
            orderId,
            carrier: resolvedCarrierCode,
            trackingNumber: response.trackingNumber,
            trackingUrl: response.trackingUrl,
            labelUrl: response.labelUrl,
            status: 'created',
            carrierShipmentId: response.carrierShipmentId,
            pickupAddress: pickupAddress as any,
            deliveryAddress: deliveryAddress as any,
            weight: settings.defaultWeight ? String(settings.defaultWeight) : null,
            estimatedDeliveryAt: response.estimatedDelivery,
            statusHistory: [
              {
                status: 'created',
                timestamp: new Date().toISOString(),
                description: `Shipment created via ${resolvedCarrierCode}`,
              },
            ],
          },
        });

        await tx.order.update({
          where: { id: orderId },
          data: { status: 'shipped' },
        });

        return created;
      });
    } catch (txError) {
      // Carrier shipment exists but our DB rolled back — log loudly with the
      // carrier-side identifiers so finance / ops can manually reconcile.
      // Do NOT attempt to cancel the carrier shipment automatically: that's
      // a real-money external action and the audit explicitly requires
      // manual reconcile here. The idempotency guard at top of this method
      // means a future retry won't double-up *if* the DB row eventually
      // commits; if not, the carrier shipment is the source of truth.
      logger.error(
        {
          err: txError,
          orderId,
          storeId,
          carrier: resolvedCarrierCode,
          carrierShipmentId: response.carrierShipmentId,
          trackingNumber: response.trackingNumber,
          labelUrl: response.labelUrl,
        },
        '[ShippingCarrierService] DB transaction failed AFTER carrier created shipment — manual reconciliation required'
      );
      throw txError;
    }

    // Dispatch shipment notification fully fire-and-forget — including the
    // store-name lookup, so neither Prisma nor the notification provider can
    // block the createShipmentForOrder response (called from the admin
    // /orders/:id/ship route as well as auto-ship on order confirmation).
    void prisma.store
      .findUnique({
        where: { id: storeId },
        select: { name: true },
      })
      .catch(() => null)
      .then(store =>
        notificationDispatcher
          .dispatch(storeId, 'order_shipped', {
            customerName:
              `${order.customer?.firstName ?? ''} ${order.customer?.lastName ?? ''}`.trim() ||
              'Customer',
            customerPhone: shippingAddr.phone ?? undefined,
            orderNumber: order.orderNumber,
            total: order.total,
            storeId,
            storeName: store?.name ?? storeId,
          })
          .catch(err =>
            logger.error({ err }, '[ShippingCarrierService] Notification dispatch failed')
          )
      );

    logger.info(
      { shipmentId: shipment.id, trackingNumber: response.trackingNumber },
      '[ShippingCarrierService] Shipment created'
    );
    return shipment;
  }

  /**
   * Cancel a shipment by shipment ID
   */
  async cancelShipment(shipmentId: string) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { order: { select: { storeId: true, id: true } } },
    });

    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    const carrierCode = shipment.carrier as CarrierCode;
    if (!CARRIER_REGISTRY[carrierCode]) {
      throw new Error(`Unknown carrier: ${carrierCode}`);
    }

    const carrierConfig = await this.getCarrierConfig(shipment.storeId, carrierCode);
    if (!carrierConfig) {
      throw new Error(`No config found for carrier ${carrierCode}`);
    }

    let cancelled = false;
    if (shipment.carrierShipmentId) {
      cancelled = await CARRIER_REGISTRY[carrierCode].cancelShipment(
        carrierConfig.credentials,
        shipment.carrierShipmentId
      );
    }

    const history = Array.isArray(shipment.statusHistory) ? (shipment.statusHistory as any[]) : [];
    const updatedShipment = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: 'cancelled',
        statusHistory: [
          ...history,
          {
            status: 'cancelled',
            timestamp: new Date().toISOString(),
            description: cancelled
              ? 'Cancelled with carrier'
              : 'Marked cancelled (carrier cancel failed)',
          },
        ],
      },
    });

    // Update order status back to processing
    await prisma.order.update({
      where: { id: shipment.orderId },
      data: { status: 'processing' },
    });

    return updatedShipment;
  }

  /**
   * Poll carrier for latest tracking status and update Shipment record
   */
  async updateShipmentStatus(shipmentId: string) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        order: {
          include: {
            customer: { select: { email: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!shipment) {
      throw new Error(`Shipment ${shipmentId} not found`);
    }

    if (!shipment.trackingNumber) {
      logger.warn(
        { shipmentId },
        '[ShippingCarrierService] No tracking number, skipping status update'
      );
      return shipment;
    }

    const carrierCode = shipment.carrier as CarrierCode;
    const carrierConfig = await this.getCarrierConfig(shipment.storeId, carrierCode);
    if (!carrierConfig) {
      logger.warn({ shipmentId, carrierCode }, '[ShippingCarrierService] No carrier config found');
      return shipment;
    }

    let tracking;
    try {
      tracking = await CARRIER_REGISTRY[carrierCode].trackShipment(
        carrierConfig.credentials,
        shipment.trackingNumber
      );
    } catch (err) {
      logger.error({ err, shipmentId }, '[ShippingCarrierService] trackShipment failed');
      return shipment;
    }

    const historyEntries = tracking.statusHistory.map(h => ({
      status: h.status,
      timestamp: h.timestamp.toISOString(),
      location: h.location,
      description: h.description,
    }));

    const updatedShipment = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: tracking.status,
        statusHistory: historyEntries,
        estimatedDeliveryAt: tracking.estimatedDelivery,
      },
    });

    // If delivered, update Order and dispatch notification
    if (tracking.status === 'delivered' && shipment.status !== 'delivered') {
      await prisma.order.update({
        where: { id: shipment.orderId },
        data: { status: 'delivered' },
      });

      const store = await prisma.store
        .findUnique({
          where: { id: shipment.storeId },
          select: { name: true },
        })
        .catch(() => null);

      const order = shipment.order;
      const shippingAddr = order.shippingAddress as { phone?: string } | null;

      notificationDispatcher
        .dispatch(shipment.storeId, 'order_delivered', {
          customerName:
            `${order.customer?.firstName ?? ''} ${order.customer?.lastName ?? ''}`.trim() ||
            order.customer?.email ||
            'Customer',
          customerPhone: shippingAddr?.phone ?? undefined,
          orderNumber: order.orderNumber,
          total: order.total,
          storeId: shipment.storeId,
          storeName: store?.name ?? shipment.storeId,
        })
        .catch(err =>
          logger.error({ err }, '[ShippingCarrierService] Delivery notification failed')
        );
    }

    return updatedShipment;
  }

  /**
   * Process an inbound carrier webhook, find the shipment, and update it
   */
  async processWebhook(carrier: string, body: unknown, headers: Record<string, string>) {
    const carrierCode = carrier as CarrierCode;
    const carrierImpl = CARRIER_REGISTRY[carrierCode];

    if (!carrierImpl) {
      logger.warn({ carrier }, '[ShippingCarrierService] Unknown carrier webhook received');
      return null;
    }

    const result = carrierImpl.processWebhook(body, headers);
    if (!result) {
      logger.warn(
        { carrier },
        '[ShippingCarrierService] Carrier returned null from processWebhook'
      );
      return null;
    }

    // Find the shipment by tracking number
    const shipment = await prisma.shipment.findFirst({
      where: { trackingNumber: result.trackingNumber },
      include: {
        order: {
          include: {
            customer: { select: { email: true, firstName: true, lastName: true } },
          },
        },
      },
    });

    if (!shipment) {
      logger.warn(
        { trackingNumber: result.trackingNumber, carrier },
        '[ShippingCarrierService] No shipment found for webhook tracking number'
      );
      return null;
    }

    const history = Array.isArray(shipment.statusHistory) ? (shipment.statusHistory as any[]) : [];
    const newEntry = {
      status: result.status,
      timestamp: result.timestamp.toISOString(),
      location: result.location,
      description: result.description,
    };

    const updatedShipment = await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: result.status,
        statusHistory: [...history, newEntry],
      },
    });

    // If delivered → update Order + notify
    if (result.status === 'delivered' && shipment.status !== 'delivered') {
      await prisma.order.update({
        where: { id: shipment.orderId },
        data: { status: 'delivered' },
      });

      const store = await prisma.store
        .findUnique({
          where: { id: shipment.storeId },
          select: { name: true },
        })
        .catch(() => null);

      const order = shipment.order;
      const shippingAddr = order.shippingAddress as { phone?: string } | null;

      notificationDispatcher
        .dispatch(shipment.storeId, 'order_delivered', {
          customerName:
            `${order.customer?.firstName ?? ''} ${order.customer?.lastName ?? ''}`.trim() ||
            order.customer?.email ||
            'Customer',
          customerPhone: shippingAddr?.phone ?? undefined,
          orderNumber: order.orderNumber,
          total: order.total,
          storeId: shipment.storeId,
          storeName: store?.name ?? shipment.storeId,
        })
        .catch(err =>
          logger.error({ err }, '[ShippingCarrierService] Webhook delivery notification failed')
        );
    }

    logger.info(
      { shipmentId: shipment.id, status: result.status },
      '[ShippingCarrierService] Webhook processed'
    );
    return updatedShipment;
  }

  // ==========================================
  // Shipment Listing
  // ==========================================

  async listShipments(storeId: string, options: ListShipmentsOptions = {}) {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = { storeId };
    if (options.status) where.status = options.status;
    if (options.carrier) where.carrier = options.carrier;

    const [shipments, total] = await Promise.all([
      prisma.shipment.findMany({
        where,
        skip,
        take: limit,
        include: {
          order: {
            select: {
              orderNumber: true,
              status: true,
              total: true,
              customer: { select: { email: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.shipment.count({ where }),
    ]);

    return {
      shipments,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ==========================================
  // Tracking Cron
  // ==========================================

  /**
   * Start a recurring interval that polls carrier APIs for non-delivered shipments.
   * Uses a Redis lock to prevent duplicate runs in multi-instance deployments.
   */
  startTrackingCron(intervalMs = 1_800_000) {
    if (this.trackingCronTimer) {
      logger.warn('[ShippingCarrierService] Tracking cron already running');
      return;
    }

    logger.info({ intervalMs }, '[ShippingCarrierService] Starting tracking cron');

    this.trackingCronTimer = setInterval(async () => {
      // Acquire distributed lock (30 minute TTL to cover worst-case run)
      const lockTtl = Math.ceil(intervalMs / 1000);
      const acquired = await redis.acquireLock(TRACKING_CRON_LOCK, lockTtl).catch(() => false);
      if (!acquired) {
        logger.debug(
          '[ShippingCarrierService] Tracking cron skipped (lock held by another instance)'
        );
        return;
      }

      try {
        await this.runTrackingCron();
      } catch (err) {
        logger.error({ err }, '[ShippingCarrierService] Tracking cron error');
      } finally {
        await redis.releaseLock(TRACKING_CRON_LOCK).catch(() => {});
      }
    }, intervalMs);
  }

  stopTrackingCron() {
    if (this.trackingCronTimer) {
      clearInterval(this.trackingCronTimer);
      this.trackingCronTimer = null;
      logger.info('[ShippingCarrierService] Tracking cron stopped');
    }
  }

  private async runTrackingCron() {
    // Find all shipments that are not in a terminal state
    const activeShipments = await prisma.shipment.findMany({
      where: {
        status: { notIn: ['delivered', 'cancelled', 'returned'] },
        trackingNumber: { not: null },
      },
      select: { id: true },
      take: 200, // Safety limit per run
    });

    logger.info(
      { count: activeShipments.length },
      '[ShippingCarrierService] Tracking cron: polling shipments'
    );

    // Process with bounded concurrency. Sequential was N × (DB lookup
    // + provider HTTP + DB update) = ~600 round-trips for a 200-shipment
    // run; the provider call dominates so a worker pool of 8 cuts the
    // wall-clock by roughly 8×. Capped intentionally — going higher
    // risks tripping carrier rate limits (iCarry / Aramex publish
    // 10 req/s ceilings) and exhausting the Neon connection pool.
    const concurrency = 8;
    const queue = [...activeShipments];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        try {
          await this.updateShipmentStatus(next.id);
        } catch (err) {
          logger.error(
            { err, shipmentId: next.id },
            '[ShippingCarrierService] Failed to update shipment status'
          );
        }
      }
    });
    await Promise.all(workers);
  }

  // ==========================================
  // Helpers
  // ==========================================

  private async getDefaultCarrierCode(storeId: string): Promise<CarrierCode | null> {
    const configs = await this.getCarrierConfigs(storeId);
    const defaultConfig = configs.find((c: any) => c.isDefault && c.enabled);
    if (defaultConfig) return defaultConfig.carrier as CarrierCode;

    // Fallback: first enabled carrier
    const firstEnabled = configs.find((c: any) => c.enabled);
    return firstEnabled ? (firstEnabled.carrier as CarrierCode) : null;
  }

  private buildPickupAddress(storeId: string, settings: Record<string, any>): ShipmentAddress {
    return {
      name: settings.pickupName ?? 'Store',
      phone: settings.pickupPhone ?? '',
      email: settings.pickupEmail,
      line1: settings.pickupLine1 ?? '',
      line2: settings.pickupLine2,
      city: settings.pickupCity ?? 'Kuwait City',
      state: settings.pickupState,
      country: settings.pickupCountry ?? 'KW',
      postalCode: settings.pickupPostalCode,
      area: settings.pickupArea,
      block: settings.pickupBlock,
      street: settings.pickupStreet,
      building: settings.pickupBuilding,
    };
  }

  private decryptCredentials(encryptedCredentials: string): Record<string, string> {
    try {
      if (!encryptedCredentials) return {};
      const decrypted = encryption.decrypt(encryptedCredentials);
      return JSON.parse(decrypted);
    } catch (err) {
      logger.error({ err }, '[ShippingCarrierService] Failed to decrypt credentials');
      return {};
    }
  }

  private async invalidateCarrierConfigCache(storeId: string) {
    try {
      await redis.delete(`${CARRIER_CONFIG_CACHE_PREFIX}${storeId}`);
    } catch (err) {
      logger.warn(
        { err, storeId },
        '[ShippingCarrierService] Failed to invalidate carrier config cache'
      );
    }
  }
}

export const shippingCarrierService = new ShippingCarrierService();
