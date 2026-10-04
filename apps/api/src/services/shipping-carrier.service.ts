// ==========================================
// Shipping Carrier Service
// Orchestrates carrier integrations: shipment creation, tracking, webhooks
// ==========================================

import crypto from 'node:crypto';
import { prisma, Prisma, runInTenantContext, runInStoreScope, withMoneyTx } from '@force/database';
import { getShipmentStoreIdByTracking } from '../lib/definer';
import { config as appConfig } from '../config';
import {
  mergeTracking,
  TERMINAL_SHIPMENT_STATUSES,
  verifyWebhookToken,
} from '../lib/shipment-tracking';
import { sweepAcrossStores } from '../lib/cross-store';
import { redis } from './redis.service';
import { encryption } from './encryption.service';
import { notificationDispatcher } from './notification-dispatcher.service';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';

import { iCarryCarrier } from './carriers/icarry.carrier';
import { aramexCarrier } from './carriers/aramex.carrier';
import { bostaCarrier } from './carriers/bosta.carrier';
import { manualCarrier } from './carriers/manual.carrier';
import {
  ShippingCarrierProvider,
  CarrierCode,
  ShipmentAddress,
  CarrierError,
  CarrierCallContext,
  CarrierLabel,
  CarrierWebhookResult,
  ShipmentStatus,
  CREATION_FAILED,
  normalizeCancel,
} from './carriers/types';
import type { OrderStatus } from '@prisma/client';
import { AppError } from '../middleware/error-handler';
import { assertValidTransition, VALID_ORDER_TRANSITIONS } from './order-status-machine';
import { assertOrderFulfillable } from '../lib/order-fulfilment-guard';

const CARRIER_REGISTRY: Record<CarrierCode, ShippingCarrierProvider> = {
  icarry: iCarryCarrier,
  aramex: aramexCarrier,
  bosta: bostaCarrier,
  manual: manualCarrier,
};

export function getCarrierProvider(code: string): ShippingCarrierProvider | undefined {
  return (CARRIER_REGISTRY as Record<string, ShippingCarrierProvider>)[code];
}

/** A shipment still `creating` after this long lost its worker; it can be claimed again. */
const CLAIM_STALE_MS = 5 * 60_000;

/**
 * The COD the carrier must collect for an order, in piastres: the unpaid `cod` payment's
 * amount (which already carries any COD fee and net of any wallet credit), else 0.
 */
export function codAmountForOrder(order: {
  payments?: Array<{ provider: string; status: string; amount: number; createdAt?: Date }>;
}): number {
  const open = (order.payments ?? [])
    .filter(
      p => p.provider === 'cod' && ['pending', 'cod_pending', 'processing'].includes(p.status)
    )
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return open[0]?.amount ?? 0;
}

/** The public callback URL a carrier is given for a store, secret path token included. */
export function carrierCallbackUrl(carrier: string, storeId: string, secret: string): string {
  return `${appConfig.apiUrl.replace(/\/+$/, '')}/api/v1/webhooks/shipping/${carrier}/${storeId}/${secret}`;
}

// Cache TTL for carrier configs (5 minutes)
const CARRIER_CONFIG_CACHE_TTL = 300;
// `:v2:` is load-bearing, not cosmetic. Before 2026-09-23 this key cached the
// DECRYPTED rows, so `credentials` was a plain object; it now caches the
// still-encrypted Prisma rows. Redis outlives the deploy, so reusing the old
// key would feed a pre-fix object to decryptCredentials for the full 300s TTL
// (longer under a rolling restart, where old instances keep writing the old
// shape). That returned {} — indistinguishable from "no credentials" — and
// preserveMaskedCredentials would then drop the merchant's masked fields and
// persist the truncated set, permanently erasing an Aramex/iCarry secret.
// Bump this suffix on ANY change to the cached value's shape.
const CARRIER_CONFIG_CACHE_PREFIX = 'shipping:carrier-configs:v2:';

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
   * Get all carrier configs for a store (Redis-cached, credentials decrypted).
   *
   * S2-1 (2026-09-22 security audit): the Redis cache stores the row AS
   * FETCHED FROM PRISMA — `credentials` still AES-256-GCM-encrypted, same as
   * at rest in Postgres. Decryption happens AFTER every read (cache hit or
   * miss), never before the write to Redis. Before this fix the cache stored
   * the DECRYPTED blob for the full 300s TTL — Aramex/iCarry API keys sat in
   * Redis in plaintext, the same tier that was publicly reachable without
   * auth until 2026-09-04.
   */
  async getCarrierConfigs(storeId: string) {
    const cacheKey = `${CARRIER_CONFIG_CACHE_PREFIX}${storeId}`;

    // Try cache first — encrypted, same shape Prisma returns.
    let configs = await redis.get<any[]>(cacheKey, true);

    if (configs === null) {
      // Fetch from DB
      configs = await prisma.shippingCarrierConfig.findMany({
        where: { storeId },
        orderBy: { createdAt: 'asc' },
      });

      // Cache the still-ENCRYPTED rows (best-effort).
      try {
        await redis.set(cacheKey, configs, CARRIER_CONFIG_CACHE_TTL);
      } catch (err) {
        logger.warn(
          { err, storeId },
          '[ShippingCarrierService] Cache write failed for carrier configs'
        );
      }
    }

    // Decrypt after every read — this result is never itself cached.
    return configs.map(cfg => ({
      ...cfg,
      credentials: cfg.credentials ? this.decryptCredentials(cfg.credentials) : {},
    }));
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
    // Masked-secret resubmit guard: the route GET returns credentials masked
    // (e.g. `abcd******`, or `****`). If the merchant saves a carrier without
    // editing a credential, that masked value comes back on the PUT —
    // persisting it would overwrite the real encrypted secret (ICarry apiKey,
    // Aramex password) with mask text. Treat any value still carrying a `*`
    // as "unchanged" and keep the stored credential instead.
    // `webhookSecret` is server-managed (it authenticates the carrier's callbacks): whatever
    // the client sent is dropped, and it is re-attached below from the stored value.
    const { webhookSecret: _ignored, ...clientCredentials } = data.credentials;
    const mergedCredentials = await this.preserveMaskedCredentials(
      storeId,
      carrier,
      clientCredentials
    );
    if (getCarrierProvider(carrier)?.capabilities.webhooks && carrier !== 'icarry') {
      mergedCredentials.webhookSecret = await this.webhookSecretFor(storeId, carrier, false);
    }
    const encryptedCredentials = encryption.encrypt(JSON.stringify(mergedCredentials));

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
   * Merge incoming carrier credentials over the currently-stored (decrypted)
   * values, preserving any field whose incoming value is still a mask. The
   * route's `maskCredentials` always emits AT LEAST 4 consecutive asterisks
   * (`<prefix>****` for a value longer than 4 chars, bare `****` otherwise —
   * see `shipping-carrier.routes.ts`'s `maskCredentials`), so the sentinel
   * check requires that exact shape (`****`), not a bare `includes('*')`.
   * #1866: a real credential legitimately containing a single `*` (a
   * password with a special char) used to match the old bare check, throw
   * CARRIER_CREDENTIALS_UNRESOLVED, and block the save with no stored
   * fallback — mirrors notification-config.service.ts's identical fix for
   * the same class of bug.
   */
  private async preserveMaskedCredentials(
    storeId: string,
    carrier: CarrierCode,
    incoming: Record<string, string>
  ): Promise<Record<string, string>> {
    let stored: Record<string, string> | null = null;
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value === 'string' && value.includes('****')) {
        if (stored === null) {
          // Straight from Prisma, NEVER through getCarrierConfig's 300s cache.
          // This read is the merge base for a secret we are about to
          // overwrite, so it has to be the current truth: a cached base is
          // stale by up to the TTL, which silently reverts a credential the
          // merchant changed moments ago on another replica — and a cache
          // holding an unexpected shape reads as "no credentials" and erases
          // the secret outright.
          const current = await prisma.shippingCarrierConfig.findUnique({
            where: { storeId_carrier: { storeId, carrier } },
            select: { credentials: true },
          });
          stored = current?.credentials ? this.decryptCredentials(current.credentials) : {};
        }
        const storedVal = stored[key];
        // Keep the real stored secret. If we cannot resolve one, REFUSE the
        // save: dropping the field here persists a truncated credential set
        // over a working one, which is silent, permanent data loss the
        // merchant never sees. Failing the write is recoverable; erasing
        // their carrier password is not.
        if (typeof storedVal === 'string' && storedVal.length > 0) {
          out[key] = storedVal;
        } else {
          throw new AppError(
            400,
            'CARRIER_CREDENTIALS_UNRESOLVED',
            `Re-enter the ${carrier} credentials: the saved value for "${key}" could not be read, and saving now would erase it.`
          );
        }
      } else {
        out[key] = value;
      }
    }

    return out;
  }

  /**
   * The per-store secret that authenticates a carrier's webhook callbacks (it rides in the URL
   * path, because carriers like Bosta sign nothing). Kept inside the encrypted credentials,
   * generated once, replaced only on `rotate`.
   */
  private async webhookSecretFor(
    storeId: string,
    carrier: CarrierCode,
    rotate: boolean
  ): Promise<string> {
    if (!rotate) {
      // Straight from Prisma: the merge base must be the current truth, not the 300 s cache.
      const current = await prisma.shippingCarrierConfig.findUnique({
        where: { storeId_carrier: { storeId, carrier } },
        select: { credentials: true },
      });
      const stored = current?.credentials ? this.decryptCredentials(current.credentials) : {};
      if (stored.webhookSecret) return stored.webhookSecret;
    }
    return crypto.randomBytes(24).toString('hex');
  }

  /** Replace the webhook secret (the old callback URL stops working at once). */
  async rotateWebhookSecret(storeId: string, carrier: CarrierCode) {
    const current = await prisma.shippingCarrierConfig.findUnique({
      where: { storeId_carrier: { storeId, carrier } },
      select: { credentials: true },
    });
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Carrier is not configured');
    const stored = current.credentials ? this.decryptCredentials(current.credentials) : {};
    stored.webhookSecret = await this.webhookSecretFor(storeId, carrier, true);
    await prisma.shippingCarrierConfig.update({
      where: { storeId_carrier: { storeId, carrier } },
      data: { credentials: encryption.encrypt(JSON.stringify(stored)) },
    });
    await this.invalidateCarrierConfigCache(storeId);
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
    return carrierImpl.testConnection(config.credentials, this.callContext(config));
  }

  // ==========================================
  // Shipment Lifecycle
  // ==========================================

  /** What an adapter is handed next to the decrypted credentials. */
  callContext(cfg?: {
    storeId?: string;
    carrier?: string;
    settings?: unknown;
    credentials?: Record<string, string>;
  }): CarrierCallContext {
    const settings = (cfg?.settings as Record<string, unknown> | undefined) ?? {};
    const secret = cfg?.credentials?.webhookSecret;
    const impl = cfg?.carrier ? getCarrierProvider(cfg.carrier) : undefined;
    return {
      settings,
      callbackUrl:
        impl?.capabilities.webhooks && cfg?.storeId && secret && cfg.carrier !== 'icarry'
          ? carrierCallbackUrl(cfg.carrier!, cfg.storeId, secret)
          : undefined,
    };
  }

  /**
   * Book a shipment for an order with the default (or specified) carrier.
   *
   * Safe to call twice and from two places at once (admin click, Inngest retry): the row is
   * CLAIMED (`creating`) before the carrier is called, so a second caller gets the existing row
   * and a failed booking (`creation_failed`, or a cancelled shipment being re-booked) is
   * claimed by exactly one retry. The carrier call sits outside every transaction.
   */
  async createShipmentForOrder(
    storeId: string,
    orderId: string,
    carrierCode?: CarrierCode,
    opts: { manual?: { carrierName: string; trackingNumber: string } } = {}
  ) {
    logger.info(
      { storeId, orderId, carrierCode },
      '[ShippingCarrierService] createShipmentForOrder'
    );

    const existing = await prisma.shipment.findFirst({ where: { orderId, storeId } });
    const rebookable =
      existing &&
      (existing.status === CREATION_FAILED ||
        existing.status === 'cancelled' ||
        (existing.status === 'creating' &&
          Date.now() - existing.updatedAt.getTime() > CLAIM_STALE_MS));
    if (existing && !rebookable) {
      // Idempotency: a second click / retry returns the shipment instead of a second parcel.
      return existing;
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        customer: { select: { email: true, firstName: true, lastName: true } },
        payments: { select: { provider: true, status: true, amount: true, createdAt: true } },
      },
    });
    if (!order) {
      throw new AppError(404, 'NOT_FOUND', `Order ${orderId} not found in store ${storeId}`);
    }

    // An unconfirmed InstaPay order never ships (SP6a): refuse BEFORE any carrier call.
    assertOrderFulfillable(order);
    // ...and neither does an order the state machine would refuse to ship (cancelled, refunded):
    // find out now, not after a real parcel was booked.
    if (order.status !== 'shipped') assertValidTransition(order.status, 'shipped');

    const resolvedCarrierCode = carrierCode ?? (await this.getDefaultCarrierCode(storeId));
    if (!resolvedCarrierCode) {
      throw new AppError(409, 'NO_CARRIER', 'No default carrier configured for this store');
    }
    const carrierImpl = CARRIER_REGISTRY[resolvedCarrierCode];
    if (!carrierImpl)
      throw new AppError(400, 'INVALID_CARRIER', `Unknown carrier: ${resolvedCarrierCode}`);

    // The manual carrier needs no stored configuration; every other one must be enabled.
    const carrierConfig =
      resolvedCarrierCode === 'manual'
        ? null
        : await this.getCarrierConfig(storeId, resolvedCarrierCode);
    if (resolvedCarrierCode !== 'manual' && (!carrierConfig || !carrierConfig.enabled)) {
      throw new AppError(
        409,
        'CARRIER_NOT_ENABLED',
        `Carrier ${resolvedCarrierCode} is not enabled for this store`
      );
    }

    const settings = (carrierConfig?.settings as Record<string, any>) ?? {};
    const pickupAddress = this.buildPickupAddress(storeId, settings);
    const shippingAddr = order.shippingAddress as Record<string, any>;
    const deliveryAddress: ShipmentAddress = {
      name: `${shippingAddr.firstName ?? ''} ${shippingAddr.lastName ?? ''}`.trim() || 'Customer',
      phone: shippingAddr.phone ?? '',
      email: order.customer?.email,
      line1: shippingAddr.address1 ?? shippingAddr.line1 ?? '',
      line2: shippingAddr.address2 ?? shippingAddr.line2,
      city: shippingAddr.city ?? '',
      state: shippingAddr.state,
      country: shippingAddr.country ?? 'EG',
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
    const codAmount = codAmountForOrder(order);
    if (codAmount > 0 && carrierImpl.capabilities.cod === false) {
      throw new CarrierError(
        'COD_NOT_SUPPORTED',
        `${carrierImpl.name} cannot collect cash on delivery; use another carrier for this order`
      );
    }

    // A re-booked (previously cancelled) shipment is a NEW parcel, so it gets a new reference;
    // a retry of a failed booking keeps the old one, which is what lets the carrier dedupe it.
    const history0 = Array.isArray(existing?.statusHistory)
      ? (existing!.statusHistory as any[])
      : [];
    const cancelCount = history0.filter(h => h?.status === 'cancelled').length;
    const merchantReference = cancelCount > 0 ? `${order.id}-r${cancelCount}` : order.id;

    // ---- claim the row (committed on its own, before the carrier is called)
    const claimedId = await this.claimShipmentRow({
      storeId,
      orderId,
      existingId: existing?.id,
      carrier: resolvedCarrierCode,
      pickupAddress,
      deliveryAddress,
      codAmount,
      carrierName: opts.manual?.carrierName,
      weight: settings.defaultWeight,
    });
    if (!claimedId) {
      const current = await prisma.shipment.findFirst({ where: { orderId, storeId } });
      if (current) return current;
      throw new AppError(409, 'SHIPMENT_IN_PROGRESS', 'A shipment is already being created');
    }

    // ---- call the carrier (no transaction held)
    let response;
    try {
      response = await carrierImpl.createShipment(
        carrierConfig?.credentials ?? {},
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          merchantReference,
          pickupAddress,
          deliveryAddress,
          items,
          weight: settings.defaultWeight ?? 0.5,
          codAmount: codAmount > 0 ? codAmount : undefined,
          manual: opts.manual,
        },
        this.callContext(carrierConfig ? { ...carrierConfig, storeId } : undefined)
      );
    } catch (err) {
      await this.recordCreationFailure(storeId, claimedId, err);
      throw err;
    }

    // ---- record it (own short transaction) and move the order along
    const shipment = await runInTenantContext(storeId, () =>
      prisma.shipment.update({
        where: { id: claimedId },
        data: {
          status: 'created',
          error: null,
          trackingNumber: response.trackingNumber,
          trackingUrl: response.trackingUrl,
          labelUrl: response.labelUrl,
          carrierShipmentId: response.carrierShipmentId,
          carrierTransactionId: response.carrierTransactionId,
          estimatedDeliveryAt: response.estimatedDelivery,
          statusHistory: [
            ...history0,
            {
              status: 'created',
              timestamp: new Date().toISOString(),
              description: `Shipment created via ${resolvedCarrierCode}`,
            },
          ],
        },
      })
    );

    try {
      await runInTenantContext(storeId, () =>
        setOrderStatusGuarded(prisma, storeId, orderId, 'shipped')
      );
    } catch (txError) {
      // The carrier has the parcel and the shipment row says so; only the order's status did not
      // move. Do NOT fail the booking (a retry would find the row and could not flip it either):
      // say so on the shipment where the merchant sees it.
      logger.error(
        {
          err: txError,
          orderId,
          storeId,
          carrier: resolvedCarrierCode,
          carrierShipmentId: response.carrierShipmentId,
          trackingNumber: response.trackingNumber,
        },
        '[ShippingCarrierService] shipment booked but the order could not be marked shipped'
      );
      await runInTenantContext(storeId, () =>
        prisma.shipment.update({
          where: { id: claimedId },
          data: { error: 'Booked, but the order status could not be set to shipped' },
        })
      ).catch(() => undefined);
    }

    // Shipment notification fully fire-and-forget (called from the admin route and from the
    // Inngest job; neither may wait on the notification provider).
    void prisma.store
      .findUnique({ where: { id: storeId }, select: { name: true } })
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

  /** Insert or re-claim the shipment row as `creating`; null when someone else holds it. */
  private async claimShipmentRow(input: {
    storeId: string;
    orderId: string;
    existingId?: string;
    carrier: string;
    pickupAddress: ShipmentAddress;
    deliveryAddress: ShipmentAddress;
    codAmount: number;
    carrierName?: string;
    weight?: unknown;
  }): Promise<string | null> {
    const { storeId } = input;
    const fields = {
      carrier: input.carrier,
      status: 'creating',
      error: null,
      codAmount: input.codAmount,
      carrierName: input.carrierName ?? null,
      pickupAddress: input.pickupAddress as any,
      deliveryAddress: input.deliveryAddress as any,
      weight: input.weight ? String(input.weight) : null,
    };
    try {
      return await runInTenantContext(storeId, async () => {
        if (!input.existingId) {
          const row = await prisma.shipment.create({
            data: { storeId, orderId: input.orderId, ...fields, createAttempts: 1 },
          });
          return row.id;
        }
        const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
        const r = await prisma.shipment.updateMany({
          where: {
            id: input.existingId,
            storeId,
            OR: [
              { status: { in: [CREATION_FAILED, 'cancelled'] } },
              { status: 'creating', updatedAt: { lt: staleBefore } },
            ],
          },
          data: { ...fields, createAttempts: { increment: 1 } },
        });
        return r.count === 1 ? input.existingId : null;
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return null; // lost the insert race
      throw err;
    }
  }

  /** Record a failed booking on the row, in a transaction of its own (survives a rolled-back request). */
  private async recordCreationFailure(storeId: string, shipmentId: string, err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    try {
      await runInTenantContext(storeId, () =>
        prisma.shipment.update({
          where: { id: shipmentId },
          data: { status: CREATION_FAILED, error: message },
        })
      );
    } catch (e) {
      logger.error(
        { err: e, shipmentId },
        '[ShippingCarrierService] could not record a failed booking'
      );
    }
  }

  /**
   * Cancel a shipment. The carrier is asked first: a parcel it already has is NOT marked
   * cancelled here (it is still moving), unless the merchant forces it.
   */
  async cancelShipment(shipmentId: string, opts: { force?: boolean } = {}) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { order: { select: { storeId: true, id: true } } },
    });

    if (!shipment) {
      throw new AppError(404, 'NOT_FOUND', `Shipment ${shipmentId} not found`);
    }
    if (shipment.status === 'cancelled') return shipment;
    if (['delivered', 'returned'].includes(shipment.status)) {
      throw new AppError(
        409,
        'SHIPMENT_NOT_CANCELLABLE',
        `A ${shipment.status} shipment cannot be cancelled`
      );
    }

    const carrierCode = shipment.carrier as CarrierCode;
    const impl = CARRIER_REGISTRY[carrierCode];
    if (!impl) throw new AppError(400, 'INVALID_CARRIER', `Unknown carrier: ${carrierCode}`);

    let carrierNote = 'Cancelled with carrier';
    let carrierCancelled = false;
    if (shipment.carrierShipmentId && shipment.status !== CREATION_FAILED) {
      const carrierConfig =
        carrierCode === 'manual'
          ? null
          : await this.getCarrierConfig(shipment.storeId, carrierCode);
      if (carrierCode !== 'manual' && !carrierConfig) {
        throw new AppError(
          409,
          'CARRIER_NOT_ENABLED',
          `No config found for carrier ${carrierCode}`
        );
      }
      let result;
      try {
        result = normalizeCancel(
          await impl.cancelShipment(
            carrierConfig?.credentials ?? {},
            shipment.carrierShipmentId,
            this.callContext(
              carrierConfig ? { ...carrierConfig, storeId: shipment.storeId } : undefined
            )
          )
        );
      } catch (err) {
        if (!opts.force) throw err;
        result = { status: 'failed' as const };
      }
      carrierCancelled = result.status === 'cancelled';
      if (!carrierCancelled && !opts.force) {
        throw new AppError(
          409,
          result.status === 'not_cancellable'
            ? 'SHIPMENT_NOT_CANCELLABLE'
            : 'CARRIER_CANCEL_FAILED',
          result.status === 'not_cancellable'
            ? 'The carrier already has this parcel and will not cancel it. Contact the carrier, or force-cancel here to stop tracking it.'
            : 'The carrier did not confirm the cancellation. Try again, or force-cancel here.'
        );
      }
      if (!carrierCancelled)
        carrierNote = 'Marked cancelled by the merchant (carrier did not cancel)';
    } else {
      carrierNote = 'Cancelled (nothing was booked with the carrier)';
    }

    const history = Array.isArray(shipment.statusHistory) ? (shipment.statusHistory as any[]) : [];
    const updatedShipment = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: 'cancelled',
        error: null,
        statusHistory: [
          ...history,
          { status: 'cancelled', timestamp: new Date().toISOString(), description: carrierNote },
        ],
      },
    });

    // Shipment cancelled → the order returns to processing, if it had been shipped.
    const orderNow = await prisma.order.findFirst({
      where: { id: shipment.orderId, storeId: shipment.storeId },
      select: { status: true },
    });
    if (orderNow?.status === 'shipped') {
      await setOrderStatusGuarded(prisma, shipment.storeId, shipment.orderId, 'processing');
    }

    await auditLog({
      action: 'shipment.cancelled',
      storeId: shipment.storeId,
      resourceType: 'shipment',
      resourceId: shipmentId,
      details: {
        orderId: shipment.orderId,
        carrier: shipment.carrier,
        fromStatus: shipment.status,
        toStatus: 'cancelled',
        carrierCancelled,
      },
    });

    return updatedShipment;
  }

  /** The label for a shipment: the stored URL, else the carrier's (PDF bytes or a URL). */
  async getLabel(shipmentId: string): Promise<CarrierLabel> {
    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment || !shipment.carrierShipmentId || !shipment.trackingNumber) {
      throw new AppError(404, 'NOT_FOUND', 'No booked shipment to print a label for');
    }
    const carrierCode = shipment.carrier as CarrierCode;
    const impl = CARRIER_REGISTRY[carrierCode];
    if (!impl?.getLabel) {
      throw new AppError(
        400,
        'LABEL_NOT_SUPPORTED',
        `${impl?.name ?? carrierCode} has no printable label`
      );
    }
    const carrierConfig = await this.getCarrierConfig(shipment.storeId, carrierCode);
    if (!carrierConfig) throw new AppError(409, 'CARRIER_NOT_ENABLED', 'Carrier is not configured');
    const label = await impl.getLabel(
      carrierConfig.credentials,
      { carrierShipmentId: shipment.carrierShipmentId, trackingNumber: shipment.trackingNumber },
      this.callContext({ ...carrierConfig, storeId: shipment.storeId })
    );
    if (label.url && label.url !== shipment.labelUrl) {
      await prisma.shipment.update({ where: { id: shipmentId }, data: { labelUrl: label.url } });
    }
    return label;
  }

  /** The shipment of an order plus what the order page needs to offer actions. */
  async getShipmentForOrder(storeId: string, orderId: string) {
    const [shipment, configs, order] = await Promise.all([
      prisma.shipment.findFirst({ where: { orderId, storeId } }),
      this.getCarrierConfigs(storeId),
      prisma.order.findFirst({
        where: { id: orderId, storeId },
        select: {
          status: true,
          payments: { select: { provider: true, status: true, amount: true, createdAt: true } },
        },
      }),
    ]);
    const enabled = configs.filter((c: any) => c.enabled).map((c: any) => c.carrier as string);
    const carriers = [...enabled.filter(c => CARRIER_REGISTRY[c as CarrierCode]), 'manual'].map(
      code => {
        const impl = CARRIER_REGISTRY[code as CarrierCode];
        return { code, name: impl.name, capabilities: impl.capabilities };
      }
    );
    const orderStatus = order?.status ?? null;
    return {
      shipment,
      carriers,
      codAmount: order ? codAmountForOrder(order) : 0,
      // the same gate the booking applies, so the page does not offer what would be refused
      canBook:
        !!order &&
        (order.status === 'shipped' ||
          VALID_ORDER_TRANSITIONS[order.status as OrderStatus]?.includes('shipped')),
      orderStatus,
    };
  }

  /** Manual carrier: the merchant moves the shipment along (picked up, delivered, ...). */
  async manualUpdateStatus(shipmentId: string, status: ShipmentStatus) {
    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new AppError(404, 'NOT_FOUND', 'Shipment not found');
    if (shipment.carrier !== 'manual') {
      throw new AppError(400, 'NOT_MANUAL', 'Only manual shipments are updated by hand');
    }
    return this.applyTrackingEntries(
      shipment.id,
      [{ status, timestamp: new Date(), description: 'Updated by the merchant' }],
      'merchant_manual'
    ).then(r => r.shipment);
  }

  /**
   * Fold carrier events into a shipment, whichever way they arrived (poll, webhook, merchant).
   *  - an event already in the history (same status AND timestamp) is a no-op: a replayed
   *    webhook or a poll that returns the whole history changes nothing;
   *  - events are kept in time order and the NEWEST decides the status, so a late old event
   *    cannot move a shipment backwards;
   *  - a finished shipment (delivered / cancelled / returned) is never reopened by a stray
   *    in-flight event.
   */
  async applyTrackingEntries(
    shipmentId: string,
    entries: Array<{
      status: ShipmentStatus;
      timestamp: Date;
      location?: string;
      description?: string;
    }>,
    source: 'carrier_poll' | 'carrier_webhook' | 'merchant_manual',
    extra: { estimatedDelivery?: Date } = {}
  ) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        order: {
          include: { customer: { select: { email: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!shipment) throw new AppError(404, 'NOT_FOUND', `Shipment ${shipmentId} not found`);

    const history = Array.isArray(shipment.statusHistory) ? (shipment.statusHistory as any[]) : [];
    const merged = mergeTracking({ history, currentStatus: shipment.status, events: entries });

    if (merged.added === 0) {
      const touched =
        source === 'carrier_poll'
          ? await prisma.shipment.update({
              where: { id: shipmentId },
              data: { lastPolledAt: new Date() },
            })
          : shipment;
      return { shipment: touched, applied: false };
    }
    const nextStatus = merged.status;

    const prevStatus = shipment.status;
    const updated = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: nextStatus,
        statusHistory: merged.history as unknown as Prisma.InputJsonValue,
        ...(extra.estimatedDelivery ? { estimatedDeliveryAt: extra.estimatedDelivery } : {}),
        ...(source === 'carrier_poll' ? { lastPolledAt: new Date() } : {}),
      },
    });

    if (prevStatus !== nextStatus) {
      await auditLog({
        action: 'shipment.status_changed',
        storeId: shipment.storeId,
        resourceType: 'shipment',
        resourceId: shipmentId,
        details: {
          orderId: shipment.orderId,
          carrier: shipment.carrier,
          fromStatus: prevStatus,
          toStatus: nextStatus,
          source,
        },
      });
    }

    if (nextStatus === 'delivered' && prevStatus !== 'delivered') {
      await setOrderStatusGuarded(prisma, shipment.storeId, shipment.orderId, 'delivered');
      const store = await prisma.store
        .findUnique({ where: { id: shipment.storeId }, select: { name: true } })
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

    return { shipment: updated, applied: true };
  }

  /**
   * Poll the carrier for the latest tracking and fold it in. Runs from the cron (one store scope
   * per shipment) and from the admin "refresh" button.
   */
  async updateShipmentStatus(shipmentId: string) {
    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new AppError(404, 'NOT_FOUND', `Shipment ${shipmentId} not found`);
    }
    if (!shipment.trackingNumber) {
      logger.warn(
        { shipmentId },
        '[ShippingCarrierService] No tracking number, skipping status update'
      );
      return shipment;
    }
    const carrierCode = shipment.carrier as CarrierCode;
    const impl = CARRIER_REGISTRY[carrierCode];
    if (!impl || !impl.capabilities.polling) return shipment; // manual: nothing to ask
    const carrierConfig = await this.getCarrierConfig(shipment.storeId, carrierCode);
    if (!carrierConfig) {
      logger.warn({ shipmentId, carrierCode }, '[ShippingCarrierService] No carrier config found');
      return shipment;
    }

    let tracking;
    try {
      tracking = await impl.trackShipment(
        carrierConfig.credentials,
        shipment.trackingNumber,
        this.callContext({ ...carrierConfig, storeId: shipment.storeId })
      );
    } catch (err) {
      // A carrier outage never breaks anything here: the next poll tries again.
      logger.error({ err, shipmentId }, '[ShippingCarrierService] trackShipment failed');
      return shipment;
    }

    const result = await this.applyTrackingEntries(
      shipmentId,
      tracking.statusHistory,
      'carrier_poll',
      { estimatedDelivery: tracking.estimatedDelivery }
    );
    return result.shipment;
  }

  /**
   * Legacy path (iCarry, one global bearer secret): the carrier names the parcel by tracking
   * number only, so the owning store is resolved by a definer first.
   */
  async processWebhook(carrier: string, body: unknown, headers: Record<string, string>) {
    const impl = getCarrierProvider(carrier);
    if (!impl) {
      logger.warn({ carrier }, '[ShippingCarrierService] Unknown carrier webhook received');
      return null;
    }
    const result = impl.processWebhook(body, headers);
    if (!result) {
      logger.warn(
        { carrier },
        '[ShippingCarrierService] Carrier returned null from processWebhook'
      );
      return null;
    }
    const webhookStoreId = await getShipmentStoreIdByTracking(result.trackingNumber);
    if (!webhookStoreId) {
      logger.warn(
        { trackingNumber: result.trackingNumber, carrier },
        '[ShippingCarrierService] No shipment found for webhook tracking number'
      );
      return null;
    }
    return runInTenantContext(webhookStoreId, async () => this.applyWebhookResult(carrier, result));
  }

  /**
   * A webhook for a carrier that signs nothing (Bosta): the callback URL carries the store id
   * and that store's secret token. The token is compared (constant time) against the secret in
   * the store's encrypted carrier credentials; a wrong token, an unknown store and a store
   * without that carrier are the same `unauthorized`, so the answer is no oracle.
   */
  async processCarrierWebhook(
    carrier: string,
    storeId: string,
    token: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<'unauthorized' | 'ignored' | 'unknown_shipment' | 'duplicate' | 'applied'> {
    const impl = getCarrierProvider(carrier);
    if (!impl || !impl.capabilities.webhooks || carrier === 'icarry') return 'unauthorized';
    if (!/^[0-9a-f-]{36}$/i.test(storeId)) return 'unauthorized';

    return runInTenantContext(storeId, async () => {
      // Straight from Prisma (not the 300 s cache): a rotated secret must stop working at once.
      const row = await prisma.shippingCarrierConfig.findUnique({
        where: { storeId_carrier: { storeId, carrier } },
        select: { credentials: true },
      });
      const secret = row?.credentials ? this.decryptCredentials(row.credentials).webhookSecret : '';
      if (!verifyWebhookToken(secret, token)) return 'unauthorized' as const;

      const result = impl.processWebhook(body, headers);
      if (!result) return 'ignored' as const;
      return this.applyWebhookResult(carrier, result);
    });
  }

  private async applyWebhookResult(
    carrier: string,
    result: CarrierWebhookResult
  ): Promise<'unknown_shipment' | 'duplicate' | 'applied'> {
    const shipment = await prisma.shipment.findFirst({
      where: { trackingNumber: result.trackingNumber, carrier },
      select: { id: true },
    });
    if (!shipment) {
      logger.warn(
        { trackingNumber: result.trackingNumber, carrier },
        '[ShippingCarrierService] No shipment found for webhook tracking number'
      );
      return 'unknown_shipment';
    }
    const r = await this.applyTrackingEntries(
      shipment.id,
      [
        {
          status: result.status,
          timestamp: result.timestamp,
          location: result.location,
          description: result.description,
        },
      ],
      'carrier_webhook'
    );
    return r.applied ? 'applied' : 'duplicate';
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

  async runTrackingCron() {
    // Only carriers that must be polled; a manual shipment has nothing to ask.
    const polled = (Object.keys(CARRIER_REGISTRY) as CarrierCode[]).filter(
      c => CARRIER_REGISTRY[c].capabilities.polling && c !== 'manual'
    );
    const RUN_CAP = 200; // safety limit per run
    // Strict RLS: one tenant transaction per store finds the due shipments; each is then
    // polled in its own store scope (the carrier call holds no transaction).
    const active = await sweepAcrossStores({
      fetch: () =>
        prisma.shipment.findMany({
          where: {
            status: { notIn: [...TERMINAL_SHIPMENT_STATUSES, CREATION_FAILED, 'creating'] },
            trackingNumber: { not: null },
            carrier: { in: polled },
          },
          select: { id: true, storeId: true, lastPolledAt: true },
          orderBy: { lastPolledAt: { sort: 'asc', nulls: 'first' } },
          take: RUN_CAP,
        }),
      orderKey: r => r.lastPolledAt ?? 0,
      take: RUN_CAP,
    });

    logger.info(
      { count: active.length },
      '[ShippingCarrierService] Tracking cron: polling shipments'
    );

    // Bounded concurrency: the provider call dominates, and carriers rate-limit.
    const concurrency = 8;
    const queue = [...active];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) return;
        try {
          await runInStoreScope(next.storeId, () => this.updateShipmentStatus(next.id));
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
      city: settings.pickupCity ?? 'Cairo',
      state: settings.pickupState,
      country: settings.pickupCountry ?? 'EG',
      postalCode: settings.pickupPostalCode,
      area: settings.pickupArea,
      block: settings.pickupBlock,
      street: settings.pickupStreet,
      building: settings.pickupBuilding,
    };
  }

  private decryptCredentials(encryptedCredentials: string): Record<string, string> {
    if (!encryptedCredentials) return {};
    // Outside the try ON PURPOSE. A non-string here means the caller handed us
    // an ALREADY-DECRYPTED object — the pre-v2 cache shape. Letting that fall
    // into the catch below returns {}, which every caller reads as "this
    // merchant has no credentials configured": carrier auth fails on live
    // orders, and the masked-resubmit merge erases the real secret. A wrong
    // shape is a bug, not a missing credential, so it fails loudly.
    if (typeof encryptedCredentials !== 'string') {
      throw new Error(
        '[ShippingCarrierService] credentials are not an encrypted string — refusing to read them as empty'
      );
    }
    try {
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

/**
 * Read the order's current status and assert the transition before writing it.
 * These four writers set Order.status directly, outside OrderService.updateStatus,
 * so they bypassed assertValidTransition entirely — the state machine could be
 * violated by any carrier flow. Scoped by storeId as well: the order must belong
 * to the store the shipment belongs to.
 */
async function setOrderStatusGuarded(
  client: Prisma.TransactionClient | typeof prisma,
  storeId: string,
  orderId: string,
  to: OrderStatus
): Promise<void> {
  const current = await client.order.findFirst({
    where: { id: orderId, storeId },
    select: { status: true },
  });
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Order not found for this store');
  if (current.status === to) return;
  assertValidTransition(current.status, to);
  await client.order.update({ where: { id: orderId }, data: { status: to } });
}

export const shippingCarrierService = new ShippingCarrierService();
