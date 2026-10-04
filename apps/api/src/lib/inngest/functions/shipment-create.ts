import { NonRetriableError, type InngestFunction } from 'inngest';
import { prisma, runInTenantContext } from '@force/database';
import logger from '../../logger';
import { inngest } from '../client';
import { featureService } from '../../../services/feature.service';
import { shippingCarrierService } from '../../../services/shipping-carrier.service';
import { CarrierError, type CarrierCode } from '../../../services/carriers/types';
import { AppError } from '../../../middleware/error-handler';
import { OneSignalService } from '../../../services/onesignal.service';

/**
 * Book a shipment with the carrier, OFF the order path (SP7 outage isolation).
 *
 * Confirming an order sends `shipment/create.requested` instead of calling the carrier inline,
 * so a carrier that is down, slow or misconfigured can never fail, delay or roll back the
 * order: the order is already placed and confirmed, and this job owns the booking.
 *
 *  - An outage (timeout, 5xx, unreachable) is retried with Inngest's backoff, 6 attempts.
 *    `createShipmentForOrder` is safe to repeat: it claims the row, and the carrier dedupes on
 *    our reference, so a retry after a lost response books no second parcel.
 *  - A refusal retrying cannot fix (bad address, bad credentials, COD not supported) is not
 *    retried: the merchant is told at once and the shipment row says why.
 *  - An order that must not ship yet (InstaPay awaiting confirmation, an order the state
 *    machine will not ship) is skipped quietly: that is not a failure.
 *  - When the retries run out the merchant is pushed; the order page shows the failed booking
 *    with a Retry button (the row is `creation_failed`).
 */
type Data = { storeId: string; orderId: string; carrier?: string };

async function notifyMerchant(data: Data, reason: string) {
  const { storeId, orderId } = data;
  try {
    const info = await runInTenantContext(storeId, async () => {
      const [order, store, shipment] = await Promise.all([
        prisma.order.findFirst({ where: { id: orderId, storeId }, select: { orderNumber: true } }),
        prisma.store.findUnique({ where: { id: storeId }, select: { name: true } }),
        prisma.shipment.findFirst({ where: { orderId, storeId }, select: { carrier: true } }),
      ]);
      return {
        orderNumber: order?.orderNumber ?? orderId,
        storeName: store?.name ?? storeId,
        carrier: shipment?.carrier,
      };
    });
    await OneSignalService.notifyAdminsOfShipmentFailure({
      storeId,
      storeName: info.storeName,
      orderId,
      orderNumber: info.orderNumber,
      carrier: info.carrier ?? data.carrier ?? 'carrier',
      reason: reason.slice(0, 120),
    });
  } catch (err) {
    logger.error({ err, storeId, orderId }, 'shipment-create: could not notify the merchant');
  }
}

/**
 * One booking attempt. Returns what happened for a no-op; throws for an outage (Inngest
 * retries) and `NonRetriableError` for a refusal retrying cannot fix (the merchant is told).
 */
export async function bookShipment(data: Data) {
  // store_features + shipments + shipping_carrier_configs are FORCE RLS: scope the work.
  return runInTenantContext(data.storeId, async () => {
    const enabled = await featureService.isFeatureEnabled(data.storeId, 'shipping_carriers');
    if (!enabled) return { skipped: 'feature_off' as const };
    try {
      const shipment = await shippingCarrierService.createShipmentForOrder(
        data.storeId,
        data.orderId,
        data.carrier as CarrierCode | undefined
      );
      return { shipmentId: shipment.id, status: shipment.status };
    } catch (err) {
      if (err instanceof AppError && err.statusCode < 500) {
        // not ready to ship (InstaPay awaiting, order status) or nothing to book with:
        // not an outage and not worth a retry
        return { skipped: err.code };
      }
      if (err instanceof CarrierError && !err.retryable) {
        await notifyMerchant(data, err.message);
        throw new NonRetriableError(err.message);
      }
      throw err; // an outage: Inngest retries
    }
  });
}

/** The retries ran out: tell the merchant (the row is `creation_failed`, the order is intact). */
export async function handleShipmentCreateFailure(data: Data, error: Error) {
  if (!data.storeId || !data.orderId) return;
  logger.error({ ...data, err: error }, 'shipment-create: retries exhausted');
  await notifyMerchant(data, error?.message ?? 'carrier unavailable');
}

export const shipmentCreate: InngestFunction.Any = inngest.createFunction(
  {
    id: 'shipment-create',
    name: 'Book a shipment with the carrier (retried, outage-isolated)',
    retries: 6,
    // one booking per order at a time
    concurrency: { limit: 1, key: 'event.data.orderId' },
    triggers: [{ event: 'shipment/create.requested' }],
    onFailure: async ({ event, error }: { event: any; error: Error }) => {
      const data = (event?.data?.event?.data ?? {}) as Data;
      await handleShipmentCreateFailure(data, error);
    },
  },
  async ({ event, step }) => {
    const data = event.data as Data;
    return step.run('book', () => bookShipment(data));
  }
);
