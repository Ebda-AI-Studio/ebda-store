// ==========================================
// Shipping Carrier Service
// Orchestrates carrier integrations: shipment creation, tracking, webhooks
// ==========================================

import { customerRow, customerRows } from '../lib/customer-directory';
import { sendEventAfterCommit } from '../lib/inngest/send-after-commit';
import { CI_SHIPMENT_BOOKED_EVENT, CI_SHIPMENT_TRACKED_EVENT } from '../lib/ci/events';
import { shipmentStamps } from '../lib/ci/shipment-stamps';
import { areaKeyFor } from '../lib/ci/area-key';
import crypto from 'node:crypto';
import {
  currentStoreId,
  prisma,
  Prisma,
  withStore,
  runInStoreScope,
  withMoneyTx,
} from '@ebda/database';
import { storeDb, storeMoney, storeRepo, storeWriter } from '../lib/repo-factory';
import { platformDb } from '../lib/platform-directory';
import { listDirectoryStores } from './platform/directory-d1';
import { runInStoreCtx } from '../lib/jobs/store-db';
import { getShipmentStoreIdByTracking } from '../lib/definer';
import { config as appConfig } from '../config';
import {
  mergeTracking,
  TERMINAL_SHIPMENT_STATUSES,
  verifyWebhookToken,
} from '../lib/shipment-tracking';
import { sweepAcrossStores } from '../lib/cross-store';
import { safeEqual } from '../lib/carrier-http';
import { redis } from './redis.service';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';

import { CARRIER_REGISTRY } from './carriers/registry';
import { withAramexEmails } from './carriers/aramex.carrier';
import {
  activeCredentials,
  decryptCarrierBlob,
  previousSecretGraceOpen,
  encryptCarrierBlob,
} from './carriers/carrier-credentials';
import {
  applyCarrierCredentialUpdate,
  assertCarrierEnableAllowed,
  carrierEntry,
  publicCarrierConfig,
  rotateBlobWebhookSecret,
  runCarrierConnectionTest,
  type CarrierCredentialUpdate,
} from './carriers/carrier-connection.service';
import { isProviderUsableForStore } from './payment-providers/provider-gate';
import { recordProviderOperation, reportConnectionCheck } from './provider-verification.service';
import { deferAfterTenantCommit } from '../lib/after-tenant-commit';
import { describeConnectionCheck, type CredentialMode } from '@ebda/shared';
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
// The version suffix is load-bearing, not cosmetic: Redis outlives a deploy, and a cached row
// of an older shape (v1: decrypted credentials; v2: before the catalog blob + test_mode) fed to
// the readers below would read as "no credentials". Bump it on ANY change to the cached value's
// shape.
const CARRIER_CONFIG_CACHE_PREFIX = 'shipping:carrier-configs:v3:';

// Redis lock for tracking cron
const TRACKING_CRON_LOCK = 'shipping:tracking-cron';

interface ListShipmentsOptions {
  page?: number;
  limit?: number;
  status?: string;
  carrier?: string;
}

/** A short, secret-free code for a booking failure (the CarrierError code, never its message). */
function shipmentErrorCode(err: unknown): string {
  if (err instanceof CarrierError) return err.code;
  return err instanceof Error ? err.name.slice(0, 60) : 'UNKNOWN';
}

class ShippingCarrierService {
  private trackingCronTimer: ReturnType<typeof setInterval> | null = null;

  // ==========================================
  // Carrier Config Management
  // ==========================================

  /**
   * The raw (still ENCRYPTED) config rows of a store, Redis-cached. S2-1 (2026-09-22 security
   * audit): the cache holds the row as Prisma returned it, `credentials` ciphertext included,
   * never a decrypted secret; decryption happens after every read and is never itself cached.
   */
  private async getConfigRows(storeId: string) {
    const cacheKey = `${CARRIER_CONFIG_CACHE_PREFIX}${storeId}`;
    let rows = await redis.get<any[]>(cacheKey, true);
    if (rows === null) {
      // the store's backend (Ruling CF-JOBS-4): its Durable Object for a DO store, `prisma` for Postgres
      rows = await (
        await storeDb(storeId)
      ).shippingCarrierConfig.findMany({
        where: { storeId },
        orderBy: { createdAt: 'asc' },
      });
      try {
        await redis.set(cacheKey, rows, CARRIER_CONFIG_CACHE_TTL);
      } catch (err) {
        logger.warn(
          { err, storeId },
          '[ShippingCarrierService] Cache write failed for carrier configs'
        );
      }
    }
    return rows;
  }

  /**
   * Config rows for the SERVER (adapter calls): `credentials` is the ACTIVE mode's flat field map
   * plus the webhook secret. Never hand this to a browser: use `getPublicCarrierConfigs`.
   */
  async getCarrierConfigs(storeId: string) {
    const rows = await this.getConfigRows(storeId);
    return rows.map(cfg => ({ ...cfg, credentials: this.readActiveCredentials(cfg) }));
  }

  /** Config rows for the ADMIN: write-only credentials (hints), no ciphertext, no secret. */
  async getPublicCarrierConfigs(storeId: string) {
    const rows = await this.getConfigRows(storeId);
    return rows.map(cfg => publicCarrierConfig(cfg));
  }

  async getCarrierConfig(storeId: string, carrier: CarrierCode) {
    const configs = await this.getCarrierConfigs(storeId);
    return configs.find((c: any) => c.carrier === carrier) ?? null;
  }

  /**
   * Create or update one carrier's configuration (the catalog connect flow).
   *
   *  - `fields` are credentials of `mode`, validated against the catalog; '' / masked / undefined
   *    keep the stored value, null clears it (write-only: nothing is ever read back).
   *  - `activate` makes `mode` the active one; changing the active mode's credentials (or the
   *    mode) of an ENABLED carrier disables it: the new keys have not been tested.
   *  - enabling (or making default) passes the enable gate: PROVIDERS-2 + a current Test connection.
   */
  async upsertCarrierConfig(
    storeId: string,
    carrier: CarrierCode,
    input: {
      credentials?: CarrierCredentialUpdate;
      activate?: boolean;
      enabled?: boolean;
      isDefault?: boolean;
      settings?: Record<string, unknown>;
    }
  ) {
    const entry = carrierEntry(carrier);
    const out = await prisma.$transaction(async tx => {
      // Serialize concurrent saves of this carrier: two PUTs (sandbox keys + live keys, or settings
      // + a rotation) would otherwise each merge over the SAME snapshot and the later write would
      // silently revert the earlier one. (Nothing to lock on first creation: the unique key does it.)
      await tx.$queryRaw`SELECT 1 FROM shipping_carrier_configs WHERE store_id = ${storeId} AND carrier = ${carrier} FOR UPDATE`;
      // Straight from Prisma, never the cache: this read is the merge base for a secret.
      const existing = await tx.shippingCarrierConfig.findUnique({
        where: { storeId_carrier: { storeId, carrier } },
      });

      let cipher = existing?.credentials ?? '';
      let hints: unknown = existing?.credentialHints ?? {};
      let activeModeChanged = false;
      let changed: string[] = [];
      if (input.credentials) {
        let u;
        try {
          u = applyCarrierCredentialUpdate(entry, existing, input.credentials);
        } catch (err) {
          if (err instanceof AppError) throw err;
          // The stored blob cannot be read (a rotated ENCRYPTION_KEY, a corrupt row). Merging over
          // it would persist a truncated set over a working secret: refuse, writing nothing.
          throw new AppError(
            400,
            'CARRIER_CREDENTIALS_UNRESOLVED',
            `Re-enter the ${carrier} credentials: the saved ones could not be read, and saving now would erase them.`
          );
        }
        cipher = u.cipher;
        hints = u.hints;
        changed = u.changed;
        activeModeChanged = u.activeModeChanged;
      } else if (
        existing?.credentials &&
        existing.settings &&
        typeof existing.settings === 'object' &&
        'sandbox' in existing.settings
      ) {
        // A legacy flat blob is read as live, or as sandbox only BECAUSE `settings.sandbox` says so.
        // This save strips that key (the mode is `testMode` now), so the blob is re-shaped in the
        // same write: otherwise its sandbox keys would silently become the LIVE set.
        try {
          cipher = encryptCarrierBlob(decryptCarrierBlob(existing.credentials, existing.settings));
        } catch {
          /* unreadable: leave it untouched, a settings-only save must not need the secrets */
        }
      }
      const nextTestMode = input.activate
        ? input.credentials?.mode === 'sandbox'
        : (existing?.testMode ?? true);
      const modeSwitched = existing ? existing.testMode !== nextTestMode : false;
      const mustDisable = Boolean(existing?.enabled) && (activeModeChanged || modeSwitched);
      const nextEnabled = input.enabled ?? (Boolean(existing?.enabled) && !mustDisable);
      const nextDefault = input.isDefault ?? (nextEnabled ? Boolean(existing?.isDefault) : false);
      if (nextDefault && !nextEnabled) {
        throw new AppError(409, 'NOT_ENABLED', 'Only an enabled carrier can be the default');
      }
      const settings: Record<string, unknown> = { ...(input.settings ?? {}) };
      delete settings.sandbox; // the mode is the row's testMode, never a stored setting
      const nextSettings = input.settings ? settings : ((existing?.settings as object) ?? {});

      if (nextEnabled) {
        assertCarrierEnableAllowed({
          carrier,
          enabled: true,
          testMode: nextTestMode,
          credentials: cipher,
          settings: nextSettings,
          credentialHints: hints,
          connectionTest: existing?.connectionTest ?? null,
        });
      }

      const data = {
        credentials: cipher,
        credentialHints: hints as Prisma.InputJsonValue,
        testMode: nextTestMode,
        enabled: nextEnabled,
        isDefault: nextDefault,
        settings: nextSettings as Prisma.InputJsonValue,
      };
      if (nextDefault) {
        await tx.shippingCarrierConfig.updateMany({
          where: { storeId, isDefault: true, NOT: { carrier } },
          data: { isDefault: false },
        });
      }
      const row = await tx.shippingCarrierConfig.upsert({
        where: { storeId_carrier: { storeId, carrier } },
        create: { storeId, carrier, ...data },
        update: data,
      });
      return { row, changed, mustDisable };
    });
    await this.invalidateCarrierConfigCache(storeId);
    return {
      config: publicCarrierConfig(out.row),
      changed: out.changed,
      disabledUntilRetested: out.mustDisable,
    };
  }

  /**
   * The per-store secret that authenticates a carrier's webhook callbacks (it rides in the URL
   * path and, for carriers that echo a header, in that header). Kept inside the encrypted
   * credentials, generated once, replaced only on `rotate`.
   */
  async rotateWebhookSecret(storeId: string, carrier: CarrierCode, opts: { grace?: boolean } = {}) {
    await prisma.$transaction(async tx => {
      // same lock as upsertCarrierConfig: a rotation must not be reverted by a concurrent save
      await tx.$queryRaw`SELECT 1 FROM shipping_carrier_configs WHERE store_id = ${storeId} AND carrier = ${carrier} FOR UPDATE`;
      const current = await tx.shippingCarrierConfig.findUnique({
        where: { storeId_carrier: { storeId, carrier } },
        select: { credentials: true, settings: true },
      });
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Carrier is not configured');
      await tx.shippingCarrierConfig.update({
        where: { storeId_carrier: { storeId, carrier } },
        data: {
          credentials: rotateBlobWebhookSecret(current.credentials, current.settings, opts),
        },
      });
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
   * Set the default carrier for a store (unsets others first). The carrier must already be
   * enabled: this never enables one (that is the connect flow's gate).
   */
  async setDefaultCarrier(storeId: string, carrier: CarrierCode) {
    const row = await prisma.shippingCarrierConfig.findUnique({
      where: { storeId_carrier: { storeId, carrier } },
      select: { enabled: true },
    });
    if (!row?.enabled) {
      throw new AppError(409, 'NOT_ENABLED', 'Enable the carrier before making it the default');
    }
    await prisma.$transaction([
      prisma.shippingCarrierConfig.updateMany({
        where: { storeId, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.shippingCarrierConfig.updateMany({
        where: { storeId, carrier },
        data: { isDefault: true },
      }),
    ]);

    await this.invalidateCarrierConfigCache(storeId);
  }

  /**
   * Test connection: the adapter's ONE harmless authenticated call with the ACTIVE mode's stored
   * credentials. Records `{ok, code, mode, at, fingerprint}` on the row: the enable gate.
   */
  async testConnection(
    storeId: string,
    carrier: CarrierCode,
    forMode?: CredentialMode,
    /** false: report only (a non-active mode's check must not replace the active proof). */
    persist = true
  ) {
    const row = await (
      await storeDb(storeId)
    ).shippingCarrierConfig.findUnique({
      where: { storeId_carrier: { storeId, carrier } },
    });
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', 'Save the credentials before testing the connection');
    }
    const startedAt = Date.now();
    const { result, stored } = await runCarrierConnectionTest(
      row,
      this.callContext({
        storeId,
        carrier,
        settings: row.settings,
        testMode: forMode ? forMode === 'sandbox' : row.testMode,
      }),
      forMode
    );
    const latency = Date.now() - startedAt;
    if (persist) {
      await (
        await storeWriter(storeId)
      ).shippingCarrierConfig.update({
        where: { id: row.id, storeId },
        data: { connectionTest: stored as unknown as Prisma.InputJsonValue },
      });
      await this.invalidateCarrierConfigCache(storeId);
    }
    await reportConnectionCheck({
      storeId,
      provider: carrier,
      mode: stored.mode,
      code: result.code,
    });
    return {
      carrier,
      mode: stored.mode,
      test: { ok: result.ok, code: result.code, message: result.message, latency },
      check: describeConnectionCheck(result),
    };
  }

  // ==========================================
  // Shipment Lifecycle
  // ==========================================

  /**
   * What an adapter is handed next to the decrypted credentials. `settings.sandbox` is derived
   * from the row's mode, never from stored settings: it picks the carrier's sandbox host.
   */
  callContext(cfg?: {
    storeId?: string;
    carrier?: string;
    settings?: unknown;
    credentials?: Record<string, string>;
    testMode?: boolean;
  }): CarrierCallContext {
    const stored = (cfg?.settings as Record<string, unknown> | undefined) ?? {};
    const settings = { ...stored, sandbox: cfg?.testMode === true };
    const secret = cfg?.credentials?.webhookSecret;
    const impl = cfg?.carrier ? getCarrierProvider(cfg.carrier) : undefined;
    return {
      settings,
      callbackUrl:
        impl?.capabilities.webhooks && cfg?.storeId && secret
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

    const rdb = await storeDb(storeId);
    const existing = await rdb.shipment.findFirst({ where: { orderId, storeId } });
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

    // `customer` is an identity row (not in the store's Durable Object): its email is read apart, from the platform.
    const orderRow = await rdb.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        payments: { select: { provider: true, status: true, amount: true, createdAt: true } },
      },
    });
    const doCustomer =
      orderRow?.customerId != null ? await customerRow(storeId, orderRow.customerId) : undefined;
    const pgCustomer =
      doCustomer === undefined && orderRow?.customerId != null
        ? await withStore(storeId, tx =>
            tx.user.findFirst({
              where: { id: orderRow.customerId! },
              select: { email: true, firstName: true, lastName: true },
            })
          ).catch(() => null)
        : null;
    const order = orderRow ? { ...orderRow, customer: doCustomer ?? pgCustomer } : null;
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
    // At the point of use (belt and braces next to the enable gate): only a carrier in the
    // catalog books a parcel, whatever a stored row says (PROVIDERS-3: verified or not).
    if (
      resolvedCarrierCode !== 'manual' &&
      !(await isProviderUsableForStore(resolvedCarrierCode, storeId))
    ) {
      throw new AppError(
        409,
        'CARRIER_NOT_ENABLED',
        `Carrier ${resolvedCarrierCode} is not a supported carrier and cannot book shipments`
      );
    }

    const settings = (carrierConfig?.settings as Record<string, any>) ?? {};
    let pickupAddress = this.buildPickupAddress(storeId, settings);
    const shippingAddr = order.shippingAddress as Record<string, any>;
    let deliveryAddress: ShipmentAddress = {
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
    if (resolvedCarrierCode === 'aramex') {
      // Aramex needs both emails: fall back to the owner / order email, else refuse (AR + EN).
      const store = await withStore(storeId, tx =>
        tx.store.findFirst({
          where: { id: storeId },
          select: { owner: { select: { email: true } } },
        })
      );
      ({ pickupAddress, deliveryAddress } = withAramexEmails(pickupAddress, deliveryAddress, {
        ownerEmail: store?.owner?.email,
        orderEmail: typeof shippingAddr.email === 'string' ? shippingAddr.email : null,
      }));
    }
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
      const current = await rdb.shipment.findFirst({ where: { orderId, storeId } });
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
      // PROVIDERS-3: a failed real booking of a not-yet-verified carrier pages ops (never throws).
      void deferAfterTenantCommit(
        'provider-verify.create_shipment.failed',
        () =>
          recordProviderOperation({
            storeId,
            provider: resolvedCarrierCode,
            op: 'create_shipment',
            ok: false,
            errorCode: shipmentErrorCode(err),
          }),
        { runOnRollback: true }
      );
      throw err;
    }
    void deferAfterTenantCommit('provider-verify.create_shipment', () =>
      recordProviderOperation({
        storeId,
        provider: resolvedCarrierCode,
        op: 'create_shipment',
        ok: true,
        ref: response.trackingNumber ?? response.carrierShipmentId ?? null,
      })
    );

    // ---- record it (own short transaction) and move the order along
    const shipment = await runInStoreCtx(storeId, async () =>
      // ci: emits ci/shipment-booked (below, after the booking is recorded)
      (await storeWriter(storeId)).shipment.update({
        where: { id: claimedId, storeId },
        data: {
          status: 'created',
          error: response.warning ?? null,
          trackingNumber: response.trackingNumber,
          trackingUrl: response.trackingUrl,
          labelUrl: response.labelUrl,
          carrierShipmentId: response.carrierShipmentId,
          carrierTransactionId: response.carrierTransactionId,
          estimatedDeliveryAt: response.estimatedDelivery,
          // CI-1: the normalised destination only (never the street or building).
          areaKey: areaKeyFor({
            country: deliveryAddress.country,
            state: deliveryAddress.state,
            city: deliveryAddress.city,
            area: deliveryAddress.area,
          }).areaKey,
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

    // CI-1: the booking is an outcome (`shipment.created`). Never blocks or fails the booking.
    await sendEventAfterCommit(
      'ci-shipment-booked',
      { name: CI_SHIPMENT_BOOKED_EVENT, data: { storeId, orderId, shipmentId: shipment.id } },
      { ifUnhookable: 'send' }
    );

    try {
      await runInStoreCtx(storeId, () =>
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
      await runInStoreCtx(storeId, async () =>
        (await storeWriter(storeId)).shipment.update({
          where: { id: claimedId, storeId },
          data: { error: 'Booked, but the order status could not be set to shipped' },
        })
      ).catch(() => undefined);
    }

    // The customer is told by the order's shipped fan-out (email-shipped +
    // dispatch-shipped) that the status change above triggers; a second
    // dispatch from here told them twice (ruling MONEYB-5).

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
      return await runInStoreCtx(storeId, async () => {
        const w = await storeWriter(storeId);
        if (!input.existingId) {
          // ci: not-an-outcome (the booking claim; `shipment.created` is emitted once the carrier accepted it)
          const row = await w.shipment.create({
            data: { storeId, orderId: input.orderId, ...fields, createAttempts: 1 },
          });
          return row.id;
        }
        const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
        // ci: not-an-outcome (re-claiming a failed or stale booking row)
        const r = await w.shipment.updateMany({
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
      await runInStoreCtx(storeId, async () =>
        // ci: not-an-outcome (a failed booking is counted in `attemptsToBook` of the eventual shipment.created)
        (await storeWriter(storeId)).shipment.update({
          where: { id: shipmentId, storeId },
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
    const shipment = await (
      await storeDb(currentStoreId())
    ).shipment.findUnique({
      where: { id: shipmentId, storeId: currentStoreId() },
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
    // ci: not-an-outcome (a merchant-cancelled shipment is not a delivery outcome; the order cancel is emitted from order/status-changed)
    const updatedShipment = await (
      await storeWriter(currentStoreId())
    ).shipment.update({
      where: { id: shipmentId, storeId: currentStoreId() },
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
    const orderNow = await (
      await storeDb(shipment.storeId)
    ).order.findFirst({
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
    const shipment = await (
      await storeDb(currentStoreId())
    ).shipment.findUnique({
      where: { id: shipmentId, storeId: currentStoreId() },
    });
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
      await (
        await storeWriter(currentStoreId())
      ).shipment.update({
        where: { id: shipmentId, storeId: currentStoreId() },
        data: { labelUrl: label.url },
      });
    }
    return label;
  }

  /** The shipment of an order plus what the order page needs to offer actions. */
  async getShipmentForOrder(storeId: string, orderId: string) {
    const [shipment, configs, order] = await Promise.all([
      storeDb(storeId).then(db => db.shipment.findFirst({ where: { orderId, storeId } })),
      this.getCarrierConfigs(storeId),
      storeDb(storeId).then(db =>
        db.order.findFirst({
          where: { id: orderId, storeId },
          select: {
            status: true,
            payments: { select: { provider: true, status: true, amount: true, createdAt: true } },
          },
        })
      ),
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

  /**
   * The order side of a return to origin. `restock` is the merchant's choice
   * (manual carrier: the checkbox next to "Returned"); a carrier-reported
   * return puts the goods back in stock.
   */
  async handleReturnToOrigin(storeId: string, orderId: string, restock?: boolean) {
    const order = await (
      await storeDb(storeId)
    ).order.findFirst({
      where: { id: orderId, storeId },
      select: { status: true, payments: { select: { id: true, status: true, provider: true } } },
    });
    if (!order) return;
    if (order.status === 'cancelled' || order.status === 'refunded') return;
    if (order.status === 'delivered') {
      // Delivered then returned is a customer return, not a return to origin:
      // the returns flow owns it (refund, restock per line).
      logger.warn({ storeId, orderId }, '[RTO] shipment returned after delivery — left to returns');
      return;
    }
    // The merchant's choice on the manual flow; a carrier-reported return puts
    // the goods back (they physically came back to the merchant).
    const restoreInventory = restock ?? true;
    // Cash on delivery that was never collected is not owed any more.
    for (const p of order.payments) {
      if (p.provider === 'cod' && p.status === 'cod_pending') {
        // a store on its Durable Object has no loose payment write: the order's cancel below closes its payments
        if (!(await storeMoney(storeId)))
          await prisma.payment.update({ where: { id: p.id }, data: { status: 'cancelled' } });
      }
    }
    await setOrderStatusGuarded(prisma, storeId, orderId, 'cancelled', { restoreInventory });
  }

  /** Manual carrier: the merchant moves the shipment along (picked up, delivered, ...). */
  async manualUpdateStatus(
    shipmentId: string,
    status: ShipmentStatus,
    opts: { restock?: boolean } = {}
  ) {
    const shipment = await (
      await storeDb(currentStoreId())
    ).shipment.findUnique({
      where: { id: shipmentId, storeId: currentStoreId() },
    });
    if (!shipment) throw new AppError(404, 'NOT_FOUND', 'Shipment not found');
    if (shipment.carrier !== 'manual') {
      throw new AppError(400, 'NOT_MANUAL', 'Only manual shipments are updated by hand');
    }
    return this.applyTrackingEntries(
      shipment.id,
      [{ status, timestamp: new Date(), description: 'Updated by the merchant' }],
      'merchant_manual',
      { restock: opts.restock }
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
    extra: { estimatedDelivery?: Date; restock?: boolean } = {}
  ) {
    const shipment = await (
      await storeDb(currentStoreId())
    ).shipment.findUnique({
      where: { id: shipmentId, storeId: currentStoreId() },
    });
    if (!shipment) throw new AppError(404, 'NOT_FOUND', `Shipment ${shipmentId} not found`);

    const history = Array.isArray(shipment.statusHistory) ? (shipment.statusHistory as any[]) : [];
    const merged = mergeTracking({ history, currentStatus: shipment.status, events: entries });

    if (merged.added === 0) {
      const touched =
        source === 'carrier_poll'
          ? await (
              await storeWriter(currentStoreId())
            ).shipment.update({
              where: { id: shipmentId, storeId: currentStoreId() },
              data: { lastPolledAt: new Date() },
            })
          : shipment;
      return { shipment: touched, applied: false };
    }
    const nextStatus = merged.status;

    const prevStatus = shipment.status;
    // Customer Intelligence (CI-1): first-time pick-up / attempt / delivery / return facts, stamped in
    // the SAME update as the status so the columns and the events they guard cannot disagree.
    const ci = shipmentStamps(merged.history, shipment, source);
    // ci: emits ci/shipment-tracked (first-time pick-up / attempt / delivery / return, via shipmentStamps)
    const updated = await (
      await storeWriter(currentStoreId())
    ).shipment.update({
      where: { id: shipmentId, storeId: currentStoreId() },
      data: {
        status: nextStatus,
        statusHistory: merged.history as unknown as Prisma.InputJsonValue,
        ...ci.data,
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

    // Ebda Chat (contract 2026-10-24 section 4): every carrier status change is a
    // `shipment.updated`; the job drops it unless the store linked WhatsApp. Enqueue failures are
    // logged, never block tracking (the next poll re-sends a changed status).
    if (prevStatus !== nextStatus) {
      await sendEventAfterCommit(
        'shipment-status-updated',
        {
          name: 'shipment/status-updated',
          data: {
            storeId: shipment.storeId,
            orderId: shipment.orderId,
            shipmentId,
            status: nextStatus,
            trackingUrl: updated.trackingUrl ?? null,
            updatedAt: new Date().toISOString(),
          },
        },
        { ifUnhookable: 'send' }
      );
    }

    // CI-1: one event per call that brought a NEW first-time fact (not per status change: two failed
    // attempts keep the status `failed`). Enqueue failures are logged, never block tracking.
    if (ci.marks.length > 0) {
      await sendEventAfterCommit(
        'ci-shipment-tracked',
        {
          name: CI_SHIPMENT_TRACKED_EVENT,
          data: {
            storeId: shipment.storeId,
            orderId: shipment.orderId,
            shipmentId,
            ci: ci.marks,
          },
        },
        { ifUnhookable: 'send' }
      );
    }

    if (nextStatus === 'delivered' && prevStatus !== 'delivered') {
      // The order's delivered fan-out sends the customer notification
      // (dispatch-delivered); sending it here too told them twice.
      await setOrderStatusGuarded(prisma, shipment.storeId, shipment.orderId, 'delivered');
    }

    // Return to origin (refused COD, failed delivery): the parcel is back with
    // the merchant. The order leaves "shipped" — cancelled, COD no longer owed
    // (nothing was collected), stock put back unless the merchant said not to
    // (ruling MONEYB-5). A prepaid order is cancelled the same way and its
    // refund is then owed (the cancel fan-out issues the credit note and tells
    // the customer their refund is being processed).
    if (nextStatus === 'returned' && prevStatus !== 'returned') {
      await this.handleReturnToOrigin(shipment.storeId, shipment.orderId, extra.restock);
    }

    return { shipment: updated, applied: true };
  }

  /**
   * Poll the carrier for the latest tracking and fold it in. Runs from the cron (one store scope
   * per shipment) and from the admin "refresh" button.
   */
  async updateShipmentStatus(shipmentId: string) {
    const shipment = await (
      await storeDb(currentStoreId())
    ).shipment.findUnique({
      where: { id: shipmentId, storeId: currentStoreId() },
    });
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
   * A webhook for a carrier that signs nothing (Bosta): the callback URL carries the store id
   * and that store's secret token, and the carrier echoes a header we chose. The token is compared (constant time) against the secret in
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
    if (!impl || !impl.capabilities.webhooks) return 'unauthorized';
    if (!/^[0-9a-f-]{36}$/i.test(storeId)) return 'unauthorized';

    // NEON-ZERO (Ruling NZ-C-9): the directory (D1) decides whether the store exists, with no Postgres. An unknown store is the
    // same `unauthorized` as a wrong token (no oracle); an unreadable directory is a 503 (the route answers 500, Bosta retries).
    try {
      await storeRepo(storeId);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) return 'unauthorized';
      throw err;
    }
    return withStore(storeId, async () => {
      // From the store's own backend, not the 300 s cache: a rotated secret must stop working at once.
      const row = await (
        await storeDb(storeId)
      ).shippingCarrierConfig.findUnique({
        where: { storeId_carrier: { storeId, carrier } },
        select: { credentials: true, settings: true },
      });
      const { current, previous } = this.readWebhookSecrets(row);
      let secret = '';
      let createdBefore: Date | undefined;
      if (verifyWebhookToken(current, token)) {
        secret = current;
      } else if (previous && verifyWebhookToken(previous.secret, token)) {
        // Graceful rotation (SEC-8): callbacks registered before it keep working while a shipment
        // created before the rotation is still undelivered, for at most 30 days.
        const inFlight = await (
          await storeDb(storeId)
        ).shipment.findFirst({
          where: {
            storeId,
            carrier,
            createdAt: { lt: new Date(previous.rotatedAt) },
            status: { notIn: [...TERMINAL_SHIPMENT_STATUSES, CREATION_FAILED, 'creating'] },
          },
          select: { id: true },
        });
        if (previousSecretGraceOpen(previous, Date.now(), !!inFlight)) {
          secret = previous.secret;
          // The old URL may only touch what was registered before the rotation and is not done.
          createdBefore = new Date(previous.rotatedAt);
        }
      }
      if (!secret) return 'unauthorized' as const;
      // Carriers that echo a header we set (Bosta) must present it too: a leaked URL alone is
      // not enough. Missing, wrong or empty are the same `unauthorized` (no oracle).
      if (impl.webhookHeader) {
        const presented = headers[impl.webhookHeader.name.toLowerCase()] ?? '';
        if (!presented || !safeEqual(presented, impl.webhookHeader.valueFor(secret))) {
          return 'unauthorized' as const;
        }
      }

      const result = impl.processWebhook(body, headers);
      if (!result) return 'ignored' as const;
      return this.applyWebhookResult(carrier, result, createdBefore);
    });
  }

  private async applyWebhookResult(
    carrier: string,
    result: CarrierWebhookResult,
    /** Set when the PREVIOUS secret authenticated: only older, still-open shipments may change. */
    createdBefore?: Date
  ): Promise<'unknown_shipment' | 'duplicate' | 'applied'> {
    const shipment = await (
      await storeDb(currentStoreId())
    ).shipment.findFirst({
      where: {
        storeId: currentStoreId(),
        trackingNumber: result.trackingNumber,
        carrier,
        ...(createdBefore
          ? {
              createdAt: { lt: createdBefore },
              status: { notIn: [...TERMINAL_SHIPMENT_STATUSES, CREATION_FAILED, 'creating'] },
            }
          : {}),
      },
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

    // A store on its Durable Object (Ruling CF-JOBS-4): `customer` is an identity row, not in the DO, so it is read apart.
    const onDo = Boolean(await storeMoney(storeId));
    const db = await storeDb(storeId);
    const [rows, total] = await Promise.all([
      db.shipment.findMany({
        where,
        skip,
        take: limit,
        include: {
          order: {
            select: {
              orderNumber: true,
              status: true,
              total: true,
              ...(onDo
                ? { customerId: true }
                : { customer: { select: { email: true, firstName: true, lastName: true } } }),
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.shipment.count({ where }),
    ]);
    let shipments: typeof rows = rows;
    if (onDo) {
      const ids = [
        ...new Set(rows.map(r => (r.order as any)?.customerId).filter(Boolean)),
      ] as string[];
      const users =
        (await customerRows(storeId, ids)) ??
        (ids.length
          ? await withStore(storeId, tx =>
              tx.user.findMany({
                where: { id: { in: ids } },
                select: { id: true, email: true, firstName: true, lastName: true },
              })
            )
          : []);
      const byId = new Map(users.map(u => [u.id, u]));
      shipments = rows.map(r => ({
        ...r,
        order: r.order && {
          ...r.order,
          customer: byId.get((r.order as any).customerId) ?? null,
        },
      })) as typeof rows;
    }

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
    // With the platform D1 bound the store list is D1's (the Postgres directory definer needs a connection).
    const storeIds = platformDb() ? (await listDirectoryStores()).map(s => s.id) : undefined;
    const active = await sweepAcrossStores({
      storeIds,
      fetch: async storeId =>
        (await storeDb(storeId)).shipment.findMany({
          where: {
            storeId,
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

  buildPickupAddress(storeId: string, settings: Record<string, any>): ShipmentAddress {
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

  /**
   * The active mode's flat credentials of a stored row. An unreadable blob (a rotated
   * ENCRYPTION_KEY) is logged and read as empty HERE (a carrier call then fails as
   * misconfigured); saving never goes through this path (it re-reads and throws), so an
   * unreadable secret is never overwritten by a truncated one.
   */
  private readActiveCredentials(row: {
    carrier: string;
    testMode: boolean;
    credentials?: string | null;
    settings?: unknown;
  }): Record<string, string> {
    // Outside the try ON PURPOSE. A non-string here means the caller handed us an ALREADY-DECRYPTED
    // object (a surviving pre-v3 cache entry). Letting that fall into the catch returns {}, which
    // every caller reads as "this merchant has no credentials": carrier auth fails on live
    // orders. A wrong shape is a bug, not a missing credential, so it fails loudly.
    if (row.credentials && typeof row.credentials !== 'string') {
      throw new Error(
        '[ShippingCarrierService] credentials are not an encrypted string: refusing to read them as empty'
      );
    }
    try {
      return activeCredentials(row);
    } catch (err) {
      logger.error(
        { err, carrier: row.carrier },
        '[ShippingCarrierService] Failed to decrypt credentials'
      );
      return {};
    }
  }

  private readWebhookSecrets(
    row: { credentials?: string | null; settings?: unknown } | null | undefined
  ): { current: string; previous?: { secret: string; rotatedAt: string } } {
    if (!row?.credentials) return { current: '' };
    try {
      const blob = decryptCarrierBlob(row.credentials, row.settings);
      return { current: blob.webhookSecret ?? '', previous: blob.previousWebhook };
    } catch {
      return { current: '' };
    }
  }

  async invalidateCarrierConfigCache(storeId: string) {
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
  to: OrderStatus,
  opts: { restoreInventory?: boolean } = {}
): Promise<void> {
  // the order lives in the store's backend (a Durable Object for a DO store); `client` stays for the Postgres callers' signature
  const current = await (
    await storeDb(storeId)
  ).order.findFirst({
    where: { id: orderId, storeId },
    select: { status: true },
  });
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Order not found for this store');
  if (current.status === to) return;
  assertValidTransition(current.status, to);
  // The SAME transition every manual status change makes (ruling MONEYB-5):
  // deliveredAt + the order/delivered review request, the shipped email and
  // dispatch, loyalty earn and affiliate commission on delivery, the refund /
  // cancel reversals, the status audit row and the fan-out's stuck-sweep
  // bookkeeping. A bare `order.update` here skipped every one of them.
  // Lazy: order.service pulls in the whole order graph (and imports this
  // module's consumers back); loading it at call time keeps the carrier
  // module light and cycle-free.
  const { OrderService } = await import('./order.service.js');
  await OrderService.updateStatus(
    storeId,
    orderId,
    to as Parameters<typeof OrderService.updateStatus>[2],
    opts
  );
}

export const shippingCarrierService = new ShippingCarrierService();
