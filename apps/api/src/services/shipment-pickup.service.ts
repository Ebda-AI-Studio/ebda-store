/**
 * Courier pickups (Ruling PROVIDERS-18): the merchant asks Bosta, Aramex or Mylerz to collect a
 * booked parcel from the store's pickup location, on a date (and window) they choose.
 *
 *  - The carrier decides what a request carries (`capabilities.pickup / pickupWindow /
 *    pickupCancel`): Bosta takes a date and assigns the slot, Aramex takes a from/to window,
 *    Mylerz one of its own slots; ShipBlu requests its pickup at booking (`automatic`) and the
 *    manual carrier has none. The UI offers only what is declared; the service refuses the rest.
 *  - IDEMPOTENT twice over: the browser sends one `idempotencyKey` per dialog (UNIQUE per store,
 *    so a double submit is one row and ONE carrier call), and at most one ACTIVE pickup exists
 *    per shipment (partial UNIQUE index `shipment_pickups_one_active`), so a second request for
 *    the same parcel returns the live one instead of booking a second courier.
 *  - The row is CLAIMED (`requesting`, committed on its own) before the carrier is called, and
 *    the carrier call holds no transaction. A carrier that does not answer leaves the row
 *    `failed` with an explicit "may have been booked" note: carriers document no pickup
 *    idempotency, so a blind retry could book a second courier (accepted residual, the merchant
 *    checks the carrier's dashboard first).
 *  - Every request and cancel is audit-logged.
 */
import { prisma, runInTenantContext } from '@ebda/database';
import { storeDb } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { uniqueViolationTarget } from '../lib/prisma-errors';
import { CARRIER_REGISTRY } from './carriers/registry';
import {
  CarrierError,
  type CarrierCode,
  type CarrierPickupWindow,
  type ShippingCarrierProvider,
} from './carriers/types';
import { cairoToday, isPickupDate, isPickupTime } from './carriers/pickup-time';
import { isProviderUsableForStore } from './payment-providers/provider-gate';
import { shippingCarrierService } from './shipping-carrier.service';

/** How far ahead a pickup may be asked for (carriers publish no limit; Bosta lists ~a week). */
export const PICKUP_MAX_DAYS_AHEAD = 14;
/** A `requesting` row older than this belonged to a process that died mid-call. */
export const PICKUP_CLAIM_STALE_MS = 2 * 60_000;
/** Shipment states a courier can still come and collect. */
const PICKABLE_SHIPMENT_STATUSES = new Set(['created']);

export interface RequestPickupInput {
  date: string;
  window?: { from: string; to: string };
  windowId?: string;
  windowLabel?: string;
  idempotencyKey: string;
}

type PickupRow = Awaited<ReturnType<typeof prisma.shipmentPickup.findFirst>>;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadShipment(storeId: string, shipmentId: string) {
  const shipment = await (
    await storeDb(storeId)
  ).shipment.findFirst({ where: { id: shipmentId, storeId } });
  if (!shipment) throw new AppError(404, 'NOT_FOUND', 'Shipment not found');
  const impl = CARRIER_REGISTRY[shipment.carrier as CarrierCode] as
    | ShippingCarrierProvider
    | undefined;
  if (!impl) throw new AppError(400, 'INVALID_CARRIER', `Unknown carrier: ${shipment.carrier}`);
  return { shipment, impl };
}

/** The carrier's stored config, enabled and usable, as the adapter needs it. */
async function usableConfig(storeId: string, carrier: CarrierCode) {
  const cfg = await shippingCarrierService.getCarrierConfig(storeId, carrier);
  if (!cfg || !cfg.enabled || !(await isProviderUsableForStore(carrier, storeId))) {
    throw new AppError(
      409,
      'CARRIER_NOT_ENABLED',
      `Carrier ${carrier} is not enabled for this store, so it cannot be asked for a pickup`
    );
  }
  return cfg;
}

/** What the order page's pickup panel shows for a shipment. */
export async function getPickupState(storeId: string, shipmentId: string) {
  const { shipment, impl } = await loadShipment(storeId, shipmentId);
  const pickups = await prisma.shipmentPickup.findMany({
    where: { storeId, shipmentId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const active = pickups.find(p => p.status === 'requesting' || p.status === 'requested') ?? null;
  return {
    carrier: shipment.carrier,
    mode: impl.capabilities.pickup,
    window: impl.capabilities.pickupWindow,
    cancellable: impl.capabilities.pickupCancel,
    canRequest:
      impl.capabilities.pickup === 'request' &&
      PICKABLE_SHIPMENT_STATUSES.has(shipment.status) &&
      !!shipment.trackingNumber &&
      !active,
    shipmentStatus: shipment.status,
    // ShipBlu: booking asked for the pickup; a refusal was stored on the shipment.
    automaticWarning: impl.capabilities.pickup === 'automatic' ? shipment.error : null,
    minDate: cairoToday(),
    maxDate: addDays(cairoToday(), PICKUP_MAX_DAYS_AHEAD),
    active,
    pickups,
  };
}

/** The carrier's own pickup slots (Mylerz). */
export async function listPickupWindows(
  storeId: string,
  shipmentId: string
): Promise<CarrierPickupWindow[]> {
  const { shipment, impl } = await loadShipment(storeId, shipmentId);
  if (impl.capabilities.pickupWindow !== 'carrier_slots' || !impl.pickupWindows) return [];
  const cfg = await usableConfig(storeId, shipment.carrier as CarrierCode);
  return impl.pickupWindows(
    cfg.credentials,
    shippingCarrierService.callContext({ ...cfg, storeId })
  );
}

function validateRequest(
  impl: ShippingCarrierProvider,
  input: RequestPickupInput
): { window?: { from: string; to: string }; windowId?: string } {
  const today = cairoToday();
  if (!isPickupDate(input.date)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Pickup date must be YYYY-MM-DD');
  }
  if (input.date < today || input.date > addDays(today, PICKUP_MAX_DAYS_AHEAD)) {
    throw new AppError(
      400,
      'PICKUP_DATE_OUT_OF_RANGE',
      `Pickup date must be between today and ${PICKUP_MAX_DAYS_AHEAD} days ahead (Cairo time)`
    );
  }
  switch (impl.capabilities.pickupWindow) {
    case 'times': {
      const w = input.window;
      if (!w || !isPickupTime(w.from) || !isPickupTime(w.to) || w.from >= w.to) {
        throw new AppError(
          400,
          'PICKUP_WINDOW_REQUIRED',
          'Choose a pickup window: a start time before an end time (HH:MM)'
        );
      }
      return { window: w };
    }
    case 'carrier_slots':
      // No slot = the account's default slot at the carrier.
      return input.windowId ? { windowId: input.windowId } : {};
    default:
      // The carrier assigns the slot: a window would be silently ignored, so it is not stored.
      return {};
  }
}

/** A `requesting` row from a process that died mid-call: its outcome is unknown. */
async function expireStaleClaim(storeId: string, row: NonNullable<PickupRow>): Promise<boolean> {
  if (row.status !== 'requesting') return false;
  if (Date.now() - row.updatedAt.getTime() < PICKUP_CLAIM_STALE_MS) return false;
  const r = await runInTenantContext(storeId, () =>
    prisma.shipmentPickup.updateMany({
      where: { id: row.id, storeId, status: 'requesting' },
      data: {
        status: 'failed',
        error:
          'The carrier did not answer in time. The pickup may have been booked: check the carrier dashboard before asking again.',
      },
    })
  );
  return r.count === 1;
}

/**
 * Ask the shipment's carrier for a pickup. Returns `{ pickup, created }`; `created: false` is a
 * replay (same idempotency key) or the shipment's already-live pickup: no carrier call was made.
 */
export async function requestPickup(
  storeId: string,
  shipmentId: string,
  input: RequestPickupInput,
  actor: { userId?: string; ip?: string; userAgent?: string } = {}
) {
  // 1) A replay of the same request is answered from the row, before anything else is checked.
  const replay = await prisma.shipmentPickup.findFirst({
    where: { storeId, idempotencyKey: input.idempotencyKey },
  });
  if (replay) {
    if (replay.shipmentId !== shipmentId) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This request key belongs to another pickup'
      );
    }
    return { pickup: replay, created: false };
  }

  const { shipment, impl } = await loadShipment(storeId, shipmentId);
  if (impl.capabilities.pickup === 'automatic') {
    throw new AppError(
      409,
      'PICKUP_AUTOMATIC',
      `${impl.name} requests the pickup itself when the shipment is booked`
    );
  }
  if (impl.capabilities.pickup !== 'request' || !impl.schedulePickup) {
    throw new AppError(409, 'PICKUP_NOT_SUPPORTED', `${impl.name} has no pickup request`);
  }
  if (!PICKABLE_SHIPMENT_STATUSES.has(shipment.status) || !shipment.trackingNumber) {
    throw new AppError(
      409,
      'PICKUP_NOT_ALLOWED',
      'A pickup can be requested only for a booked shipment the courier has not collected yet'
    );
  }
  const chosen = validateRequest(impl, input);

  // 2) One live pickup per shipment: return it instead of booking a second courier.
  const live = await prisma.shipmentPickup.findFirst({
    where: { storeId, shipmentId, status: { in: ['requesting', 'requested'] } },
  });
  if (live && !(await expireStaleClaim(storeId, live))) {
    return { pickup: live, created: false };
  }

  const cfg = await usableConfig(storeId, shipment.carrier as CarrierCode);
  const settings = (cfg.settings as Record<string, unknown>) ?? {};
  const address = shippingCarrierService.buildPickupAddress(storeId, settings);

  // 3) Claim the row (own transaction) BEFORE the carrier is called.
  let claimed: NonNullable<PickupRow>;
  try {
    claimed = await runInTenantContext(storeId, () =>
      prisma.shipmentPickup.create({
        data: {
          storeId,
          shipmentId,
          carrier: shipment.carrier,
          status: 'requesting',
          pickupDate: input.date,
          windowFrom: chosen.window?.from ?? null,
          windowTo: chosen.window?.to ?? null,
          windowId: chosen.windowId ?? null,
          windowLabel: chosen.windowId ? (input.windowLabel?.slice(0, 100) ?? null) : null,
          address: address as object,
          idempotencyKey: input.idempotencyKey,
          requestedById: actor.userId ?? null,
        },
      })
    );
  } catch (err) {
    // Lost a race to the same key or to another live pickup: answer with the winner.
    if (uniqueViolationTarget(err).length > 0 || (err as { code?: string })?.code === 'P2002') {
      const winner =
        (await prisma.shipmentPickup.findFirst({
          where: { storeId, idempotencyKey: input.idempotencyKey },
        })) ??
        (await prisma.shipmentPickup.findFirst({
          where: { storeId, shipmentId, status: { in: ['requesting', 'requested'] } },
        }));
      if (winner) return { pickup: winner, created: false };
    }
    throw err;
  }

  // 4) The carrier call, outside every transaction.
  try {
    const out = await impl.schedulePickup(
      cfg.credentials,
      {
        date: input.date,
        window: chosen.window,
        windowId: chosen.windowId,
        address,
        trackingNumbers: [shipment.trackingNumber],
        reference: claimed.id,
        weightKg: typeof settings.defaultWeight === 'number' ? settings.defaultWeight : undefined,
      },
      shippingCarrierService.callContext({ ...cfg, storeId })
    );
    const pickup = await runInTenantContext(storeId, () =>
      prisma.shipmentPickup.update({
        where: { id: claimed.id, storeId },
        data: {
          status: 'requested',
          error: null,
          carrierPickupId: out.carrierPickupId,
          carrierReference: out.carrierReference ?? null,
          carrierTimeSlot: out.timeSlot ?? null,
        },
      })
    );
    await auditLog({
      action: 'SHIPMENT_PICKUP_REQUESTED',
      userId: actor.userId,
      storeId,
      resourceType: 'shipment',
      resourceId: shipmentId,
      details: {
        pickupId: pickup.id,
        carrier: shipment.carrier,
        date: input.date,
        window: chosen.window ?? null,
        windowId: chosen.windowId ?? null,
        carrierPickupId: out.carrierPickupId,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { pickup, created: true };
  } catch (err) {
    const unknownOutcome = err instanceof CarrierError ? err.retryable : true;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    await runInTenantContext(storeId, () =>
      prisma.shipmentPickup.update({
        where: { id: claimed.id, storeId },
        data: {
          status: 'failed',
          error: unknownOutcome
            ? `The carrier did not answer (${message}). The pickup may have been booked: check the carrier dashboard before asking again.`
            : message,
        },
      })
    ).catch(e =>
      logger.error({ err: e, pickupId: claimed.id }, '[pickup] could not record a failed request')
    );
    await auditLog({
      action: 'SHIPMENT_PICKUP_FAILED',
      userId: actor.userId,
      storeId,
      resourceType: 'shipment',
      resourceId: shipmentId,
      details: { pickupId: claimed.id, carrier: shipment.carrier, error: message, unknownOutcome },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    throw err;
  }
}

/** Cancel a requested pickup at the carrier, where the carrier allows it. */
export async function cancelPickup(
  storeId: string,
  shipmentId: string,
  pickupId: string,
  actor: { userId?: string; ip?: string; userAgent?: string } = {}
) {
  const { impl } = await loadShipment(storeId, shipmentId);
  const row = await prisma.shipmentPickup.findFirst({
    where: { id: pickupId, storeId, shipmentId },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Pickup not found');
  if (row.status === 'cancelled') return row; // idempotent
  if (row.status !== 'requested' || !row.carrierPickupId) {
    throw new AppError(409, 'PICKUP_NOT_CANCELLABLE', 'Only a requested pickup can be cancelled');
  }
  if (!impl.capabilities.pickupCancel || !impl.cancelPickup) {
    throw new AppError(
      409,
      'PICKUP_CANCEL_UNSUPPORTED',
      `${impl.name} has no pickup cancellation in its API: cancel it in the ${impl.name} dashboard`
    );
  }
  const cfg = await usableConfig(storeId, row.carrier as CarrierCode);
  const result = await impl.cancelPickup(
    cfg.credentials,
    { carrierPickupId: row.carrierPickupId, carrierReference: row.carrierReference },
    shippingCarrierService.callContext({ ...cfg, storeId })
  );
  if (result.status !== 'cancelled') {
    throw new AppError(
      409,
      'PICKUP_NOT_CANCELLABLE',
      result.message ?? `${impl.name} did not cancel the pickup`
    );
  }
  const updated = await runInTenantContext(storeId, () =>
    prisma.shipmentPickup.update({
      where: { id: row.id, storeId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    })
  );
  await auditLog({
    action: 'SHIPMENT_PICKUP_CANCELLED',
    userId: actor.userId,
    storeId,
    resourceType: 'shipment',
    resourceId: shipmentId,
    details: { pickupId: row.id, carrier: row.carrier, carrierPickupId: row.carrierPickupId },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return updated;
}
