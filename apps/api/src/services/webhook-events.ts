/**
 * Maps the platform's internal Inngest events onto merchant-facing webhook events.
 * Runs in the ambient tenant. A source event with nothing to say (an order status the merchant
 * cannot subscribe to, a vanished row) maps to [].
 */
import { WEBHOOK_ORDER_STATUSES } from '@ebda/shared';
import { loadOrderParts, loadProductData, type FanoutEvent } from './webhook-payload';

export type SourceEventName =
  | 'order/created'
  | 'order/status-changed'
  | 'order/refunded'
  | 'product.upserted'
  | 'product.deleted'
  | 'webhook/inventory.low';

export async function buildFanoutEvents(
  storeId: string,
  name: SourceEventName,
  data: Record<string, any>,
  sourceEventId: string
): Promise<FanoutEvent[]> {
  switch (name) {
    case 'order/created': {
      const o = await loadOrderParts(storeId, String(data.orderId));
      if (!o) return [];
      const out: FanoutEvent[] = [
        {
          type: 'order.created',
          dedupeKey: `order.created:${o.row.id}`,
          data: o.data,
          customer: o.customer,
        },
      ];
      // Paid at the moment the order is announced (online payment, wallet). COD is paid later and is
      // visible through order.status_changed (Ruling WH-4).
      if (o.row.paymentStatus === 'paid') {
        out.push({
          type: 'order.paid',
          dedupeKey: `order.paid:${o.row.id}`,
          data: o.data,
          customer: o.customer,
        });
      }
      return out;
    }
    case 'order/status-changed': {
      const status = String(data.status);
      if (!(WEBHOOK_ORDER_STATUSES as readonly string[]).includes(status)) return [];
      const o = await loadOrderParts(storeId, String(data.orderId));
      if (!o) return [];
      return [
        {
          type: 'order.status_changed',
          dedupeKey: `order.status_changed:${o.row.id}:${status}`,
          data: { ...o.data, status },
          customer: o.customer,
        },
      ];
    }
    case 'order/refunded': {
      const o = await loadOrderParts(storeId, String(data.orderId));
      if (!o) return [];
      return [
        {
          type: 'order.refunded',
          dedupeKey: `order.refunded:${o.row.id}:${sourceEventId}`,
          data: { ...o.data, refund: { partial: data.partial === true } },
          customer: o.customer,
        },
      ];
    }
    case 'product.upserted': {
      const p = await loadProductData(storeId, String(data.productId));
      if (!p) return [];
      const type = data.op === 'create' ? 'product.created' : 'product.updated';
      return [
        {
          type,
          dedupeKey: `${type}:${data.productId}:${sourceEventId}`,
          data: {
            ...p,
            changedFields: Array.isArray(data.changedFields) ? data.changedFields : [],
          },
        },
      ];
    }
    case 'product.deleted':
      return [
        {
          type: 'product.deleted',
          dedupeKey: `product.deleted:${data.productId}:${sourceEventId}`,
          data: { product: { id: String(data.productId) } },
        },
      ];
    case 'webhook/inventory.low': {
      const items = Array.isArray(data.items) ? data.items : [];
      return items.map((i: any) => ({
        type: 'inventory.low',
        // At most one per product per UTC day, however often the scan re-lists it.
        dedupeKey: `inventory.low:${i.productId}:${String(data.day)}`,
        data: {
          product: {
            id: i.productId,
            name: i.name,
            inventory: i.inventory,
            lowStockThreshold: i.lowStockThreshold,
          },
        },
      }));
    }
  }
}
